"""领域模型：安装流程编排。

与上一版的根本区别
------------------
上一版是「选完参数 → 生成计划 → 执行」，本质是个变更执行台。
这一版是「分阶段引导 → 每阶段填表+校验 → 前一阶段通过才解锁下一阶段」，
即真正的工作流编排（Workflow Orchestration）。

核心对象
--------
EnvironmentSpec  安装环境规格 —— 按硬件类型分为物理机/虚机两组，逐台登记节点
PackageEntry     安装包 —— 上传后登记，含分片与校验信息
DistributionJob  分发任务 —— 包 → 各节点的传输记录（scp/rsync）
BackupPoint      备份点 —— 安装前/升级前的数据备份基线
InstallFlow      安装主流程 —— 阶段推进 + 阶段内步骤执行
"""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# 枚举
# --------------------------------------------------------------------------- #
class MachineType(str, enum.Enum):
    """机器形态 —— 决定采集哪些硬件字段。"""

    PHYSICAL = "physical"   # 物理机：型号、机房、机架、网卡、RAID
    VIRTUAL = "virtual"     # 虚拟机：宿主、CPU、内存、磁盘、镜像模板


class NodeRole(str, enum.Enum):
    """节点角色 —— 决定安装哪些组件。"""

    CONTROL = "control"       # 控制/管理节点
    WORKER = "worker"         # 工作节点
    DATABASE = "database"     # 数据库节点
    STORAGE = "storage"       # 存储节点
    GATEWAY = "gateway"       # 网关/接入节点


class NodeStatus(str, enum.Enum):
    UNKNOWN = "unknown"
    REACHABLE = "reachable"       # SSH 可达，凭据有效
    UNREACHABLE = "unreachable"
    PREPARED = "prepared"         # 已完成环境预检（依赖、端口、内核参数）
    INSTALLED = "installed"


class StageStatus(str, enum.Enum):
    LOCKED = "locked"           # 前置阶段未完成，不可进入
    READY = "ready"             # 可开始填写/执行
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"


class TransferMode(str, enum.Enum):
    SCP = "scp"
    RSYNC = "rsync"


class BackupKind(str, enum.Enum):
    PRE_INSTALL = "pre_install"     # 安装前备份（新装时用于保留已有数据）
    PRE_UPGRADE = "pre_upgrade"     # 升级前备份


class BackupStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    VERIFIED = "verified"
    RESTORED = "restored"
    EXPIRED = "expired"             # 超过保留策略被清理


class FlowStatus(str, enum.Enum):
    DRAFT = "draft"
    RUNNING = "running"
    PAUSED = "paused"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    ABORTED = "aborted"


class StepStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    PARTIAL = "partial"      # 部分成功（如分发时部分节点需重传）
    FAILED = "failed"
    SKIPPED = "skipped"


# --------------------------------------------------------------------------- #
# 节点
# --------------------------------------------------------------------------- #
class NodeSpec(BaseModel):
    """单台节点的登记信息。硬件字段按 machine_type 分组填写。"""

    id: str
    hostname: str
    ip: str
    role: NodeRole = NodeRole.WORKER
    machine_type: MachineType = MachineType.VIRTUAL

    # SSH 接入
    ssh_port: int = 22
    ssh_user: str = "root"
    # 凭据只存引用/路径，不存明文密码
    ssh_key_path: Optional[str] = None
    ssh_password_set: bool = False

    # 物理机专属
    vendor: Optional[str] = None          # 品牌，如 Dell / H3C
    model: Optional[str] = None           # 型号
    idc: Optional[str] = None             # 机房
    rack: Optional[str] = None            # 机架位
    nic_speed: Optional[str] = None       # 网卡速率，如 10GbE
    raid_level: Optional[str] = None      # RAID 级别

    # 虚拟机专属
    host_platform: Optional[str] = None   # 虚拟化平台，如 VMware / KVM
    vcpu: Optional[int] = None
    memory_gb: Optional[int] = None
    disk_gb: Optional[int] = None
    image_template: Optional[str] = None  # 镜像模板名

    # 运行态（预检回填）
    status: NodeStatus = NodeStatus.UNKNOWN
    os_release: Optional[str] = None
    kernel: Optional[str] = None
    cpu_cores: Optional[int] = None
    mem_total_gb: Optional[float] = None
    disk_free_gb: Optional[float] = None
    last_checked_at: Optional[datetime] = None
    precheck_issues: List[str] = Field(default_factory=list)


class NodeSpecInput(BaseModel):
    hostname: str
    ip: str
    role: NodeRole = NodeRole.WORKER
    machine_type: MachineType = MachineType.VIRTUAL
    ssh_port: int = 22
    ssh_user: str = "root"
    ssh_key_path: Optional[str] = None
    vendor: Optional[str] = None
    model: Optional[str] = None
    idc: Optional[str] = None
    rack: Optional[str] = None
    nic_speed: Optional[str] = None
    raid_level: Optional[str] = None
    host_platform: Optional[str] = None
    vcpu: Optional[int] = None
    memory_gb: Optional[int] = None
    disk_gb: Optional[int] = None
    image_template: Optional[str] = None


# --------------------------------------------------------------------------- #
# 环境规格
# --------------------------------------------------------------------------- #
class EnvironmentSpec(BaseModel):
    """安装环境：按硬件类型分组的节点矩阵 + 全局参数。"""

    id: str
    name: str
    description: str = ""
    # 全局网络与系统参数
    base_domain: str = ""
    ntp_server: str = ""
    dns_servers: List[str] = Field(default_factory=list)
    timezone: str = "Asia/Shanghai"
    # 节点
    nodes: List[NodeSpec] = Field(default_factory=list)
    # 校验结果
    validated: bool = False
    validation_issues: List[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    # -- 派生统计 ---------------------------------------------------------- #
    def summary(self) -> Dict[str, Any]:
        by_role: Dict[str, int] = {}
        by_type: Dict[str, int] = {}
        for n in self.nodes:
            by_role[n.role.value] = by_role.get(n.role.value, 0) + 1
            by_type[n.machine_type.value] = by_type.get(n.machine_type.value, 0) + 1
        return {
            "total": len(self.nodes),
            "by_role": by_role,
            "by_type": by_type,
            "physical": by_type.get("physical", 0),
            "virtual": by_type.get("virtual", 0),
        }


class EnvironmentSpecInput(BaseModel):
    name: str
    description: str = ""
    base_domain: str = ""
    ntp_server: str = ""
    dns_servers: List[str] = Field(default_factory=list)
    timezone: str = "Asia/Shanghai"


# --------------------------------------------------------------------------- #
# 安装包
# --------------------------------------------------------------------------- #
class PackagePiece(BaseModel):
    """分片信息 —— 大包切分上传，支持断点续传。"""

    index: int
    size_bytes: int
    checksum: str = ""


class PackageEntry(BaseModel):
    id: str
    name: str
    version: str = ""
    kind: str = "bundle"                # bundle / image / config / patch
    size_bytes: int = 0
    checksum: str = ""                  # 整包 sha256
    pieces: List[PackagePiece] = Field(default_factory=list)
    upload_complete: bool = False
    uploaded_bytes: int = 0
    path: str = ""
    storage: str = "console"            # console(控制台暂存) / nexus / minio
    # 分发目标
    target_env_id: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    note: str = ""

    @property
    def progress(self) -> float:
        if not self.size_bytes:
            return 0.0
        return round(min(self.uploaded_bytes / self.size_bytes, 1.0) * 100, 1)


class PackageCreate(BaseModel):
    name: str
    version: str = ""
    kind: str = "bundle"
    size_bytes: int = 0
    note: str = ""


# --------------------------------------------------------------------------- #
# 分发
# --------------------------------------------------------------------------- #
class TransferRecord(BaseModel):
    node_id: str
    hostname: str
    ip: str
    status: StepStatus = StepStatus.PENDING
    mode: TransferMode = TransferMode.RSYNC
    bytes_sent: int = 0
    speed_mbps: float = 0.0
    checksum_ok: Optional[bool] = None
    remote_path: str = ""
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None


class DistributionJob(BaseModel):
    id: str
    flow_id: str
    package_ids: List[str] = Field(default_factory=list)
    env_id: str = ""
    mode: TransferMode = TransferMode.RSYNC
    concurrency: int = 4
    remote_dir: str = "/opt/packages"
    verify_checksum: bool = True
    status: StepStatus = StepStatus.PENDING
    records: List[TransferRecord] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class DistributionRequest(BaseModel):
    package_ids: List[str]
    mode: TransferMode = TransferMode.RSYNC
    concurrency: int = 4
    remote_dir: str = "/opt/packages"
    verify_checksum: bool = True
    node_ids: List[str] = Field(default_factory=list)   # 空 = 全部节点


# --------------------------------------------------------------------------- #
# 备份点
# --------------------------------------------------------------------------- #
class BackupPoint(BaseModel):
    id: str
    name: str
    kind: BackupKind = BackupKind.PRE_INSTALL
    env_id: str = ""
    flow_id: Optional[str] = None
    # 备份内容范围
    include_paths: List[str] = Field(default_factory=list)      # 文件目录
    include_databases: List[str] = Field(default_factory=list)  # 数据库实例名
    include_config: bool = True                                  # 配置文件
    # 保留策略
    retention_days: int = 30
    # 执行结果
    status: BackupStatus = BackupStatus.PENDING
    size_bytes: int = 0
    checksum: str = ""
    path: str = ""
    nodes_covered: List[str] = Field(default_factory=list)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    expire_at: Optional[datetime] = None
    verified_at: Optional[datetime] = None
    restorable: bool = False
    error: Optional[str] = None


class BackupRequest(BaseModel):
    name: str = ""
    kind: BackupKind = BackupKind.PRE_INSTALL
    env_id: str
    include_paths: List[str] = Field(default_factory=list)
    include_databases: List[str] = Field(default_factory=list)
    include_config: bool = True
    retention_days: int = 30
    node_ids: List[str] = Field(default_factory=list)


class RestoreRequest(BaseModel):
    backup_id: str
    node_ids: List[str] = Field(default_factory=list)
    confirm: bool = False


# --------------------------------------------------------------------------- #
# 流程与阶段
# --------------------------------------------------------------------------- #
class FlowStep(BaseModel):
    id: str
    index: int
    title: str
    detail: str = ""
    action: str = ""
    args: Dict[str, Any] = Field(default_factory=dict)
    status: StepStatus = StepStatus.PENDING
    output: str = ""
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    duration_ms: int = 0


class FlowStage(BaseModel):
    """流程阶段 —— 编排的基本单元。

    每个阶段有自己的输入表单（schema 描述给前端渲染）、前置校验、步骤列表。
    只有前一阶段 PASSED，本阶段才从 LOCKED 变为 READY。
    """

    key: str
    index: int
    title: str
    description: str = ""
    # 该阶段需要用户填写的字段（前端据此渲染表单）
    form_fields: List[Dict[str, Any]] = Field(default_factory=list)
    # 该阶段的输入数据
    inputs: Dict[str, Any] = Field(default_factory=dict)
    # 前置校验：返回错误列表，非空则不允许启动本阶段
    required: bool = True
    status: StageStatus = StageStatus.LOCKED
    steps: List[FlowStep] = Field(default_factory=list)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None


class InstallFlow(BaseModel):
    """安装主编排流程。"""

    id: str
    name: str
    env_id: str = ""
    mode: str = "install"           # install / upgrade
    status: FlowStatus = FlowStatus.DRAFT
    stages: List[FlowStage] = Field(default_factory=list)
    current_stage: int = 0
    operator: str = "admin"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    backup_point_id: Optional[str] = None


class FlowCreate(BaseModel):
    name: str
    env_id: str
    mode: str = "install"


class StageInputSubmit(BaseModel):
    inputs: Dict[str, Any]


class StageActionRequest(BaseModel):
    operator: str = "admin"
    confirm: bool = False


# --------------------------------------------------------------------------- #
# 审计
# --------------------------------------------------------------------------- #
class AuditRecord(BaseModel):
    ts: str
    operator: str
    action: str
    target: str
    result: str
    detail: str = ""
