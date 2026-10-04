package com.cloudops.core;

import com.cloudops.model.EnvironmentSpec;
import com.cloudops.model.NodeSpec;
import com.cloudops.model.enums.MachineType;
import com.cloudops.model.enums.NodeRole;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.UUID;

/** 首次启动灌入示例数据 —— 与 Python 版一致。 */
@Component
public class Seed {

    private final Store store;

    public Seed(Store store) {
        this.store = store;
    }

    private static String sid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    private static NodeSpec n(String hostname, String ip, NodeRole role, MachineType mt,
                              String... kv) {
        NodeSpec node = new NodeSpec();
        node.id = sid();
        node.hostname = hostname;
        node.ip = ip;
        node.role = role;
        node.machineType = mt;
        node.sshUser = "root";
        for (int i = 0; i + 1 < kv.length; i += 2) {
            String k = kv[i];
            String v = kv[i + 1];
            switch (k) {
                case "vendor" -> node.vendor = v;
                case "model" -> node.model = v;
                case "idc" -> node.idc = v;
                case "rack" -> node.rack = v;
                case "nic_speed" -> node.nicSpeed = v;
                case "raid_level" -> node.raidLevel = v;
                case "vcpu" -> node.vcpu = Integer.parseInt(v);
                case "memory_gb" -> node.memoryGb = Integer.parseInt(v);
                case "disk_gb" -> node.diskGb = Integer.parseInt(v);
                case "host_platform" -> node.hostPlatform = v;
                case "image_template" -> node.imageTemplate = v;
            }
        }
        return node;
    }

    public void seedIfEmpty() {
        if (!store.listEnvs().isEmpty()) return;

        EnvironmentSpec env = new EnvironmentSpec();
        env.id = sid();
        env.name = "生产主中心-上海";
        env.description = "华东主中心，3 控制 + 5 计算 + 1 数据库 + 1 网关，混合物理机与虚拟机部署";
        env.baseDomain = "app.internal.com";
        env.ntpServer = "ntp.internal.com";
        env.dnsServers = Arrays.asList("10.0.0.10", "10.0.0.11");
        env.timezone = "Asia/Shanghai";
        env.validated = true;
        env.nodes = Arrays.asList(
                n("ctrl-phy-01", "10.20.1.11", NodeRole.CONTROL, MachineType.PHYSICAL,
                        "vendor", "Dell", "model", "PowerEdge R750", "idc", "Shanghai-A",
                        "rack", "A-03-12", "nic_speed", "10GbE", "raid_level", "RAID10",
                        "vcpu", "32", "memory_gb", "128", "disk_gb", "1920"),
                n("ctrl-phy-02", "10.20.1.12", NodeRole.CONTROL, MachineType.PHYSICAL,
                        "vendor", "Dell", "model", "PowerEdge R750", "idc", "Shanghai-A",
                        "rack", "A-03-13", "nic_speed", "10GbE", "raid_level", "RAID10",
                        "vcpu", "32", "memory_gb", "128", "disk_gb", "1920"),
                n("ctrl-phy-03", "10.20.1.13", NodeRole.CONTROL, MachineType.PHYSICAL,
                        "vendor", "H3C", "model", "UniServer R4900 G5", "idc", "Shanghai-A",
                        "rack", "A-03-14", "nic_speed", "25GbE", "raid_level", "RAID10",
                        "vcpu", "32", "memory_gb", "128", "disk_gb", "1920"),
                n("db-phy-01", "10.20.1.21", NodeRole.DATABASE, MachineType.PHYSICAL,
                        "vendor", "Huawei", "model", "FusionServer 2288H V6", "idc", "Shanghai-A",
                        "rack", "A-05-02", "nic_speed", "25GbE", "raid_level", "RAID10",
                        "vcpu", "48", "memory_gb", "256", "disk_gb", "3840"),
                n("worker-vm-01", "10.20.2.31", NodeRole.WORKER, MachineType.VIRTUAL,
                        "host_platform", "VMware vSphere 8.0", "vcpu", "16", "memory_gb", "64",
                        "disk_gb", "500", "image_template", "rhel9-base-v3"),
                n("worker-vm-02", "10.20.2.32", NodeRole.WORKER, MachineType.VIRTUAL,
                        "host_platform", "VMware vSphere 8.0", "vcpu", "16", "memory_gb", "64",
                        "disk_gb", "500", "image_template", "rhel9-base-v3"),
                n("worker-vm-03", "10.20.2.33", NodeRole.WORKER, MachineType.VIRTUAL,
                        "host_platform", "VMware vSphere 8.0", "vcpu", "16", "memory_gb", "64",
                        "disk_gb", "500", "image_template", "rhel9-base-v3"),
                n("worker-vm-04", "10.20.2.34", NodeRole.WORKER, MachineType.VIRTUAL,
                        "host_platform", "KVM / oVirt", "vcpu", "8", "memory_gb", "32",
                        "disk_gb", "300", "image_template", "rhel9-base-v3"),
                n("worker-vm-05", "10.20.2.35", NodeRole.WORKER, MachineType.VIRTUAL,
                        "host_platform", "KVM / oVirt", "vcpu", "8", "memory_gb", "32",
                        "disk_gb", "300", "image_template", "rhel9-base-v3"),
                n("gw-vm-01", "10.20.3.41", NodeRole.GATEWAY, MachineType.VIRTUAL,
                        "host_platform", "VMware vSphere 8.0", "vcpu", "4", "memory_gb", "16",
                        "disk_gb", "200", "image_template", "rhel9-lb-v2")
        );

        store.saveEnv(env);
        store.audit("system", "seed", "init", "ok",
                "初始化示例环境 " + env.name + "（" + env.nodes.size() + " 台节点）");
    }
}
