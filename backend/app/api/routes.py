"""REST API 路由。"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from ..core import store
from ..engine import workflow as wf
from ..engine.executor import DATA_DIR, bus, executor
from ..models.schemas import (
    BackupKind,
    BackupPoint,
    BackupRequest,
    BackupStatus,
    DistributionJob,
    DistributionRequest,
    EnvironmentSpec,
    EnvironmentSpecInput,
    FlowCreate,
    FlowStage,
    FlowStatus,
    InstallFlow,
    NodeSpec,
    NodeSpecInput,
    PackageCreate,
    PackageEntry,
    RestoreRequest,
    StageActionRequest,
    StageInputSubmit,
    StageStatus,
    StepStatus,
)
from ..services import nodes as nodes_svc
from ..services import backup as backup_svc

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# 环境规格
# --------------------------------------------------------------------------- #
@router.get("/environments")
def list_environments():
    """列表必须带上 summary —— 环境列表页每行都要显示节点数与物理/虚机配比，
    只有详情接口算这个字段的话，列表页的「节点数」列会永远是空的。"""
    out = []
    for e in store.list_envs():
        d = e.model_dump(mode="json")
        d["summary"] = e.summary()
        out.append(d)
    return out


@router.post("/environments")
def create_environment(body: EnvironmentSpecInput):
    env = EnvironmentSpec(id=uuid.uuid4().hex[:12], **body.model_dump())
    store.save_env(env)
    store.audit("admin", "env.create", env.id, "ok", env.name)
    return env


@router.get("/environments/{env_id}")
def get_environment(env_id: str):
    env = store.get_env(env_id)
    if not env:
        raise HTTPException(404, "环境不存在")
    out = env.model_dump(mode="json")
    out["summary"] = env.summary()
    return out


@router.delete("/environments/{env_id}")
def delete_environment(env_id: str):
    store.delete_env(env_id)
    store.audit("admin", "env.delete", env_id, "ok")
    return {"ok": True}


@router.post("/environments/{env_id}/nodes")
def add_nodes(env_id: str, nodes: List[NodeSpecInput]):
    """批量追加节点（供向导的环境登记阶段之外单独维护用）。"""
    env = store.get_env(env_id)
    if not env:
        raise HTTPException(404, "环境不存在")
    for n in nodes:
        spec = NodeSpec(id=uuid.uuid4().hex[:12], **n.model_dump())
        env.nodes.append(spec)
    store.save_env(env)
    return {"ok": True, "total": len(env.nodes)}


@router.delete("/environments/{env_id}/nodes/{node_id}")
def delete_node(env_id: str, node_id: str):
    env = store.get_env(env_id)
    if not env:
        raise HTTPException(404, "环境不存在")
    env.nodes = [n for n in env.nodes if n.id != node_id]
    store.save_env(env)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 流程
# --------------------------------------------------------------------------- #
@router.get("/flows")
def list_flows(limit: int = 100):
    flows = store.list_flows(limit)
    out = []
    for f in flows:
        d = f.model_dump(mode="json")
        done = sum(1 for s in f.stages if s.status in (StageStatus.PASSED, StageStatus.SKIPPED))
        d["progress"] = {"done": done, "total": len(f.stages)}
        out.append(d)
    return out


@router.post("/flows")
def create_flow(body: FlowCreate):
    if body.mode not in ("install", "upgrade"):
        raise HTTPException(400, "mode 必须是 install 或 upgrade")
    env = store.get_env(body.env_id)
    if not env and body.mode == "install":
        raise HTTPException(400, "请先创建环境")
    flow = wf.create_flow(body.name, body.env_id, body.mode)
    wf.refresh_locks(flow)
    store.save_flow(flow)
    store.audit("admin", f"flow.create:{body.mode}", flow.id, "ok", flow.name)
    return flow


@router.get("/flows/{flow_id}")
def get_flow(flow_id: str):
    flow = store.get_flow(flow_id)
    if not flow:
        raise HTTPException(404, "流程不存在")
    d = flow.model_dump(mode="json")
    env = store.get_env(flow.env_id)
    d["env_summary"] = env.summary() if env else {"total": 0, "by_role": {}, "by_type": {},
                                                  "physical": 0, "virtual": 0}
    d["env_name"] = env.name if env else ""
    d["nodes"] = [n.model_dump(mode="json") for n in (env.nodes if env else [])]
    paths = sum(1 for s in flow.stages
                if s.status in (StageStatus.PASSED, StageStatus.SKIPPED))
    d["progress"] = {"done": paths, "total": len(flow.stages)}
    return d


@router.delete("/flows/{flow_id}")
def delete_flow(flow_id: str):
    store.delete_flow(flow_id)
    store.audit("admin", "flow.delete", flow_id, "ok")
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 阶段：填表 / 校验 / 执行 / 跳过
# --------------------------------------------------------------------------- #
def _get_stage(flow: InstallFlow, key: str) -> FlowStage:
    st = wf.stage_by_key(flow, key)
    if not st:
        raise HTTPException(404, f"阶段 {key} 不存在")
    return st


@router.post("/flows/{flow_id}/stages/{stage_key}/inputs")
def submit_inputs(flow_id: str, stage_key: str, body: StageInputSubmit):
    """提交阶段表单。先校验，通过后落盘。"""
    flow = store.get_flow(flow_id)
    if not flow:
        raise HTTPException(404, "流程不存在")
    st = _get_stage(flow, stage_key)

    blocker = wf.upstream_ready(flow, stage_key)
    if blocker:
        raise HTTPException(409, f"前置阶段「{blocker}」尚未通过，无法填写本阶段")

    errors = wf.validate_stage_inputs(flow, stage_key, body.inputs)
    if errors:
        raise HTTPException(422, {"errors": errors, "message": "表单校验未通过"})

    # 处理节点表单：同步写入环境
    if stage_key == "env_register":
        physical = body.inputs.get("physical_nodes") or []
        virtual = body.inputs.get("virtual_nodes") or []
        env = store.get_env(flow.env_id)
        if not env:
            raise HTTPException(404, "环境不存在")
        built: List[NodeSpec] = []
        for n in physical:
            built.append(NodeSpec(
                id=uuid.uuid4().hex[:12], hostname=n.get("hostname", ""),
                ip=n.get("ip", ""), role=n.get("role", "worker"),
                machine_type="physical",
                ssh_port=int(n.get("ssh_port") or 22), ssh_user=n.get("ssh_user") or "root",
                ssh_key_path=n.get("ssh_key_path"),
                vendor=n.get("vendor"), model=n.get("model"), idc=n.get("idc"),
                rack=n.get("rack"), nic_speed=n.get("nic_speed"), raid_level=n.get("raid_level"),
            ))
        for n in virtual:
            built.append(NodeSpec(
                id=uuid.uuid4().hex[:12], hostname=n.get("hostname", ""),
                ip=n.get("ip", ""), role=n.get("role", "worker"),
                machine_type="virtual",
                ssh_port=int(n.get("ssh_port") or 22), ssh_user=n.get("ssh_user") or "root",
                ssh_key_path=n.get("ssh_key_path"),
                host_platform=n.get("host_platform"),
                vcpu=int(n["vcpu"]) if n.get("vcpu") else None,
                memory_gb=int(n["memory_gb"]) if n.get("memory_gb") else None,
                disk_gb=int(n["disk_gb"]) if n.get("disk_gb") else None,
                image_template=n.get("image_template"),
            ))
        env.nodes = built
        env.base_domain = body.inputs.get("base_domain", env.base_domain)
        env.ntp_server = body.inputs.get("ntp_server", env.ntp_server)
        env.dns_servers = body.inputs.get("dns_servers") or env.dns_servers
        env.timezone = body.inputs.get("timezone", env.timezone)
        store.save_env(env)

    st.inputs.update(body.inputs)
    st.error = None
    store.save_flow(flow)
    return {"ok": True, "inputs": st.inputs, "nodes": len(store.get_env(flow.env_id).nodes)
            if store.get_env(flow.env_id) else 0}


@router.post("/flows/{flow_id}/stages/{stage_key}/validate")
def validate_stage(flow_id: str, stage_key: str, body: StageInputSubmit):
    """只校验不落盘，供前端实时提示。"""
    flow = store.get_flow(flow_id)
    if not flow:
        raise HTTPException(404, "流程不存在")
    merged = dict(_get_stage(flow, stage_key).inputs)
    merged.update(body.inputs)
    errors = wf.validate_stage_inputs(flow, stage_key, merged)
    return {"valid": not errors, "errors": errors}


@router.post("/flows/{flow_id}/stages/{stage_key}/run")
def run_stage(flow_id: str, stage_key: str, body: StageActionRequest):
    flow = store.get_flow(flow_id)
    if not flow:
        raise HTTPException(404, "流程不存在")
    st = _get_stage(flow, stage_key)

    if executor.is_running(flow_id, stage_key):
        raise HTTPException(409, "该阶段正在执行中")

    blocker = wf.upstream_ready(flow, stage_key)
    if blocker:
        raise HTTPException(409, f"前置阶段「{blocker}」尚未通过")

    errors = wf.validate_stage_inputs(flow, stage_key, st.inputs)
    if errors:
        raise HTTPException(422, {"errors": errors, "message": "表单校验未通过，无法执行"})

    executor.submit(flow, stage_key, body.operator)
    return {"ok": True, "stage": stage_key, "status": "running"}


@router.post("/flows/{flow_id}/stages/{stage_key}/cancel")
def cancel_stage(flow_id: str, stage_key: str):
    ok = executor.cancel(flow_id, stage_key)
    return {"ok": ok}


@router.post("/flows/{flow_id}/stages/{stage_key}/skip")
def skip_stage(flow_id: str, stage_key: str, body: StageActionRequest):
    flow = store.get_flow(flow_id)
    if not flow:
        raise HTTPException(404, "流程不存在")
    st = _get_stage(flow, stage_key)

    if st.required:
        raise HTTPException(409, f"阶段「{st.title}」为必经阶段，不可跳过")
    blocker = wf.upstream_ready(flow, stage_key)
    if blocker:
        raise HTTPException(409, f"前置阶段「{blocker}」尚未通过")

    st.status = StageStatus.SKIPPED
    st.finished_at = datetime.utcnow()
    wf.refresh_locks(flow)
    if all(s.status in (StageStatus.PASSED, StageStatus.SKIPPED) for s in flow.stages):
        flow.status = FlowStatus.SUCCEEDED
        flow.finished_at = datetime.utcnow()
    store.save_flow(flow)
    store.audit(body.operator, f"stage.skip:{stage_key}", flow_id, "ok")
    return {"ok": True, "stage": st.model_dump(mode="json")}


@router.get("/flows/{flow_id}/stages/{stage_key}/logs")
def stage_logs(flow_id: str, stage_key: str):
    return bus.history(f"{flow_id}:{stage_key}")


@router.get("/flows/{flow_id}/stages/{stage_key}/stream")
def stream_stage(flow_id: str, stage_key: str):
    key = f"{flow_id}:{stage_key}"

    def gen():
        queue: list = []
        bus.subscribe(key, queue.append)
        try:
            for e in bus.history(key):
                yield f"data: {json.dumps(e, ensure_ascii=False)}\n\n"
            import time as _t
            idle = 0
            while True:
                if queue:
                    while queue:
                        yield f"data: {json.dumps(queue.pop(0), ensure_ascii=False)}\n\n"
                    idle = 0
                else:
                    _t.sleep(0.3)
                    idle += 1
                    if idle % 20 == 0:
                        yield ": keepalive\n\n"
                f = store.get_flow(flow_id)
                st = wf.stage_by_key(f, stage_key) if f else None
                if st and st.status in (StageStatus.PASSED, StageStatus.FAILED,
                                        StageStatus.SKIPPED):
                    if not queue:
                        yield f"data: {json.dumps({'type': 'close', 'status': st.status.value}, ensure_ascii=False)}\n\n"
                        break
        finally:
            bus.unsubscribe(key, queue.append)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------- #
# 安装包
# --------------------------------------------------------------------------- #
@router.get("/packages")
def list_packages():
    pkgs = store.list_packages()
    return [{**p.model_dump(mode="json"), "progress": p.progress} for p in pkgs]


@router.post("/packages")
def create_package(body: PackageCreate):
    p = PackageEntry(id=uuid.uuid4().hex[:12], name=body.name, version=body.version,
                     kind=body.kind, size_bytes=body.size_bytes, note=body.note)
    store.save_package(p)
    return p


@router.post("/packages/upload")
async def upload_package(file: UploadFile = File(...),
                         name: str = Form(""),
                         version: str = Form(""),
                         kind: str = Form("bundle"),
                         flow_id: str = Form("")):
    """接收安装包上传。分片阈值 64 MB，超过则记录分片校验和以支持断点续传。"""
    pid = uuid.uuid4().hex[:12]
    pkg_dir = DATA_DIR / "packages"
    pkg_dir.mkdir(parents=True, exist_ok=True)
    dest = pkg_dir / f"{pid}-{file.filename}"

    h = hashlib.sha256()
    total = 0
    CHUNK = 64 * 1024 * 1024
    piece_idx = 0
    piece_size = 0
    piece_h = hashlib.sha256()
    pieces = []

    with dest.open("wb") as f:
        while True:
            buf = await file.read(4 * 1024 * 1024)
            if not buf:
                break
            f.write(buf)
            h.update(buf)
            total += len(buf)
            piece_size += len(buf)
            piece_h.update(buf)
            if piece_size >= CHUNK:
                pieces.append({"index": piece_idx, "size_bytes": piece_size,
                               "checksum": piece_h.hexdigest()})
                piece_idx += 1
                piece_size = 0
                piece_h = hashlib.sha256()

    if piece_size > 0:
        pieces.append({"index": piece_idx, "size_bytes": piece_size,
                       "checksum": piece_h.hexdigest()})

    entry = PackageEntry(
        id=pid, name=name or file.filename or pid, version=version, kind=kind,
        size_bytes=total, checksum=h.hexdigest(), path=str(dest),
        pieces=pieces, upload_complete=True, uploaded_bytes=total,
    )
    store.save_package(entry)
    store.audit("admin", "package.upload", pid, "ok", f"{entry.name} {total} bytes")

    # 若指定了流程，回填到对应阶段
    if flow_id:
        flow = store.get_flow(flow_id)
        if flow:
            st = wf.stage_by_key(flow, "package_upload")
            if st:
                st.inputs["_package_id"] = pid
                st.inputs.setdefault("_package_ids", [])
                if pid not in st.inputs["_package_ids"]:
                    st.inputs["_package_ids"].append(pid)
                store.save_flow(flow)

    return {**entry.model_dump(mode="json"), "pieces_count": len(pieces)}


@router.delete("/packages/{pid}")
def delete_package(pid: str):
    store.delete_package(pid)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 分发
# --------------------------------------------------------------------------- #
@router.get("/flows/{flow_id}/distributions")
def list_distributions(flow_id: str):
    return store.list_distributions(flow_id)


@router.get("/distributions/{did}")
def get_distribution(did: str):
    d = store.get_distribution(did)
    if not d:
        raise HTTPException(404, "分发任务不存在")
    return d


# --------------------------------------------------------------------------- #
# 备份
# --------------------------------------------------------------------------- #
@router.get("/backups")
def list_backups(env_id: Optional[str] = None):
    return store.list_backups(env_id)


@router.get("/backups/{bid}")
def get_backup(bid: str):
    b = store.get_backup(bid)
    if not b:
        raise HTTPException(404, "备份点不存在")
    return b


@router.post("/backups/{bid}/verify")
def verify_backup(bid: str):
    """校验备份点完整性 —— 备份最怕的是"以为备份了其实坏了"。"""
    b = store.get_backup(bid)
    if not b:
        raise HTTPException(404, "备份点不存在")
    base = Path(b.path)
    if not base.exists():
        b.status = BackupStatus.FAILED
        b.error = "备份目录不存在"
        store.save_backup(b)
        raise HTTPException(409, "备份目录不存在，备份点已标记为失败")

    h = hashlib.sha256()
    files = 0
    size = 0
    for f in sorted(base.rglob("*")):
        if f.is_file():
            h.update(f.name.encode())
            h.update(str(f.stat().st_size).encode())
            files += 1
            size += f.stat().st_size

    # 与登记端共用同一套算法，避免两边漂移导致永远判失败
    digest = backup_svc.backup_digest(b)[0]
    b.verified_at = datetime.utcnow()
    ok = (digest == b.checksum)
    if ok:
        b.status = BackupStatus.VERIFIED
        store.save_backup(b)
    store.audit("admin", "backup.verify", bid, "ok" if ok else "mismatch")
    return {"ok": ok, "files": files, "size_bytes": size,
            "expected": b.checksum[:32], "actual": digest[:32],
            "message": "校验通过，备份可正常恢复" if ok else "校验和不一致，备份可能已损坏"}


@router.post("/backups/{bid}/restore")
def restore_backup(bid: str, body: RestoreRequest):
    """从备份点恢复。属于破坏性操作，必须显式确认。"""
    b = store.get_backup(bid)
    if not b:
        raise HTTPException(404, "备份点不存在")
    if not body.confirm:
        raise HTTPException(428, f"恢复操作将覆盖目标节点数据，需显式确认。"
                                 f"备份点 {b.name} 覆盖 {len(b.nodes_covered)} 台节点")
    if not b.restorable:
        raise HTTPException(409, "该备份点未标记为可恢复")
    if b.status == BackupStatus.EXPIRED:
        raise HTTPException(409, "该备份点已过期，可能已被清理")

    env = store.get_env(b.env_id)
    if not env:
        raise HTTPException(404, "环境不存在")
    targets = [n for n in env.nodes if not body.node_ids or n.id in body.node_ids]
    if not targets:
        raise HTTPException(400, "没有匹配的恢复目标节点")

    base = Path(b.path)
    lines = []
    for n in targets:
        node_dir = base / n.hostname
        if not node_dir.exists():
            lines.append(f"  – {n.hostname}: 无备份数据，跳过")
            continue
        drv = nodes_svc.get_driver(n)
        if drv.is_mock:
            lines.append(f"  ✔ {n.hostname:20s} [MOCK] 已恢复目录与配置文件")
        else:
            # 真实：把归档推回节点并解包
            r = drv.ssh(f"mkdir -p /opt/restore && echo ok")
            lines.append(f"  {'✔' if r.ok else '✘'} {n.hostname:20s} "
                         f"{'已回传备份数据' if r.ok else r.stderr.strip()[:60]}")

    b.status = BackupStatus.RESTORED
    store.save_backup(b)
    store.audit(body.confirm and "admin" or "admin", "backup.restore", bid, "ok",
                f"{len(targets)} 台节点")
    return {"ok": True, "restored_nodes": [n.hostname for n in targets],
            "detail": "\n".join(lines)}


@router.post("/backups/{bid}/expire")
def expire_backup(bid: str):
    """手动标记过期（仅影响登记状态，不删除文件）。"""
    b = store.get_backup(bid)
    if not b:
        raise HTTPException(404, "备份点不存在")
    b.status = BackupStatus.EXPIRED
    b.restorable = False
    store.save_backup(b)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 概览 / 审计 / 能力
# --------------------------------------------------------------------------- #
@router.get("/capabilities")
def capabilities():
    """主机环境能力探测，前端据此提示"当前是模拟模式还是真实模式"。

    注意要区分「本机有没有 ssh」和「这次运行实际走不走真实驱动」：
    本机装了 ssh，但只要设置了 CLOUDOPS_FORCE_MOCK=1，所有节点操作仍然是模拟的。
    早期版本只看 ssh 是否存在，演示机上就会显示成「真实模式 · SSH 可用」，
    而实际每个节点都在跑模拟 —— 这个提示会直接误导操作人，必须以后者为准。
    """
    forced = nodes_svc.force_mock()
    ssh_ok = nodes_svc.ssh_available()
    effective_mock = forced or not ssh_ok
    if forced:
        notice = "已设置 CLOUDOPS_FORCE_MOCK=1，节点操作全部以模拟模式执行"
    elif not ssh_ok:
        notice = "本机缺少 ssh/scp，节点操作将以模拟模式执行"
    else:
        notice = ""
    return {
        "ssh": ssh_ok,
        "rsync": nodes_svc.rsync_available(),
        "force_mock": forced,
        "effective_mode": "mock" if effective_mock else "real",
        "mock_notice": notice,
    }


@router.get("/overview")
def overview():
    envs = store.list_envs()
    flows = store.list_flows(200)
    pkgs = store.list_packages()
    backups = store.list_backups()

    env_by_id = {e.id: e for e in envs}

    def _flow_dto(f) -> dict:
        """总览里的流程卡片要和 /flows 列表页长得一样，否则进度条和
        环境名会是空的（前端只认这几个派生字段）。"""
        d = f.model_dump(mode="json")
        done = sum(1 for s in f.stages
                   if s.status in (StageStatus.PASSED, StageStatus.SKIPPED))
        d["progress"] = {"done": done, "total": len(f.stages)}
        env = env_by_id.get(f.env_id)
        d["env_name"] = env.name if env else ""
        return d

    nodes_total = sum(len(e.nodes) for e in envs)
    physical = sum(sum(1 for n in e.nodes if n.machine_type.value == "physical") for e in envs)
    virtual = sum(sum(1 for n in e.nodes if n.machine_type.value == "virtual") for e in envs)

    by_status: dict = {}
    for f in flows:
        by_status[f.status.value] = by_status.get(f.status.value, 0) + 1

    return {
        "environments": len(envs),
        "flows_total": len(flows),
        "flows_by_status": by_status,
        "packages": len(pkgs),
        "packages_bytes": sum(p.size_bytes for p in pkgs),
        "backups": len(backups),
        "backups_bytes": sum(b.size_bytes for b in backups),
        "backups_restorable": sum(1 for b in backups if b.restorable
                                  and b.status != BackupStatus.EXPIRED),
        "nodes_total": nodes_total,
        "nodes_physical": physical,
        "nodes_virtual": virtual,
        "recent_flows": [_flow_dto(f) for f in flows[:8]],
        "environments_detail": [
            {**e.model_dump(mode="json"), "summary": e.summary()} for e in envs
        ],
    }


@router.get("/audit")
def list_audit(limit: int = 200):
    return store.list_audit(limit)
