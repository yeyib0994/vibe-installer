"""流程编排引擎。

这是本工具的核心：把「安装」拆成有序阶段，每个阶段有
  1) 输入表单（form_fields，前端据此渲染）
  2) 前置校验（前置阶段的产物必须齐备，否则 LOCKED）
  3) 阶段内的执行步骤（steps）

阶段推进规则
------------
- 阶段 0 初始为 READY，其余为 LOCKED
- 只有前一阶段 PASSED，本阶段才变 READY
- 执行阶段用 executor；用户填写阶段用 submit_inputs
- required=False 的阶段可 SKIP

安装（install）七阶段：
  1. 环境登记      填节点矩阵（物理机/虚机分组）
  2. 环境校验      SSH 探活 + 系统预检（依赖/端口/内核参数）
  3. 上传安装包    上传到控制台暂存区，登记清单
  4. 包分发        把包推到各节点（scp/rsync），校验 sha256
  5. 安装前备份    对已有数据做备份点（新装环境可跳过）
  6. 执行安装      按节点角色分派组件，逐节点安装
  7. 安装后验证    服务健康检查 + 版本核对 + 生成交付报告

升级（upgrade）五阶段：
  1. 环境登记  → 2. 环境校验 → 3. 升级前备份 → 4. 执行升级 → 5. 升级后验证
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from ..models.schemas import (
    FlowStage,
    FlowStep,
    FlowStatus,
    InstallFlow,
    StageStatus,
    StepStatus,
)


def _sid() -> str:
    return uuid.uuid4().hex[:12]


def _step(index: int, title: str, detail: str, action: str,
          args: Optional[Dict[str, Any]] = None) -> FlowStep:
    return FlowStep(id=_sid(), index=index, title=title, detail=detail,
                    action=action, args=args or {})


def _field(key: str, label: str, ftype: str = "text", required: bool = True,
           default: Any = None, options: Optional[List[str]] = None,
           placeholder: str = "", help_text: str = "",
           multiline_list: bool = False,
           groups: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """描述一个表单字段，前端据此渲染。

    multiline_list=True 表示该字段在 UI 上是多行文本，每行一个条目，
    提交时转成数组（如 include_paths / include_databases）。
    groups 仅用于 node_table：声明按硬件类型分组的列定义。
    """
    f: Dict[str, Any] = {
        "key": key, "label": label, "type": ftype,
        "required": required, "placeholder": placeholder, "help": help_text,
        "hint": help_text,
    }
    if default is not None:
        f["default"] = default
    if options:
        f["options"] = [{"value": o, "label": o} for o in options]
    if multiline_list:
        f["multiline_list"] = True
    if groups:
        f["groups"] = groups
    return f


# 节点矩阵列定义（供前端渲染表头；后端不依赖它做校验）
PHYSICAL_COLUMNS: List[Dict[str, Any]] = [
    {"key": "hostname", "label": "主机名", "width": 130},
    {"key": "ip", "label": "IP", "width": 118},
    {"key": "role", "label": "角色", "type": "role", "width": 104},
    {"key": "vendor", "label": "厂商", "width": 92},
    {"key": "model", "label": "型号", "width": 158},
    {"key": "idc", "label": "机房", "width": 104},
    {"key": "rack", "label": "机柜", "width": 78},
    {"key": "nic_speed", "label": "网卡", "width": 78},
    {"key": "raid_level", "label": "RAID", "width": 78},
    {"key": "ssh_key_path", "label": "SSH 私钥", "width": 168},
]
VIRTUAL_COLUMNS: List[Dict[str, Any]] = [
    {"key": "hostname", "label": "主机名", "width": 130},
    {"key": "ip", "label": "IP", "width": 118},
    {"key": "role", "label": "角色", "type": "role", "width": 104},
    {"key": "host_platform", "label": "虚拟化平台", "width": 160},
    {"key": "vcpu", "label": "vCPU", "type": "number", "width": 68},
    {"key": "memory_gb", "label": "内存 GB", "type": "number", "width": 80},
    {"key": "disk_gb", "label": "磁盘 GB", "type": "number", "width": 80},
    {"key": "image_template", "label": "镜像模板", "width": 148},
    {"key": "ssh_key_path", "label": "SSH 私钥", "width": 168},
]


# --------------------------------------------------------------------------- #
# 阶段定义：安装
# --------------------------------------------------------------------------- #
def build_install_stages() -> List[FlowStage]:
    return [
        # ---------------- 1. 环境登记 ---------------- #
        FlowStage(
            key="env_register", index=0,
            title="环境登记",
            description="按机器形态分组登记节点。物理机填型号与机房，虚机填规格与镜像模板。"
                        "安装组件会根据节点角色自动分派。",
            form_fields=[
                _field("base_domain", "基础域名", required=False,
                       help_text="用于生成各服务的访问域名，可留空"),
                _field("ntp_server", "NTP 服务器", required=False,
                       placeholder="ntp.internal.com"),
                _field("dns_servers", "DNS 服务器", required=False,
                       placeholder="每行一个，如 10.0.0.10", multiline_list=True),
                _field("timezone", "时区", default="Asia/Shanghai", required=False),
                _field("control_count", "控制节点数", ftype="number", default=3,
                       help_text="建议 3 或 5 台以保证高可用"),
                _field("worker_count", "工作节点数", ftype="number", default=5),
                _field("physical_nodes", "物理机列表", ftype="node_table",
                       required=False, default=[],
                       help_text="逐台填写：主机名 / IP / 角色 / 品牌型号 / 机房机架 / 网卡 / RAID",
                       groups=[{"key": "physical_nodes", "title": "物理机节点",
                                "fields": PHYSICAL_COLUMNS}]),
                _field("virtual_nodes", "虚拟机列表", ftype="node_table",
                       required=False, default=[],
                       help_text="逐台填写：主机名 / IP / 角色 / 虚拟化平台 / vCPU / 内存 / 磁盘 / 镜像模板",
                       groups=[{"key": "virtual_nodes", "title": "虚拟机节点",
                                "fields": VIRTUAL_COLUMNS}]),
            ],
            required=True,
            steps=[
                _step(0, "校验节点矩阵", "检查 IP 唯一性、角色覆盖、必填项完整性",
                      "env.validate_matrix"),
                _step(1, "生成节点清单", "按角色展开为待安装节点列表，落库",
                      "env.persist_nodes"),
            ],
        ),
        # ---------------- 2. 环境校验 ---------------- #
        FlowStage(
            key="env_precheck", index=1,
            title="环境校验",
            description="逐节点 SSH 探活并采集系统信息，执行安装前预检"
                        "（内核参数、依赖命令、端口占用、磁盘、时间同步、SELinux）。",
            form_fields=[
                _field("ssh_user", "统一 SSH 用户", default="root"),
                _field("ssh_port", "SSH 端口", ftype="number", default=22),
                _field("ssh_key_path", "SSH 私钥路径", required=False,
                       placeholder="留空则使用模拟模式，不真实连接节点",
                       help_text="有私钥时调用系统 ssh；留空则模拟执行，用于方案预演"),
                _field("strict_mode", "严格模式", ftype="boolean", default=False,
                       help_text="开启后，任一节点预检不通过即阻断流程"),
            ],
            required=True,
            steps=[
                _step(0, "SSH 连通性探测", "逐节点建连并采集主机名 / 内核 / 系统版本",
                      "precheck.connect"),
                _step(1, "系统预检", "检查依赖命令、端口占用、磁盘空间、时间同步、SELinux",
                      "precheck.system"),
                _step(2, "生成校验报告", "汇总各节点问题并给出修复建议",
                      "precheck.report"),
            ],
        ),
        # ---------------- 3. 上传安装包 ---------------- #
        FlowStage(
            key="package_upload", index=2,
            title="上传安装包",
            description="把安装包上传到控制台暂存区。大包会分片上传以便断点续传，"
                        "上传完成后计算整包 SHA256 供分发校验。",
            form_fields=[
                _field("package_kind", "包类型", ftype="select",
                       default="bundle",
                       options=["bundle", "image", "config", "patch"],
                       help_text="bundle=离线安装包，image=容器镜像，patch=补丁"),
                _field("package_version", "版本号", placeholder="v2.4.0"),
                _field("expected_size", "预计大小（字节）", ftype="number",
                       required=False, help_text="用于上传进度校验，留空则自动读取"),
            ],
            required=True,
            steps=[
                _step(0, "上传到暂存区", "接收文件流并落盘，计算 SHA256",
                      "package.receive"),
                _step(1, "分片与校验", "按 64MB 切分记录分片校验和，支持断点续传",
                      "package.chunk"),
                _step(2, "登记包清单", "写入包目录，供后续分发引用",
                      "package.register"),
            ],
        ),
        # ---------------- 4. 包分发 ---------------- #
        FlowStage(
            key="package_distribute", index=3,
            title="包分发",
            description="把安装包推送到各目标节点。默认 rsync（支持断点续传），"
                        "推送后逐节点比对 SHA256 确保传输无损。",
            form_fields=[
                _field("remote_dir", "节点目标目录", default="/opt/packages"),
                _field("mode", "传输方式", ftype="select", default="rsync",
                       options=["rsync", "scp"],
                       help_text="rsync 支持断点续传与增量，大包推荐"),
                _field("concurrency", "并发数", ftype="number", default=4,
                       help_text="同时传输的节点数，受带宽限制"),
                _field("verify_checksum", "传输后校验 SHA256", ftype="boolean", default=True),
                _field("target_roles", "分发到哪些角色", ftype="multiselect",
                       default=["control", "worker", "database", "storage", "gateway"],
                       options=["control", "worker", "database", "storage", "gateway"]),
            ],
            required=True,
            steps=[
                _step(0, "连接目标节点", "确认各节点可达且目标目录可写",
                      "distribute.connect"),
                _step(1, "并发推送安装包", "按并发数分批推送，实时汇报进度",
                      "distribute.push"),
                _step(2, "校验远端完整性", "逐节点比对 SHA256，不一致则重传",
                      "distribute.verify"),
            ],
        ),
        # ---------------- 5. 安装前备份 ---------------- #
        FlowStage(
            key="pre_install_backup", index=4,
            title="安装前备份",
            description="对环境中已有数据做备份点，用于安装失败时恢复。"
                        "全新环境无历史数据，可跳过本阶段。",
            form_fields=[
                _field("backup_name", "备份点名称", required=False,
                       placeholder="留空则自动生成"),
                _field("include_paths", "备份目录", ftype="textarea",
                       default=["/etc", "/var/lib", "/opt/data"], required=False,
                       placeholder="每行一个目录",
                       multiline_list=True,
                       help_text="将被归档的目录，与数据库至少填一项"),
                _field("include_databases", "备份数据库", ftype="textarea",
                       required=False, placeholder="每行一个实例名，如 appdb",
                       multiline_list=True,
                       help_text="按实例名在数据库节点上执行逻辑备份"),
                _field("include_config", "包含配置文件", ftype="boolean", default=True),
                _field("retention_days", "保留天数", ftype="number", default=30,
                       help_text="超过保留期的备份点会被标记为过期，可清理释放空间"),
            ],
            required=False,
            steps=[
                _step(0, "确认备份范围", "列出将被备份的目录、数据库实例与目标节点",
                      "backup.scope"),
                _step(1, "执行文件归档", "逐节点打包目录，计算校验和",
                      "backup.archive"),
                _step(2, "执行数据库逻辑备份", "对数据库节点执行 dump 并回传到控制台",
                      "backup.database"),
                _step(3, "登记备份点", "写入备份目录，设置过期时间，生成回滚基线",
                      "backup.register"),
            ],
        ),
        # ---------------- 6. 执行安装 ---------------- #
        FlowStage(
            key="install_execute", index=5,
            title="执行安装",
            description="按节点角色分派组件并安装。控制节点装管理组件，"
                        "工作节点装运行组件，数据库/存储节点装数据组件。"
                        "任一节点失败会停止后续节点并给出回滚入口。",
            form_fields=[
                _field("install_mode", "安装模式", ftype="select", default="full",
                       options=["full", "incremental", "repair"],
                       help_text="full=整装，incremental=增量，repair=修复重装"),
                _field("stop_on_failure", "失败即停", ftype="boolean", default=True,
                       help_text="关闭则继续处理剩余节点并汇总失败清单"),
                _field("parallel_workers", "工作节点并发度", ftype="number", default=3),
                _field("skip_components", "跳过的组件", ftype="textarea",
                       required=False, placeholder="每行一个组件名",
                       multiline_list=True),
            ],
            required=True,
            steps=[
                _step(0, "分发前置检查", "确认所有节点已收到安装包且校验通过",
                      "install.precheck"),
                _step(1, "安装控制面组件", "在控制节点安装管理服务并初始化集群",
                      "install.control_plane"),
                _step(2, "安装数据面组件", "在数据库与存储节点初始化数据服务",
                      "install.data_plane"),
                _step(3, "安装工作节点组件", "在工作节点安装运行组件并加入集群",
                      "install.workers"),
                _step(4, "安装网关组件", "配置接入层、证书与负载均衡",
                      "install.gateway"),
            ],
        ),
        # ---------------- 7. 安装后验证 ---------------- #
        FlowStage(
            key="post_verify", index=6,
            title="安装后验证",
            description="逐项验证安装结果：服务状态、端口监听、版本一致性、"
                        "集群成员、核心接口连通性，最后生成交付报告。",
            form_fields=[
                _field("smoke_endpoints", "冒烟测试接口（逗号分隔）", required=False,
                       default=["/healthz", "/api/v1/version"]),
                _field("verify_cluster", "校验集群成员一致性", ftype="boolean", default=True),
                _field("keep_backup", "保留安装前备份点", ftype="boolean", default=True,
                       help_text="关闭则在验证通过后清理备份以释放空间"),
            ],
            required=True,
            steps=[
                _step(0, "服务状态检查", "逐节点检查系统服务与进程状态",
                      "verify.services"),
                _step(1, "端口监听检查", "确认关键端口处于监听状态",
                      "verify.ports"),
                _step(2, "版本一致性核对", "比对各节点组件版本是否统一",
                      "verify.versions"),
                _step(3, "集群成员检查", "确认所有节点已正确加入集群",
                      "verify.membership"),
                _step(4, "接口冒烟测试", "对核心接口发起请求验证可用性",
                      "verify.smoke"),
                _step(5, "生成交付报告", "汇总安装结果、节点清单与遗留问题",
                      "verify.report"),
            ],
        ),
    ]


# --------------------------------------------------------------------------- #
# 阶段定义：升级
# --------------------------------------------------------------------------- #
def build_upgrade_stages() -> List[FlowStage]:
    return [
        FlowStage(
            key="env_register", index=0,
            title="环境确认",
            description="确认待升级环境的节点清单。可从已有环境导入，也可重新登记。",
            form_fields=[
                _field("source_env_id", "从已有环境导入", ftype="select",
                       required=False, options=[],
                       help_text="选择后自动载入该环境的节点矩阵"),
                _field("target_version", "目标版本", placeholder="v2.5.0"),
            ],
            required=True, steps=[
                _step(0, "校验节点矩阵", "确认节点信息完整且角色覆盖正确",
                      "env.validate_matrix"),
                _step(1, "锁定升级目标", "记录当前版本作为回退基线", "env.persist_nodes"),
            ],
        ),
        FlowStage(
            key="env_precheck", index=1,
            title="环境校验",
            description="升级前检查：磁盘余量（升级需额外空间）、版本兼容性、服务健康度。",
            form_fields=[
                _field("ssh_user", "统一 SSH 用户", default="root"),
                _field("ssh_port", "SSH 端口", ftype="number", default=22),
                _field("ssh_key_path", "SSH 私钥路径", required=False),
                _field("check_compat", "检查版本兼容性", ftype="boolean", default=True),
            ],
            required=True, steps=[
                _step(0, "SSH 连通性探测", "逐节点建连", "precheck.connect"),
                _step(1, "升级就绪度检查", "磁盘余量、服务健康、版本兼容性",
                      "precheck.upgrade_ready"),
            ],
        ),
        FlowStage(
            key="pre_upgrade_backup", index=2,
            title="升级前备份",
            description="升级前必须建立数据备份基线，升级失败时从这里恢复。"
                        "强烈建议不要跳过。",
            form_fields=[
                _field("backup_name", "备份点名称", required=False),
                _field("include_paths", "备份目录", ftype="textarea",
                       default=["/etc", "/var/lib", "/opt/data"], required=False,
                       placeholder="每行一个目录",
                       multiline_list=True,
                       help_text="将被归档的目录，与数据库至少填一项"),
                _field("include_databases", "备份数据库", ftype="textarea",
                       required=False, placeholder="每行一个实例名",
                       multiline_list=True),
                _field("include_config", "包含配置文件", ftype="boolean", default=True),
                _field("retention_days", "保留天数", ftype="number", default=30),
            ],
            required=True, steps=[
                _step(0, "确认备份范围", "列出备份内容与目标节点", "backup.scope"),
                _step(1, "执行文件归档", "逐节点打包", "backup.archive"),
                _step(2, "执行数据库逻辑备份", "dump 并回传", "backup.database"),
                _step(3, "登记并标记回滚基线", "写入备份目录，标记为可回滚",
                      "backup.register"),
            ],
        ),
        FlowStage(
            key="upgrade_execute", index=3,
            title="执行升级",
            description="按节点角色分批升级。控制面先升，数据面后升，"
                        "工作节点滚动升级。每批之间做健康检查。",
            form_fields=[
                _field("strategy", "升级策略", ftype="select", default="rolling",
                       options=["rolling", "batch", "blue-green"],
                       help_text="rolling=滚动，batch=分批停机，blue-green=蓝绿"),
                _field("batch_size", "批量大小", ftype="number", default=1),
                _field("pause_between_batches", "批次间暂停（秒）", ftype="number", default=30),
                _field("auto_rollback", "失败自动回滚", ftype="boolean", default=True),
            ],
            required=True, steps=[
                _step(0, "停服与流量摘除", "将节点从负载均衡摘除并等待连接排空",
                      "upgrade.drain"),
                _step(1, "备份当前版本", "保存可执行文件与配置，便于快速回退",
                      "upgrade.snapshot"),
                _step(2, "替换安装包", "解压新版本包并切换软链接", "upgrade.replace"),
                _step(3, "执行数据迁移", "运行版本间的 schema 变更脚本",
                      "upgrade.migrate_data"),
                _step(4, "启动并健康检查", "拉起服务并确认健康", "upgrade.restart"),
                _step(5, "恢复流量", "将节点重新加入负载均衡", "upgrade.undrain"),
            ],
        ),
        FlowStage(
            key="post_verify", index=4,
            title="升级后验证",
            description="验证升级结果，比对版本，确认集群功能正常。",
            form_fields=[
                _field("smoke_endpoints", "冒烟测试接口（逗号分隔）", required=False,
                       default=["/healthz", "/api/v1/version"]),
                _field("verify_cluster", "校验集群成员一致性", ftype="boolean", default=True),
                _field("keep_backup", "保留升级前备份点", ftype="boolean", default=True),
            ],
            required=True, steps=[
                _step(0, "服务状态检查", "逐节点检查服务状态", "verify.services"),
                _step(1, "版本一致性核对", "确认所有节点版本一致", "verify.versions"),
                _step(2, "接口冒烟测试", "核心接口连通性", "verify.smoke"),
                _step(3, "生成升级报告", "汇总升级结果与遗留问题", "verify.report"),
            ],
        ),
    ]


# --------------------------------------------------------------------------- #
# 流程工厂
# --------------------------------------------------------------------------- #
def create_flow(name: str, env_id: str, mode: str = "install",
                operator: str = "admin") -> InstallFlow:
    stages = build_install_stages() if mode == "install" else build_upgrade_stages()
    if stages:
        stages[0].status = StageStatus.READY     # 首阶段可直接进入

    flow = InstallFlow(
        id=_sid(), name=name, env_id=env_id, mode=mode,
        stages=stages, status=FlowStatus.DRAFT, operator=operator,
    )
    return flow


def refresh_locks(flow: InstallFlow) -> InstallFlow:
    """重算各阶段状态：前一阶段 PASSED 或 SKIPPED，本阶段才从 LOCKED 升为 READY。"""
    for i, st in enumerate(flow.stages):
        if st.status in (StageStatus.PASSED, StageStatus.SKIPPED,
                         StageStatus.RUNNING, StageStatus.FAILED):
            continue
        if i == 0:
            st.status = StageStatus.READY
        else:
            prev = flow.stages[i - 1]
            if prev.status in (StageStatus.PASSED, StageStatus.SKIPPED):
                st.status = StageStatus.READY
            else:
                st.status = StageStatus.LOCKED
    flow.current_stage = next(
        (i for i, s in enumerate(flow.stages)
         if s.status in (StageStatus.READY, StageStatus.RUNNING, StageStatus.FAILED)),
        len(flow.stages) - 1,
    )
    return flow


def stage_by_key(flow: InstallFlow, key: str) -> Optional[FlowStage]:
    return next((s for s in flow.stages if s.key == key), None)


def upstream_ready(flow: InstallFlow, key: str) -> Optional[str]:
    """返回阻塞本阶段的阶段标题；无阻塞返回 None。"""
    st = stage_by_key(flow, key)
    if not st:
        return f"阶段 {key} 不存在"
    if st.status == StageStatus.LOCKED:
        prev = flow.stages[st.index - 1] if st.index > 0 else None
        return prev.title if prev else "前置阶段"
    return None


# --------------------------------------------------------------------------- #
# 输入校验
# --------------------------------------------------------------------------- #
def validate_stage_inputs(flow: InstallFlow, key: str,
                          inputs: Dict[str, Any]) -> List[str]:
    """校验阶段输入。返回错误列表，非空则拒绝。**

    除了 required 检查，还做业务级校验 —— 这些是实际交付中最容易漏的。
    """
    st = stage_by_key(flow, key)
    if not st:
        return [f"阶段 {key} 不存在"]

    errors: List[str] = []
    for f in st.form_fields:
        k = f["key"]
        val = inputs.get(k, f.get("default"))
        if f["required"] and (val is None or val == "" or val == []):
            errors.append(f"「{f['label']}」为必填项")
        if f.get("type") == "number" and val not in (None, ""):
            try:
                iv = int(val)
                if iv < 0:
                    errors.append(f"「{f['label']}」不能为负数")
            except (TypeError, ValueError):
                errors.append(f"「{f['label']}」必须是数字")

    # ---- 业务级校验 ---- #
    if key == "env_register":
        physical = inputs.get("physical_nodes") or []
        virtual = inputs.get("virtual_nodes") or []
        total = len(physical) + len(virtual)
        if total == 0:
            errors.append("至少需要登记 1 台节点（物理机或虚拟机）")

        # IP 唯一性
        ips: List[str] = []
        for n in physical + virtual:
            ip = (n.get("ip") or "").strip()
            if not ip:
                errors.append(f"节点 {n.get('hostname') or '(未命名)'} 缺少 IP")
            elif ip in ips:
                errors.append(f"IP {ip} 重复登记")
            else:
                ips.append(ip)
            if not (n.get("hostname") or "").strip():
                errors.append("存在未填写主机名的节点")

        # 控制节点数量建议
        ctrl = sum(1 for n in physical + virtual if n.get("role") == "control")
        want_ctrl = inputs.get("control_count")
        if want_ctrl is not None and ctrl != int(want_ctrl or 0):
            errors.append(
                f"控制节点实际登记 {ctrl} 台，与声明的 {want_ctrl} 台不一致"
            )
        if ctrl and ctrl % 2 == 0:
            errors.append(f"控制节点为 {ctrl} 台（偶数），etcd 类组件建议奇数台以保证选主")
        if ctrl == 1:
            errors.append("仅 1 台控制节点，不具备高可用能力，生产环境不建议")

        # 物理机必填硬件字段
        for n in physical:
            for k2, label in (("vendor", "品牌"), ("model", "型号"), ("idc", "机房")):
                if not (n.get(k2) or "").strip():
                    errors.append(f"物理机 {n.get('hostname') or n.get('ip')} 缺少「{label}」")
        # 虚机必填规格
        for n in virtual:
            for k2, label in (("host_platform", "虚拟化平台"), ("vcpu", "vCPU"),
                              ("memory_gb", "内存"), ("disk_gb", "磁盘")):
                if not n.get(k2):
                    errors.append(f"虚拟机 {n.get('hostname') or n.get('ip')} 缺少「{label}」")

    if key == "package_upload":
        if not inputs.get("_package_id"):
            errors.append("尚未上传任何安装包")

    if key == "package_distribute":
        # 注意：不能把 _distribution_id 作为前置条件 —— 它是在本阶段执行过程中
        # 才创建的，若在此校验就永远无法满足（先有鸡还是先有蛋）。
        # 本阶段真正需要的是"确实存在可分发的包"：优先看本阶段输入，
        # 其次回退到包清单（用户可能是在「安装包」页上传的）。
        pkgs = inputs.get("_package_ids") or (
            [inputs["_package_id"]] if inputs.get("_package_id") else [])
        if not pkgs:
            from ..core import store as _store
            pkgs = [p.id for p in _store.list_packages() if p.upload_complete]
        if not pkgs:
            errors.append("尚未上传任何安装包，请先完成「上传安装包」阶段")
        if not (inputs.get("remote_dir") or "").strip():
            errors.append("「节点目标目录」为必填项")
        if not (inputs.get("target_roles") or []):
            errors.append("「分发到哪些角色」至少选择一个")

    if key in ("pre_install_backup", "pre_upgrade_backup"):
        paths = inputs.get("include_paths")
        dbs = inputs.get("include_databases")
        if not paths and not dbs and not inputs.get("include_config"):
            errors.append("备份范围为空：至少选择备份目录、数据库或配置文件之一")

    if key == "upgrade_execute":
        tv = (inputs.get("target_version") or "").strip()
        if tv:
            from ..services.versioning import is_valid_version
            if not is_valid_version(tv):
                errors.append(f"目标版本 {tv} 格式不合法，应为 v主.次.修订 形式")

    return errors
