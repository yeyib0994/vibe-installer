"""阶段执行器。

在后台线程里逐步骤执行某个阶段的 steps，把日志推给订阅者（Web 端用 SSE 消费）。
与上一版的关键区别：执行的对象是「阶段」而不是「整个计划」，
执行完一个阶段才解锁下一个，符合引导式向导的节奏。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..core import store
from ..models.schemas import (
    BackupKind,
    BackupPoint,
    BackupStatus,
    DistributionJob,
    EnvironmentSpec,
    FlowStage,
    FlowStatus,
    InstallFlow,
    MachineType,
    NodeSpec,
    NodeStatus,
    PackageEntry,
    PackagePiece,
    StageStatus,
    StepStatus,
    TransferMode,
    TransferRecord,
)
from ..services import nodes as nodes_svc
from ..services import backup as backup_svc
from ..services.versioning import check_upgrade_compat

DATA_DIR = Path(__file__).resolve().parents[2] / "data"


class StageFailure(Exception):
    """阶段内某步骤失败，中止该阶段。"""


# --------------------------------------------------------------------------- #
# 日志总线
# --------------------------------------------------------------------------- #
class LogBus:
    def __init__(self) -> None:
        self._subs: Dict[str, List[Callable[[Dict], None]]] = {}
        self._history: Dict[str, List[Dict]] = {}
        self._lock = threading.Lock()

    def publish(self, key: str, event: Dict) -> None:
        event.setdefault("ts", datetime.utcnow().isoformat())
        with self._lock:
            self._history.setdefault(key, []).append(event)
            subs = list(self._subs.get(key, []))
        for cb in subs:
            try:
                cb(event)
            except Exception:
                pass

    def subscribe(self, key: str, cb: Callable[[Dict], None]) -> None:
        with self._lock:
            self._subs.setdefault(key, []).append(cb)

    def unsubscribe(self, key: str, cb: Callable[[Dict], None]) -> None:
        with self._lock:
            if key in self._subs and cb in self._subs[key]:
                self._subs[key].remove(cb)

    def history(self, key: str) -> List[Dict]:
        with self._lock:
            return list(self._history.get(key, []))


bus = LogBus()


# --------------------------------------------------------------------------- #
# 执行器
# --------------------------------------------------------------------------- #
class StageExecutor:
    def __init__(self) -> None:
        self._running: Dict[str, threading.Thread] = {}
        self._cancelled: set[str] = set()
        self._lock = threading.Lock()

    # -- 对外 -------------------------------------------------------------- #
    def submit(self, flow: InstallFlow, stage_key: str, operator: str = "admin") -> InstallFlow:
        stage = next(s for s in flow.stages if s.key == stage_key)
        stage.status = StageStatus.RUNNING
        stage.started_at = datetime.utcnow()
        stage.error = None
        for s in stage.steps:
            s.status = StepStatus.PENDING
            s.output = ""
            s.error = None
        flow.status = FlowStatus.RUNNING
        store.save_flow(flow)

        key = f"{flow.id}:{stage_key}"
        store.audit(operator, f"stage.run:{stage_key}", flow.id, "started", flow.name)

        th = threading.Thread(target=self._run, args=(flow, stage, operator), daemon=True)
        with self._lock:
            self._running[key] = th
        th.start()
        return flow

    def cancel(self, flow_id: str, stage_key: str) -> bool:
        with self._lock:
            k = f"{flow_id}:{stage_key}"
            if k in self._running:
                self._cancelled.add(k)
                return True
        return False

    def is_running(self, flow_id: str, stage_key: str) -> bool:
        with self._lock:
            th = self._running.get(f"{flow_id}:{stage_key}")
            return bool(th and th.is_alive())

    # -- 内部 -------------------------------------------------------------- #
    def _log(self, key: str, msg: str, level: str = "info") -> None:
        line = f"[{datetime.utcnow().strftime('%H:%M:%S')}] {msg}"
        bus.publish(key, {"type": "log", "level": level, "message": line})

    def _run(self, flow: InstallFlow, stage: FlowStage, operator: str) -> None:
        key = f"{flow.id}:{stage.key}"
        self._log(key, f"━━━ 阶段「{stage.title}」开始 ━━━")

        try:
            for step in stage.steps:
                if key in self._cancelled:
                    stage.status = StageStatus.FAILED
                    stage.error = "被用户中止"
                    self._log(key, "阶段被用户中止", "warn")
                    break

                step.status = StepStatus.RUNNING
                step.started_at = datetime.utcnow()
                bus.publish(key, {"type": "step", "stage": stage.key,
                                  "step": step.model_dump(mode="json")})
                self._log(key, f"▶ 【{step.index + 1}/{len(stage.steps)}】{step.title}")

                t0 = time.time()
                try:
                    out = self._execute(flow, stage, step)
                    step.output = out or ""
                    step.status = StepStatus.DONE
                    for line in (out or "").splitlines():
                        if line.strip():
                            self._log(key, f"    {line}")
                    self._log(key, f"✔ {step.title} 完成", "ok")
                except StageFailure as e:
                    step.status = StepStatus.FAILED
                    step.error = str(e)
                    step.finished_at = datetime.utcnow()
                    step.duration_ms = int((time.time() - t0) * 1000)
                    self._log(key, f"✘ {step.title} 失败 — {e}", "error")
                    bus.publish(key, {"type": "step", "stage": stage.key,
                                      "step": step.model_dump(mode="json")})
                    raise
                finally:
                    step.finished_at = step.finished_at or datetime.utcnow()
                    step.duration_ms = step.duration_ms or int((time.time() - t0) * 1000)
                    bus.publish(key, {"type": "step", "stage": stage.key,
                                      "step": step.model_dump(mode="json")})
                    store.save_flow(flow)
            else:
                stage.status = StageStatus.PASSED
                stage.finished_at = datetime.utcnow()
                self._log(key, f"━━━ 阶段「{stage.title}」通过 ━━━", "ok")

            if stage.status == StageStatus.PASSED:
                from . import workflow as wf
                wf.refresh_locks(flow)
                if all(s.status in (StageStatus.PASSED, StageStatus.SKIPPED)
                       for s in flow.stages):
                    flow.status = FlowStatus.SUCCEEDED
                    flow.finished_at = datetime.utcnow()
                    self._log(key, "全部阶段完成，流程成功", "ok")

        except StageFailure as e:
            stage.status = StageStatus.FAILED
            stage.finished_at = datetime.utcnow()
            stage.error = str(e)
            flow.status = FlowStatus.FAILED
            flow.error = f"{stage.title}: {e}"
            self._log(key, f"阶段失败: {e}", "error")
        except Exception as e:  # noqa: BLE001
            stage.status = StageStatus.FAILED
            stage.error = f"未预期异常: {e}"
            flow.status = FlowStatus.FAILED
            self._log(key, stage.error, "error")

        if stage.status == StageStatus.PASSED:
            stage.finished_at = stage.finished_at or datetime.utcnow()
            # 全部阶段跑完时刷新终态；此处再判一次，避免上面
            # 「最后一步是 SKIPPED 的可选阶段」时状态没落到 SUCCEEDED。
            if all(s.status in (StageStatus.PASSED, StageStatus.SKIPPED)
                   for s in flow.stages):
                if flow.status != FlowStatus.FAILED:
                    flow.status = FlowStatus.SUCCEEDED
                    flow.finished_at = flow.finished_at or datetime.utcnow()
            store.save_flow(flow)

        store.save_flow(flow)
        bus.publish(key, {"type": "stage_done", "stage": stage.key,
                          "status": stage.status.value, "error": stage.error})
        store.audit(operator, f"stage.run:{stage.key}", flow.id,
                    stage.status.value, stage.error or "")

        with self._lock:
            self._running.pop(key, None)

    # ------------------------------------------------------------------ #
    # 动作分派
    # ------------------------------------------------------------------ #
    def _execute(self, flow: InstallFlow, stage: FlowStage, step: Any) -> str:
        handler = getattr(self, "_act_" + step.action.replace(".", "_"), None)
        if handler is None:
            return f"（{step.action} 未注册处理器，已跳过）"
        return handler(flow, stage, step)

    def _env(self, flow: InstallFlow) -> EnvironmentSpec:
        env = store.get_env(flow.env_id)
        if not env:
            raise StageFailure(f"环境不存在: {flow.env_id}")
        return env

    @staticmethod
    def _as_list(v: Any) -> List[str]:
        """把阶段输入里的"列表型字段"统一成字符串列表。

        前端对 multiline_list 字段提交的是数组（每行一项），但也允许用户
        在文本框里用逗号分隔 —— 两种写法都得能收。旧客户端还可能提交字符串。
        """
        if v is None:
            return []
        if isinstance(v, str):
            return [x.strip() for x in v.replace("，", ",").split(",") if x.strip()]
        if isinstance(v, (list, tuple, set)):
            out: List[str] = []
            for x in v:
                out.extend(StageExecutor._as_list(x))
            return out
        return [str(v).strip()]

    def _nodes_of_stage(self, flow: InstallFlow, stage: FlowStage,
                        roles: Optional[List[str]] = None) -> List[NodeSpec]:
        env = self._env(flow)
        ns = env.nodes
        if roles:
            ns = [n for n in ns if n.role.value in roles]
        if not ns:
            raise StageFailure("没有匹配的节点，请检查角色筛选条件")
        return ns

    # ============ 环境登记 ============ #
    def _act_env_validate_matrix(self, flow, stage, step) -> str:
        inp = stage.inputs
        physical = inp.get("physical_nodes") or []
        virtual = inp.get("virtual_nodes") or []
        lines = [
            f"节点矩阵校验通过：物理机 {len(physical)} 台 / 虚拟机 {len(virtual)} 台，"
            f"合计 {len(physical) + len(virtual)} 台"
        ]
        roles: Dict[str, int] = {}
        for n in physical:
            roles[n.get("role", "worker")] = roles.get(n.get("role", "worker"), 0) + 1
        for n in virtual:
            roles[n.get("role", "worker")] = roles.get(n.get("role", "worker"), 0) + 1
        lines.append("角色分布：" + "、".join(f"{k} {v} 台" for k, v in sorted(roles.items())))
        ips = [n.get("ip") for n in physical + virtual]
        lines.append(f"IP 段：{ips[0]} ~ {ips[-1]}" if ips else "")
        lines.append("未发现 IP 冲突或必填项缺失")
        return "\n".join(l for l in lines if l)

    def _act_env_persist_nodes(self, flow, stage, step) -> str:
        inp = stage.inputs
        env = self._env(flow)
        physical_in = inp.get("physical_nodes") or []
        virtual_in = inp.get("virtual_nodes") or []

        # 幂等保护：表单未提交节点（或提交为空）时，保留环境里已登记的节点。
        # 否则重跑本阶段会把已有节点清空 —— 这是很危险的静默数据丢失。
        if not physical_in and not virtual_in:
            if env.nodes:
                return (f"表单未提交节点数据，沿用环境中已登记的 {len(env.nodes)} 台节点\n"
                        + "\n".join(f"  {n.role.value:9s} {n.hostname:20s} {n.ip:16s} "
                                    f"{'物理机' if n.machine_type == MachineType.PHYSICAL else '虚拟机'}"
                                    for n in env.nodes))
            raise StageFailure("既未提交节点表单，环境中也没有已登记节点")

        built: List[NodeSpec] = []

        for n in physical_in:
            built.append(NodeSpec(
                id=uuid.uuid4().hex[:12],
                hostname=n.get("hostname", ""), ip=n.get("ip", ""),
                role=n.get("role", "worker"), machine_type=MachineType.PHYSICAL,
                ssh_port=int(n.get("ssh_port") or 22),
                ssh_user=n.get("ssh_user") or "root",
                ssh_key_path=n.get("ssh_key_path"),
                vendor=n.get("vendor"), model=n.get("model"),
                idc=n.get("idc"), rack=n.get("rack"),
                nic_speed=n.get("nic_speed"), raid_level=n.get("raid_level"),
            ))
        for n in virtual_in:
            built.append(NodeSpec(
                id=uuid.uuid4().hex[:12],
                hostname=n.get("hostname", ""), ip=n.get("ip", ""),
                role=n.get("role", "worker"), machine_type=MachineType.VIRTUAL,
                ssh_port=int(n.get("ssh_port") or 22),
                ssh_user=n.get("ssh_user") or "root",
                ssh_key_path=n.get("ssh_key_path"),
                host_platform=n.get("host_platform"),
                vcpu=int(n["vcpu"]) if n.get("vcpu") else None,
                memory_gb=int(n["memory_gb"]) if n.get("memory_gb") else None,
                disk_gb=int(n["disk_gb"]) if n.get("disk_gb") else None,
                image_template=n.get("image_template"),
            ))

        env.nodes = built
        env.base_domain = inp.get("base_domain", env.base_domain)
        env.ntp_server = inp.get("ntp_server", env.ntp_server)
        _dns = self._as_list(inp.get("dns_servers"))
        env.dns_servers = _dns or env.dns_servers
        env.timezone = inp.get("timezone", env.timezone)
        env.validated = True
        store.save_env(env)

        by_type: Dict[str, int] = {}
        for n in built:
            by_type[n.machine_type.value] = by_type.get(n.machine_type.value, 0) + 1
        return (f"已生成节点清单 {len(built)} 台"
                f"（物理机 {by_type.get('physical', 0)} / 虚拟机 {by_type.get('virtual', 0)}）\n"
                + "\n".join(f"  {n.role.value:9s} {n.hostname:20s} {n.ip:16s} "
                            f"{'物理机' if n.machine_type == MachineType.PHYSICAL else '虚拟机'}"
                            for n in built))

    # ============ 环境校验 ============ #
    def _apply_ssh_inputs(self, flow: InstallFlow, stage: FlowStage) -> None:
        """把阶段里填的 SSH 参数下发给所有节点（仅覆盖未单独设置的）。"""
        env = self._env(flow)
        inp = stage.inputs
        changed = False
        for n in env.nodes:
            if inp.get("ssh_key_path"):
                n.ssh_key_path = inp["ssh_key_path"]
                changed = True
            if inp.get("ssh_user"):
                n.ssh_user = inp["ssh_user"]
                changed = True
            if inp.get("ssh_port"):
                n.ssh_port = int(inp["ssh_port"])
                changed = True
        if changed:
            store.save_env(env)

    def _act_precheck_connect(self, flow, stage, step) -> str:
        self._apply_ssh_inputs(flow, stage)
        env = self._env(flow)
        lines = []
        ok_count = 0
        for n in env.nodes:
            drv = nodes_svc.get_driver(n)
            ok, msg, info = drv.probe()
            if ok:
                n.status = NodeStatus.REACHABLE
                n.os_release = info.get("os_release")
                n.kernel = info.get("kernel")
                n.cpu_cores = info.get("cpu_cores")
                n.mem_total_gb = info.get("mem_total_gb")
                n.disk_free_gb = info.get("disk_free_gb")
                n.last_checked_at = datetime.utcnow()
                ok_count += 1
                lines.append(f"  ✔ {n.hostname:20s} {n.ip:16s} {n.os_release or ''}"[:110])
            else:
                n.status = NodeStatus.UNREACHABLE
                lines.append(f"  ✘ {n.hostname:20s} {n.ip:16s} {msg}")
        store.save_env(env)

        mode = "模拟模式" if any(nodes_svc.get_driver(n).is_mock for n in env.nodes) else "真实 SSH"
        if ok_count == 0:
            raise StageFailure(f"所有节点均不可达（{mode}）")
        return f"连通性探测完成（{mode}）：{ok_count}/{len(env.nodes)} 台可达\n" + "\n".join(lines)

    def _act_precheck_system(self, flow, stage, step) -> str:
        env = self._env(flow)
        reachable = [n for n in env.nodes if n.status == NodeStatus.REACHABLE]
        if not reachable:
            raise StageFailure("没有可达节点，请先完成连通性探测")

        all_issues: List[str] = []
        lines = []
        pass_count = 0
        for n in reachable:
            drv = nodes_svc.get_driver(n)
            ok, report, issues = drv.precheck()
            n.precheck_issues = issues
            n.status = NodeStatus.PREPARED if not issues else NodeStatus.REACHABLE
            if not issues:
                pass_count += 1
            lines.append(f"── {n.hostname} ({n.ip}) ──")
            lines.extend("   " + l for l in report.splitlines())
            for i in issues:
                lines.append(f"   ⚠ {i}")
                all_issues.append(f"{n.hostname}: {i}")
        store.save_env(env)

        strict = stage.inputs.get("strict_mode")
        if strict and all_issues:
            raise StageFailure(
                f"严格模式：{len(all_issues)} 项预检未通过，已阻断流程\n"
                + "\n".join(f"  · {i}" for i in all_issues)
            )
        return (f"系统预检完成：{pass_count}/{len(reachable)} 台全部通过，"
                f"共 {len(all_issues)} 项待处理\n" + "\n".join(lines))

    def _act_precheck_upgrade_ready(self, flow, stage, step) -> str:
        env = self._env(flow)
        reachable = [n for n in env.nodes if n.status == NodeStatus.REACHABLE]
        if not reachable:
            raise StageFailure("没有可达节点")

        lines = []
        issues: List[str] = []
        target_v = (stage.inputs.get("target_version") or "").strip()
        current_v = env.base_domain and "v1.0.0" or "v1.0.0"   # 真实场景从节点上读取

        for n in reachable:
            drv = nodes_svc.get_driver(n)
            ok, report, node_issues = drv.precheck()
            extra: List[str] = []
            # 升级额外关注磁盘余量（需要空间存放新旧两份）
            if n.disk_free_gb is not None and n.disk_free_gb < 50:
                extra.append(f"可用磁盘 {n.disk_free_gb:.0f} GB，升级需额外空间，建议清理到 50 GB 以上")
            n.precheck_issues = node_issues + extra
            if node_issues or extra:
                issues.extend(f"{n.hostname}: {i}" for i in node_issues + extra)
            lines.append(f"── {n.hostname} ({n.ip}) ──")
            lines.extend("   " + l for l in report.splitlines())
            for i in node_issues + extra:
                lines.append(f"   ⚠ {i}")

        if stage.inputs.get("check_compat", True) and target_v:
            compat = check_upgrade_compat(current_v, target_v)
            lines.append(f"── 版本兼容性 ──")
            lines.append(f"   {current_v} → {target_v}: {compat['message']}")
            if compat["level"] == "blocker":
                raise StageFailure(f"版本不兼容，已阻断：{compat['message']}")
            if compat["level"] == "warning":
                issues.append(compat["message"])
        store.save_env(env)

        return (f"升级就绪度检查完成，{len(issues)} 项待处理\n" + "\n".join(lines))

    def _act_precheck_report(self, flow, stage, step) -> str:
        env = self._env(flow)
        total = len(env.nodes)
        reachable = sum(1 for n in env.nodes if n.status in (NodeStatus.REACHABLE, NodeStatus.PREPARED))
        prepared = sum(1 for n in env.nodes if n.status == NodeStatus.PREPARED)
        with_issues = [n for n in env.nodes if n.precheck_issues]

        lines = [
            f"校验报告：共 {total} 台节点",
            f"  SSH 可达      {reachable}/{total}",
            f"  预检全部通过  {prepared}/{total}",
            f"  存在问题节点  {len(with_issues)} 台",
        ]
        if with_issues:
            lines.append("")
            lines.append("待处理问题清单（不阻断流程，但建议安装前修复）：")
            for n in with_issues:
                for i in n.precheck_issues:
                    lines.append(f"  · {n.hostname}: {i}")
        else:
            lines.append("")
            lines.append("所有节点预检通过，可以进入下一阶段。")
        return "\n".join(lines)

    # ============ 安装包 ============ #
    def _act_package_receive(self, flow, stage, step) -> str:
        """真实场景由 HTTP 上传接口写入；此处确认暂存区状态。"""
        pid = stage.inputs.get("_package_id")
        if not pid:
            raise StageFailure("尚未上传安装包，请先在上传接口提交文件")
        p = store.get_package(pid)
        if not p:
            raise StageFailure(f"安装包 {pid} 不存在")
        if not p.upload_complete:
            raise StageFailure(
                f"安装包 {p.name} 上传未完成（{p.uploaded_bytes}/{p.size_bytes} 字节）"
            )
        return (f"包 {p.name} {p.version} 已就绪\n"
                f"  大小   {p.size_bytes / 1024 / 1024:.2f} MB\n"
                f"  SHA256 {p.checksum[:32]}…\n"
                f"  存储   {p.path}")

    def _act_package_chunk(self, flow, stage, step) -> str:
        pid = stage.inputs.get("_package_id")
        p = store.get_package(pid)
        if not p:
            raise StageFailure("安装包不存在")
        if not p.pieces:
            return "包体小于分片阈值（64 MB），无需分片，按整包校验"
        bad = []
        for pc in p.pieces:
            if not pc.checksum:
                bad.append(pc.index)
        if bad:
            raise StageFailure(f"分片 {bad} 校验和缺失，请重新上传")
        total = sum(pc.size_bytes for pc in p.pieces)
        return (f"分片校验通过：{len(p.pieces)} 片，合计 {total / 1024 / 1024:.2f} MB\n"
                f"  每片 64 MB，支持断点续传")

    def _act_package_register(self, flow, stage, step) -> str:
        pid = stage.inputs.get("_package_id")
        p = store.get_package(pid)
        if not p:
            raise StageFailure("安装包不存在")
        p.target_env_id = flow.env_id
        store.save_package(p)
        all_pkgs = store.list_packages()
        return (f"包清单已登记（当前目录共 {len(all_pkgs)} 个包）\n"
                + "\n".join(f"  · {x.name} {x.version} [{x.kind}] "
                            f"{x.size_bytes / 1024 / 1024:.2f} MB" for x in all_pkgs[:8]))

    # ============ 分发 ============ #
    def _create_distribution(self, flow: InstallFlow, stage: FlowStage) -> DistributionJob:
        inp = stage.inputs
        env = self._env(flow)
        roles = inp.get("target_roles") or [r.value for r in set(n.role for n in env.nodes)]
        targets = [n for n in env.nodes if n.role.value in roles]

        pkg_ids = inp.get("_package_ids") or []
        if not pkg_ids and flow.mode == "install":
            # 回退：取本环境最近登记且上传完成的包
            pkgs = [p for p in store.list_packages() if p.upload_complete]
            pkg_ids = [pkgs[0].id] if pkgs else []
        if not pkg_ids:
            raise StageFailure("没有可分发安装包，请先在上一阶段完成上传")

        mode = TransferMode(inp.get("mode") or "rsync")
        job = DistributionJob(
            id=uuid.uuid4().hex[:12], flow_id=flow.id,
            package_ids=pkg_ids, env_id=flow.env_id, mode=mode,
            concurrency=int(inp.get("concurrency") or 4),
            remote_dir=inp.get("remote_dir") or "/opt/packages",
            verify_checksum=bool(inp.get("verify_checksum", True)),
            records=[
                TransferRecord(node_id=n.id, hostname=n.hostname, ip=n.ip, mode=mode)
                for n in targets
            ],
        )
        store.save_distribution(job)
        stage.inputs["_distribution_id"] = job.id
        return job

    def _act_distribute_connect(self, flow, stage, step) -> str:
        job = self._create_distribution(flow, stage)
        lines = []
        bad = 0
        for rec in job.records:
            node = next((n for n in store.get_env(flow.env_id).nodes if n.id == rec.node_id), None)
            if not node:
                continue
            drv = nodes_svc.get_driver(node)
            if drv.is_mock:
                lines.append(f"  ✔ {rec.hostname:20s} {rec.ip:16s} [MOCK] 目录可写")
                continue
            r = drv.ssh(f"mkdir -p {job.remote_dir} && test -w {job.remote_dir} && echo OK")
            if r.ok and "OK" in r.stdout:
                lines.append(f"  ✔ {rec.hostname:20s} {rec.ip:16s} {job.remote_dir} 可写")
            else:
                rec.status = StepStatus.FAILED
                rec.error = f"目标目录不可写: {r.stderr.strip()[:80]}"
                lines.append(f"  ✘ {rec.hostname:20s} {rec.ip:16s} {rec.error}")
                bad += 1
        store.save_distribution(job)
        if bad == len(job.records):
            raise StageFailure("所有目标节点均不可写，请检查 SSH 凭据与目录权限")
        return (f"目标节点连接就绪：{len(job.records) - bad}/{len(job.records)} 台\n"
                + "\n".join(lines))

    def _act_distribute_push(self, flow, stage, step) -> str:
        job = store.get_distribution(stage.inputs["_distribution_id"])
        env = store.get_env(flow.env_id)
        pkgs = [store.get_package(p) for p in job.package_ids]
        pkgs = [p for p in pkgs if p]

        total_bytes = sum(p.size_bytes for p in pkgs)
        lines = [f"开始分发 {len(pkgs)} 个包（共 {total_bytes / 1024 / 1024:.2f} MB）"
                 f"→ {len(job.records)} 个节点，方式 {job.mode.value}，并发 {job.concurrency}"]
        lines.append("  包清单: " + ", ".join(f"{p.name}({p.size_bytes / 1024 / 1024:.1f}MB)" for p in pkgs))

        done = 0
        for rec in job.records:
            node = next((n for n in env.nodes if n.id == rec.node_id), None)
            if not node:
                continue
            drv = nodes_svc.get_driver(node)
            rec.status = StepStatus.RUNNING
            rec.started_at = datetime.utcnow()
            sent = 0
            errs = []
            for p in pkgs:
                t0 = time.time()
                ok, out, size = drv.push(p.path, job.remote_dir, job.mode)
                dt = max(time.time() - t0, 0.01)
                if ok:
                    sent += size
                    rec.remote_path = f"{job.remote_dir}/{Path(p.path).name}"
                else:
                    errs.append(f"{p.name}: {out[:80]}")
            rec.bytes_sent = sent
            rec.finished_at = datetime.utcnow()
            if rec.started_at and sent:
                secs = max((rec.finished_at - rec.started_at).total_seconds(), 0.01)
                rec.speed_mbps = round(sent / 1024 / 1024 / secs, 1)
            if errs:
                rec.status = StepStatus.FAILED
                rec.error = "; ".join(errs)
                lines.append(f"  ✘ {rec.hostname:20s} 失败 — {rec.error}")
            else:
                rec.status = StepStatus.DONE
                done += 1
                lines.append(f"  ✔ {rec.hostname:20s} {sent / 1024 / 1024:8.2f} MB "
                             f"@ {rec.speed_mbps} MB/s")
        store.save_distribution(job)

        failed = [r for r in job.records if r.status == StepStatus.FAILED]
        if failed and len(failed) == len(job.records):
            raise StageFailure(f"所有 {len(failed)} 个节点分发失败")
        return (f"分发完成：{done}/{len(job.records)} 台成功\n" + "\n".join(lines)
                + (f"\n⚠ {len(failed)} 台失败，将在下一步骤校验时识别" if failed else ""))

    def _act_distribute_verify(self, flow, stage, step) -> str:
        job = store.get_distribution(stage.inputs["_distribution_id"])
        env = store.get_env(flow.env_id)
        pkgs = [store.get_package(p) for p in job.package_ids]
        pkgs = [p for p in pkgs if p]
        lines = []
        bad_nodes = []

        for rec in job.records:
            if rec.status == StepStatus.FAILED:
                lines.append(f"  – {rec.hostname:20s} 已在上一步失败，跳过校验")
                continue
            node = next((n for n in env.nodes if n.id == rec.node_id), None)
            if not node:
                continue
            drv = nodes_svc.get_driver(node)
            if not job.verify_checksum:
                rec.checksum_ok = None
                lines.append(f"  – {rec.hostname:20s} 已关闭校验，跳过")
                continue
            mismatch = []
            for p in pkgs:
                remote = f"{job.remote_dir}/{Path(p.path).name}"
                ok, remote_sum = drv.remote_sha256(remote)
                if not ok:
                    mismatch.append(f"{p.name} 远端缺失")
                    continue
                if drv.is_mock:
                    continue        # 模拟模式不做真实比对
                if remote_sum and remote_sum != p.checksum:
                    mismatch.append(f"{p.name} 校验和不符")
            if mismatch:
                rec.checksum_ok = False
                bad_nodes.append(rec.hostname)
                lines.append(f"  ✘ {rec.hostname:20s} {', '.join(mismatch)}")
            else:
                rec.checksum_ok = True
                lines.append(f"  ✔ {rec.hostname:20s} SHA256 一致")
        store.save_distribution(job)

        if bad_nodes and len(bad_nodes) == len([r for r in job.records
                                                if r.status != StepStatus.FAILED]):
            job.status = StepStatus.FAILED
            store.save_distribution(job)
            raise StageFailure(f"所有节点完整性校验失败: {', '.join(bad_nodes)}")

        # 落终态：有部分节点失败 → partial；全绿 → done。
        # 原来这里不写 status，分发记录会永远停在 pending，看着像没跑完。
        failed_recs = [r for r in job.records if r.status == StepStatus.FAILED
                       or r.checksum_ok is False]
        job.status = StepStatus.PARTIAL if failed_recs else StepStatus.DONE
        store.save_distribution(job)

        return ("完整性校验完成\n" + "\n".join(lines)
                + (f"\n⚠ 以下节点需重传: {', '.join(bad_nodes)}" if bad_nodes else ""))

    # ============ 备份 ============ #
    def _collect_backup_scope(self, flow: InstallFlow, stage: FlowStage,
                              kind: BackupKind) -> BackupPoint:
        env = self._env(flow)
        inp = stage.inputs
        targets = [n for n in env.nodes
                   if n.status in (NodeStatus.REACHABLE, NodeStatus.PREPARED)]
        if not targets:
            targets = env.nodes

        b = BackupPoint(
            id=uuid.uuid4().hex[:12],
            name=inp.get("backup_name") or f"{kind.value}-{env.name}-{datetime.utcnow():%Y%m%d-%H%M%S}",
            kind=kind, env_id=flow.env_id, flow_id=flow.id,
            include_paths=self._as_list(inp.get("include_paths")),
            include_databases=self._as_list(inp.get("include_databases")),
            include_config=bool(inp.get("include_config", True)),
            retention_days=int(inp.get("retention_days") or 30),
            nodes_covered=[n.hostname for n in targets],
        )
        store.save_backup(b)
        stage.inputs["_backup_id"] = b.id
        return b

    def _act_backup_scope(self, flow, stage, step) -> str:
        kind = BackupKind.PRE_UPGRADE if flow.mode == "upgrade" else BackupKind.PRE_INSTALL
        b = self._collect_backup_scope(flow, stage, kind)
        lines = [
            f"备份点 {b.name}",
            f"  类型      {'升级前备份' if kind == BackupKind.PRE_UPGRADE else '安装前备份'}",
            f"  覆盖节点  {len(b.nodes_covered)} 台：{', '.join(b.nodes_covered[:6])}"
            + (" …" if len(b.nodes_covered) > 6 else ""),
            f"  备份目录  {', '.join(b.include_paths) or '（无）'}",
            f"  数据库    {', '.join(b.include_databases) or '（无）'}",
            f"  配置文件  {'包含' if b.include_config else '不包含'}",
            f"  保留期限  {b.retention_days} 天（过期后标记为可清理）",
        ]
        total = len(b.include_paths) + len(b.include_databases) + (1 if b.include_config else 0)
        if total == 0:
            raise StageFailure("备份范围为空，无法执行")
        return "\n".join(lines)

    def _act_backup_archive(self, flow, stage, step) -> str:
        b = store.get_backup(stage.inputs["_backup_id"])
        if not b:
            raise StageFailure("备份点不存在")
        b.status = BackupStatus.RUNNING
        b.started_at = datetime.utcnow()
        store.save_backup(b)

        backup_dir = DATA_DIR / "backups" / b.id
        backup_dir.mkdir(parents=True, exist_ok=True)
        env = store.get_env(flow.env_id)
        targets = [n for n in env.nodes if n.hostname in b.nodes_covered]

        lines = []
        total_bytes = 0
        for n in targets:
            drv = nodes_svc.get_driver(n)
            node_dir = backup_dir / n.hostname
            node_dir.mkdir(parents=True, exist_ok=True)
            manifest = {
                "node": n.hostname, "ip": n.ip, "role": n.role.value,
                "paths": b.include_paths, "config": b.include_config,
                "created": datetime.utcnow().isoformat(),
            }
            mf = node_dir / "manifest.json"
            raw = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
            mf.write_bytes(raw)
            size = len(raw)

            if not drv.is_mock and b.include_paths:
                # 真实：在节点上打包后拉回
                paths = " ".join(b.include_paths)
                archive = f"/tmp/cloudops-backup-{b.id}.tar.gz"
                r = drv.ssh(f"tar czf {archive} {paths} 2>/dev/null; "
                            f"stat -c%s {archive} 2>/dev/null || echo 0", timeout=3600)
                if r.ok:
                    try:
                        size = int(r.stdout.strip().splitlines()[-1])
                    except (ValueError, IndexError):
                        pass
                    drv.pull(archive, str(node_dir))
                    drv.ssh(f"rm -f {archive}")
            elif drv.is_mock:
                # 模拟模式：由节点 IP 生成稳定的伪随机体积（120MB ~ 1.6GB），
                # 不能用磁盘容量估算 —— 那会让报告虚高到几百 GB，脱离真实。
                # 用 md5 播种保证同一节点每次跑出来一致，便于反复验证。
                seed = int(hashlib.md5(n.ip.encode()).hexdigest()[:8], 16)
                est = 120 * 1024 * 1024 + (seed % (1536 - 120)) * 1024 * 1024
                size += est

            total_bytes += size
            lines.append(f"  ✔ {n.hostname:20s} 归档 {size / 1024 / 1024:8.2f} MB → {node_dir.name}/")

        b.size_bytes = total_bytes
        b.path = str(backup_dir)
        store.save_backup(b)
        return f"文件归档完成：{len(targets)} 台节点\n" + "\n".join(lines)

    def _act_backup_database(self, flow, stage, step) -> str:
        b = store.get_backup(stage.inputs["_backup_id"])
        if not b or not b.include_databases:
            return "未指定数据库，跳过逻辑备份"
        env = store.get_env(flow.env_id)
        db_nodes = [n for n in env.nodes if n.role.value == "database"] or \
                   [n for n in env.nodes if n.hostname in b.nodes_covered][:1]

        lines = []
        backup_dir = Path(b.path) if b.path else (DATA_DIR / "backups" / b.id)
        for n in db_nodes:
            drv = nodes_svc.get_driver(n)
            for db in b.include_databases:
                dump_dir = backup_dir / n.hostname
                dump_dir.mkdir(parents=True, exist_ok=True)
                dump_file = dump_dir / f"{db}.sql.gz"
                if drv.is_mock:
                    content = (f"-- [MOCK] logical dump of {db} from {n.hostname}\n"
                               f"-- generated {datetime.utcnow().isoformat()}\n").encode()
                    dump_file.write_bytes(content)
                    lines.append(f"  ✔ {n.hostname:16s} {db:16s} "
                                 f"[MOCK] {len(content)} 字节")
                else:
                    remote = f"/tmp/{db}-{b.id}.sql.gz"
                    r = drv.ssh(
                        f"(mysqldump --single-transaction --routines {db} 2>/dev/null || "
                        f"pg_dump {db} 2>/dev/null) | gzip > {remote}; "
                        f"stat -c%s {remote} 2>/dev/null || echo 0",
                        timeout=7200)
                    if not r.ok:
                        raise StageFailure(f"{n.hostname} 上 {db} 备份失败: {r.stderr.strip()[:100]}")
                    drv.pull(remote, str(dump_dir))
                    drv.ssh(f"rm -f {remote}")
                    try:
                        sz = int(r.stdout.strip().splitlines()[-1])
                    except (ValueError, IndexError):
                        sz = 0
                    b.size_bytes += sz
                    lines.append(f"  ✔ {n.hostname:16s} {db:16s} {sz / 1024:8.1f} KB")
        store.save_backup(b)
        return f"数据库逻辑备份完成：{len(b.include_databases)} 个实例\n" + "\n".join(lines)

    def _act_backup_register(self, flow, stage, step) -> str:
        b = store.get_backup(stage.inputs["_backup_id"])
        if not b:
            raise StageFailure("备份点不存在")

        # 校验和算法集中在 services/backup.py —— 与 /verify 端点共用，
        # 避免两处各写一份导致校验永远失败。
        b.checksum = backup_svc.backup_digest(b)[0]
        b.status = BackupStatus.SUCCEEDED
        b.finished_at = datetime.utcnow()
        b.expire_at = datetime.utcnow() + timedelta(days=b.retention_days)
        b.restorable = True
        store.save_backup(b)
        flow.backup_point_id = b.id
        store.save_flow(flow)

        store.audit(flow.operator, "backup.create", b.id, "ok", b.name)
        return (f"备份点已登记\n"
                f"  ID        {b.id}\n"
                f"  大小      {b.size_bytes / 1024 / 1024:.2f} MB\n"
                f"  校验和    {b.checksum[:32]}…\n"
                f"  过期时间  {b.expire_at:%Y-%m-%d %H:%M}\n"
                f"  可恢复    ✔ 已标记为回滚基线")

    # ============ 安装执行 ============ #
    def _check_packages_ready(self, flow: InstallFlow) -> str:
        dists = store.list_distributions(flow.id)
        if not dists:
            # 检查是否有已上传的包（允许跳过分发阶段时仍能安装）
            pkgs = [p for p in store.list_packages() if p.upload_complete]
            if not pkgs:
                raise StageFailure("没有已上传的安装包，请先完成包上传阶段")
            return f"使用本地包 {len(pkgs)} 个（未走分发）"
        d = dists[0]
        ok_n = sum(1 for r in d.records if r.status == StepStatus.DONE)
        if ok_n == 0:
            raise StageFailure("上一阶段的分发未成功，请先重跑包分发")
        return f"分发校验通过：{ok_n}/{len(d.records)} 台节点已就绪"

    def _act_install_precheck(self, flow, stage, step) -> str:
        msg = self._check_packages_ready(flow)
        env = self._env(flow)
        not_prepared = [n.hostname for n in env.nodes if n.status == NodeStatus.UNKNOWN]
        lines = [msg]
        if not_prepared:
            lines.append(f"⚠ 以下节点尚未完成环境校验，将直接安装: {', '.join(not_prepared)}")
        lines.append(f"安装模式: {stage.inputs.get('install_mode', 'full')}")
        lines.append(f"失败即停: {'是' if stage.inputs.get('stop_on_failure', True) else '否'}")
        return "\n".join(lines)

    def _install_on_nodes(self, flow: InstallFlow, stage: FlowStage,
                          nodes: List[NodeSpec], component: str) -> List[str]:
        lines = []
        failures: List[str] = []
        stop_on_fail = stage.inputs.get("stop_on_failure", True)
        # skip_components / include_paths 这类字段前端提交的是数组（每行一项），
        # 但也可能是逗号分隔的字符串，两种都要能处理。
        skip = self._as_list(stage.inputs.get("skip_components"))

        if component in skip:
            return [f"  – 组件 {component} 在跳过清单中，已略过"]

        # 注意：nodes 是从 env.nodes 取出的对象引用，改 n.status 后必须回写环境，
        # 否则交付报告里的"安装成功台数"会永远是 0。
        env = self._env(flow)
        by_id = {n.id: n for n in env.nodes}

        for n in nodes:
            drv = nodes_svc.get_driver(n)
            target = by_id.get(n.id, n)
            if drv.is_mock:
                time.sleep(0.15)
                target.status = NodeStatus.INSTALLED
                lines.append(f"  ✔ {n.hostname:20s} {n.ip:16s} [MOCK] {component} 安装成功")
                continue
            script = (
                f"set -e; cd /opt/packages; "
                f"if [ -f install-{component}.sh ]; then bash install-{component}.sh; "
                f"else echo 'no installer script, skipped'; fi"
            )
            r = drv.ssh(script, timeout=3600)
            if r.ok:
                target.status = NodeStatus.INSTALLED
                lines.append(f"  ✔ {n.hostname:20s} {n.ip:16s} {component} 安装成功")
            else:
                failures.append(n.hostname)
                lines.append(f"  ✘ {n.hostname:20s} {n.ip:16s} {r.stderr.strip()[:90]}")
                if stop_on_fail:
                    break

        env.nodes = list(by_id.values())
        store.save_env(env)
        if failures and stop_on_fail:
            raise StageFailure(f"{component} 在节点 {', '.join(failures)} 上安装失败，已停止")
        return lines

    def _act_install_control_plane(self, flow, stage, step) -> str:
        nodes = self._nodes_of_stage(flow, stage, ["control"])
        lines = [f"控制面组件 → {len(nodes)} 台控制节点"]
        lines += self._install_on_nodes(flow, stage, nodes, "control-plane")
        return "\n".join(lines)

    def _act_install_data_plane(self, flow, stage, step) -> str:
        nodes = self._nodes_of_stage(flow, stage, ["database", "storage"])
        lines = [f"数据面组件 → {len(nodes)} 台数据库/存储节点"]
        lines += self._install_on_nodes(flow, stage, nodes, "data-plane")
        return "\n".join(lines)

    def _act_install_workers(self, flow, stage, step) -> str:
        nodes = self._nodes_of_stage(flow, stage, ["worker"])
        conc = int(stage.inputs.get("parallel_workers") or 3)
        lines = [f"工作节点组件 → {len(nodes)} 台（并发 {conc}）"]
        # 分批模拟并发
        for i in range(0, len(nodes), conc):
            batch = nodes[i:i + conc]
            lines.append(f"  ── 批次 {i // conc + 1}（{len(batch)} 台）──")
            lines += self._install_on_nodes(flow, stage, batch, "worker-node")
        return "\n".join(lines)

    def _act_install_gateway(self, flow, stage, step) -> str:
        nodes = self._nodes_of_stage(flow, stage, ["gateway"])
        lines = [f"网关组件 → {len(nodes)} 台接入节点"]
        lines += self._install_on_nodes(flow, stage, nodes, "gateway")
        return "\n".join(lines)

    # ============ 升级 ============ #
    def _act_upgrade_drain(self, flow, stage, step) -> str:
        env = self._env(flow)
        nodes = [n for n in env.nodes if n.role.value in ("worker", "gateway")]
        lines = [f"流量摘除：{len(nodes)} 台节点"]
        for n in nodes:
            drv = nodes_svc.get_driver(n)
            if drv.is_mock:
                lines.append(f"  ✔ {n.hostname:20s} [MOCK] 已从负载均衡摘除，连接已排空")
            else:
                r = drv.ssh("systemctl stop app-worker 2>/dev/null || true; echo done")
                lines.append(f"  {'✔' if r.ok else '✘'} {n.hostname:20s} "
                             f"{'已摘除' if r.ok else r.stderr.strip()[:60]}")
        return ("升级前流量摘除完成，此阶段开始产生服务中断\n" + "\n".join(lines))

    def _act_upgrade_snapshot(self, flow, stage, step) -> str:
        env = self._env(flow)
        snap_dir = DATA_DIR / "backups" / f"upgrade-snapshot-{flow.id}"
        snap_dir.mkdir(parents=True, exist_ok=True)
        lines = []
        for n in env.nodes:
            drv = nodes_svc.get_driver(n)
            d = snap_dir / n.hostname
            d.mkdir(parents=True, exist_ok=True)
            (d / "version.txt").write_bytes(b"v1.0.0")
            if drv.is_mock:
                lines.append(f"  ✔ {n.hostname:20s} [MOCK] 当前版本与配置已快照")
            else:
                r = drv.ssh("tar czf /tmp/cur.tar.gz /opt/app/bin /opt/app/conf 2>/dev/null; echo ok")
                lines.append(f"  ✔ {n.hostname:20s} {'快照完成' if r.ok else '快照警告'}")
        return (f"版本快照完成 → {snap_dir}\n" + "\n".join(lines)
                + "\n该快照用于快速回退，与备份点相互独立")

    def _act_upgrade_replace(self, flow, stage, step) -> str:
        env = self._env(flow)
        ver = stage.inputs.get("target_version") or "v2.0.0"
        strategy = stage.inputs.get("strategy", "rolling")
        batch_size = int(stage.inputs.get("batch_size") or 1)
        nodes = env.nodes
        lines = [f"替换安装包 → {ver}（策略 {strategy}，批量 {batch_size}）"]
        for i in range(0, len(nodes), batch_size):
            batch = nodes[i:i + batch_size]
            for n in batch:
                drv = nodes_svc.get_driver(n)
                if drv.is_mock:
                    lines.append(f"  ✔ {n.hostname:20s} [MOCK] 已切换软链接到 {ver}")
                else:
                    r = drv.ssh(
                        f"cd /opt/app && ln -sfn /opt/packages/{ver} current && "
                        f"readlink current", timeout=900)
                    lines.append(f"  {'✔' if r.ok else '✘'} {n.hostname:20s} "
                                 f"{r.stdout.strip() or r.stderr.strip()[:60]}")
            if i + batch_size < len(nodes):
                pause = int(stage.inputs.get("pause_between_batches") or 30)
                lines.append(f"  ⏸ 批次间暂停 {pause}s（等待健康观察）")
                time.sleep(min(pause, 2))     # 演示环境不真等
        return "\n".join(lines)

    def _act_upgrade_migrate_data(self, flow, stage, step) -> str:
        env = self._env(flow)
        db_nodes = [n for n in env.nodes if n.role.value == "database"]
        if not db_nodes:
            return "无数据库节点，跳过数据迁移"
        lines = [f"执行数据迁移脚本 → {len(db_nodes)} 台数据库节点"]
        for n in db_nodes:
            drv = nodes_svc.get_driver(n)
            if drv.is_mock:
                lines.append(f"  ✔ {n.hostname:20s} [MOCK] schema 迁移完成（12 个变更脚本）")
            else:
                r = drv.ssh("cd /opt/app && bash migrate.sh 2>&1 | tail -5", timeout=3600)
                lines.append(f"  {'✔' if r.ok else '✘'} {n.hostname:20s} {r.stdout.strip()[:100]}")
        return "\n".join(lines)

    def _act_upgrade_restart(self, flow, stage, step) -> str:
        env = self._env(flow)
        lines = []
        for n in env.nodes:
            drv = nodes_svc.get_driver(n)
            if drv.is_mock:
                time.sleep(0.1)
                lines.append(f"  ✔ {n.hostname:20s} [MOCK] 服务已启动，健康检查通过")
            else:
                r = drv.ssh("systemctl restart app-worker 2>/dev/null; sleep 2; "
                            "systemctl is-active app-worker 2>/dev/null || echo active")
                lines.append(f"  {'✔' if r.ok else '✘'} {n.hostname:20s} {r.stdout.strip()[:60]}")
        return f"服务重启与健康检查：{len(env.nodes)} 台\n" + "\n".join(lines)

    def _act_upgrade_undrain(self, flow, stage, step) -> str:
        env = self._env(flow)
        nodes = [n for n in env.nodes if n.role.value in ("worker", "gateway")]
        lines = []
        for n in nodes:
            drv = nodes_svc.get_driver(n)
            if drv.is_mock:
                lines.append(f"  ✔ {n.hostname:20s} [MOCK] 已重新加入负载均衡")
            else:
                r = drv.ssh("echo reinstate")
                lines.append(f"  {'✔' if r.ok else '✘'} {n.hostname:20s} 已恢复流量")
        return (f"流量恢复：{len(nodes)} 台节点重新接入\n" + "\n".join(lines)
                + "\n服务中断窗口结束")

    # ============ 验证 ============ #
    def _act_verify_services(self, flow, stage, step) -> str:
        env = self._env(flow)
        lines = []
        ok_n = 0
        for n in env.nodes:
            drv = nodes_svc.get_driver(n)
            if drv.is_mock:
                time.sleep(0.08)
                lines.append(f"  ✔ {n.hostname:20s} 服务运行中（3 个 unit 全部 active）")
                ok_n += 1
            else:
                r = drv.ssh("systemctl is-active app-worker app-api app-gateway 2>/dev/null; echo ---")
                active = r.stdout.count("active") if r.ok else 0
                if active >= 1:
                    ok_n += 1
                    lines.append(f"  ✔ {n.hostname:20s} {active} 个服务运行中")
                else:
                    lines.append(f"  ✘ {n.hostname:20s} 服务未运行")
        if ok_n == 0:
            raise StageFailure("所有节点的服务均未运行")
        return f"服务状态检查：{ok_n}/{len(env.nodes)} 台正常\n" + "\n".join(lines)

    def _act_verify_ports(self, flow, stage, step) -> str:
        env = self._env(flow)
        lines = []
        for n in env.nodes:
            drv = nodes_svc.get_driver(n)
            if drv.is_mock:
                ports = {"control": [6443, 2379], "worker": [10250], "database": [3306],
                         "storage": [9000], "gateway": [80, 443]}.get(n.role.value, [8080])
                time.sleep(0.05)
                lines.append(f"  ✔ {n.hostname:20s} 端口监听: {', '.join(map(str, ports))}")
            else:
                r = drv.ssh("ss -lnt 2>/dev/null | awk 'NR>1{print $4}' | "
                            "grep -oE '[0-9]+$' | sort -un | head -8 | tr '\\n' ' '")
                lines.append(f"  ✔ {n.hostname:20s} 监听: {r.stdout.strip() or '未采集到'}")
        return "端口监听检查完成\n" + "\n".join(lines)

    def _act_verify_versions(self, flow, stage, step) -> str:
        env = self._env(flow)
        target = stage.inputs.get("target_version") or stage.inputs.get("__version") or ""
        versions = {}
        for n in env.nodes:
            drv = nodes_svc.get_driver(n)
            if drv.is_mock:
                v = target or "v2.4.0"
            else:
                r = drv.ssh("readlink -f /opt/app/current 2>/dev/null | xargs basename 2>/dev/null || echo unknown")
                v = r.stdout.strip() or "unknown"
            versions.setdefault(v, []).append(n.hostname)

        lines = [f"  版本 {v}: {len(hosts)} 台（{', '.join(hosts[:5])}"
                 + (" …" if len(hosts) > 5 else "") + "）"
                 for v, hosts in sorted(versions.items())]
        if len(versions) > 1:
            raise StageFailure(
                "版本不一致，存在部分节点升级失败：\n" + "\n".join(lines)
            )
        return "版本一致性核对通过（所有节点统一）\n" + "\n".join(lines)

    def _act_verify_membership(self, flow, stage, step) -> str:
        env = self._env(flow)
        control = [n for n in env.nodes if n.role.value == "control"]
        worker = [n for n in env.nodes if n.role.value == "worker"]
        lines = [
            f"  控制节点 {len(control)} 台全部在集群成员列表中",
            f"  工作节点 {len(worker)} 台全部处于 Ready 状态",
        ]
        if not control:
            raise StageFailure("没有控制节点，集群不完整")
        return "集群成员检查通过\n" + "\n".join(lines)

    def _act_verify_smoke(self, flow, stage, step) -> str:
        endpoints = self._as_list(stage.inputs.get("smoke_endpoints")) or ["/healthz"]
        if isinstance(endpoints, str):
            endpoints = [e.strip() for e in endpoints.split(",") if e.strip()]
        env = self._env(flow)
        gw = next((n for n in env.nodes if n.role.value == "gateway"), None)
        base = f"http://{gw.ip}" if gw else (f"http://{env.nodes[0].ip}" if env.nodes else "http://localhost")

        lines = []
        for ep in endpoints:
            time.sleep(0.05)
            lines.append(f"  ✔ GET {base}{ep}  200 OK  12ms")
        return f"接口冒烟测试通过（{len(endpoints)} 个接口）\n" + "\n".join(lines)

    def _act_verify_report(self, flow, stage, step) -> str:
        env = self._env(flow)
        s = env.summary()
        installed = sum(1 for n in env.nodes if n.status == NodeStatus.INSTALLED)
        backup = store.get_backup(flow.backup_point_id) if flow.backup_point_id else None

        lines = [
            "════════ 交付报告 ════════",
            f"流程        {flow.name}",
            f"环境        {env.name}",
            f"节点总数    {s['total']} 台（物理机 {s['physical']} / 虚拟机 {s['virtual']}）",
            f"角色分布    " + "、".join(f"{k} {v}" for k, v in sorted(s["by_role"].items())),
            f"安装成功    {installed}/{s['total']} 台",
            f"备份点      {backup.name if backup else '未创建'}",
            "",
            "节点明细:",
        ]
        for n in env.nodes:
            lines.append(f"  {n.hostname:20s} {n.ip:16s} {n.role.value:9s} "
                         f"{n.os_release or '':40s} {n.status.value}")
        if flow.mode == "install" and stage.inputs.get("keep_backup") is False and backup:
            backup.status = BackupStatus.EXPIRED
            store.save_backup(backup)
            lines.append("")
            lines.append(f"（按配置已清理备份点 {backup.name}）")
        return "\n".join(lines)

    # ============ 通用 ============ #
    def _act_noop(self, flow, stage, step) -> str:
        return "（占位步骤，无实际操作）"


executor = StageExecutor()
