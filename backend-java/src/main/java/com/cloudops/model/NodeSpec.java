package com.cloudops.model;

import com.cloudops.model.enums.MachineType;
import com.cloudops.model.enums.NodeRole;
import com.cloudops.model.enums.NodeStatus;
import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/** 单台节点的登记信息。硬件字段按 machine_type 分组填写。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class NodeSpec {
    public String id;
    public String hostname;
    public String ip;
    public NodeRole role = NodeRole.WORKER;
    public MachineType machineType = MachineType.VIRTUAL;

    // SSH 接入
    public int sshPort = 22;
    public String sshUser = "root";
    public String sshKeyPath;
    public boolean sshPasswordSet = false;

    // 物理机专属
    public String vendor;
    public String model;
    public String idc;
    public String rack;
    public String nicSpeed;
    public String raidLevel;

    // 虚拟机专属
    public String hostPlatform;
    public Integer vcpu;
    public Integer memoryGb;
    public Integer diskGb;
    public String imageTemplate;

    // 运行态（预检回填）
    public NodeStatus status = NodeStatus.UNKNOWN;
    public String osRelease;
    public String kernel;
    public Integer cpuCores;
    public Double memTotalGb;
    public Double diskFreeGb;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime lastCheckedAt;
    public List<String> precheckIssues = new ArrayList<>();

    public NodeSpec() {}
}
