"""首次启动灌入示例数据。

预置一个贴近真实交付的机房环境：
- 3 台物理机（控制节点，不同品牌/机房）
- 5 台虚拟机（工作节点）
- 1 台物理机做数据库节点
- 1 台虚机做网关

这样打开控制台就能直接演示「按硬件类型分组登记节点」以及后续全流程。
"""

from __future__ import annotations

import uuid

from ..models.schemas import (
    EnvironmentSpec,
    MachineType,
    NodeRole,
    NodeSpec,
)
from . import store


def _n(hostname: str, ip: str, role: NodeRole, mtype: MachineType,
       **kw) -> NodeSpec:
    return NodeSpec(id=uuid.uuid4().hex[:12], hostname=hostname, ip=ip,
                    role=role, machine_type=mtype, **kw)


def seed_if_empty() -> None:
    if store.list_envs():
        return

    env = EnvironmentSpec(
        id=uuid.uuid4().hex[:12],
        name="生产主中心-上海",
        description="华东主中心，3 控制 + 5 计算 + 1 数据库 + 1 网关，混合物理机与虚拟机部署",
        base_domain="app.internal.com",
        ntp_server="ntp.internal.com",
        dns_servers=["10.0.0.10", "10.0.0.11"],
        timezone="Asia/Shanghai",
        nodes=[
            # ---------- 物理机：控制面 ---------- #
            _n("ctrl-phy-01", "10.20.1.11", NodeRole.CONTROL, MachineType.PHYSICAL,
               vendor="Dell", model="PowerEdge R750", idc="Shanghai-A",
               rack="A-03-12", nic_speed="10GbE", raid_level="RAID10", vcpu=32,
               memory_gb=128, disk_gb=1920, ssh_user="root"),
            _n("ctrl-phy-02", "10.20.1.12", NodeRole.CONTROL, MachineType.PHYSICAL,
               vendor="Dell", model="PowerEdge R750", idc="Shanghai-A",
               rack="A-03-13", nic_speed="10GbE", raid_level="RAID10", vcpu=32,
               memory_gb=128, disk_gb=1920, ssh_user="root"),
            _n("ctrl-phy-03", "10.20.1.13", NodeRole.CONTROL, MachineType.PHYSICAL,
               vendor="H3C", model="UniServer R4900 G5", idc="Shanghai-A",
               rack="A-03-14", nic_speed="25GbE", raid_level="RAID10", vcpu=32,
               memory_gb=128, disk_gb=1920, ssh_user="root"),

            # ---------- 物理机：数据库 ---------- #
            _n("db-phy-01", "10.20.1.21", NodeRole.DATABASE, MachineType.PHYSICAL,
               vendor="Huawei", model="FusionServer 2288H V6", idc="Shanghai-A",
               rack="A-05-02", nic_speed="25GbE", raid_level="RAID10", vcpu=48,
               memory_gb=256, disk_gb=3840, ssh_user="root"),

            # ---------- 虚拟机：工作节点 ---------- #
            _n("worker-vm-01", "10.20.2.31", NodeRole.WORKER, MachineType.VIRTUAL,
               host_platform="VMware vSphere 8.0", vcpu=16, memory_gb=64,
               disk_gb=500, image_template="rhel9-base-v3", ssh_user="root"),
            _n("worker-vm-02", "10.20.2.32", NodeRole.WORKER, MachineType.VIRTUAL,
               host_platform="VMware vSphere 8.0", vcpu=16, memory_gb=64,
               disk_gb=500, image_template="rhel9-base-v3", ssh_user="root"),
            _n("worker-vm-03", "10.20.2.33", NodeRole.WORKER, MachineType.VIRTUAL,
               host_platform="VMware vSphere 8.0", vcpu=16, memory_gb=64,
               disk_gb=500, image_template="rhel9-base-v3", ssh_user="root"),
            _n("worker-vm-04", "10.20.2.34", NodeRole.WORKER, MachineType.VIRTUAL,
               host_platform="KVM / oVirt", vcpu=8, memory_gb=32,
               disk_gb=300, image_template="rhel9-base-v3", ssh_user="root"),
            _n("worker-vm-05", "10.20.2.35", NodeRole.WORKER, MachineType.VIRTUAL,
               host_platform="KVM / oVirt", vcpu=8, memory_gb=32,
               disk_gb=300, image_template="rhel9-base-v3", ssh_user="root"),

            # ---------- 虚拟机：网关 ---------- #
            _n("gw-vm-01", "10.20.3.41", NodeRole.GATEWAY, MachineType.VIRTUAL,
               host_platform="VMware vSphere 8.0", vcpu=4, memory_gb=16,
               disk_gb=200, image_template="rhel9-lb-v2", ssh_user="root"),
        ],
        validated=True,
    )
    store.save_env(env)
    store.audit("system", "seed", "init", "ok",
                f"初始化示例环境 {env.name}（{len(env.nodes)} 台节点）")
