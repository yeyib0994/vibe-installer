package com.cloudops.model.dto;

import com.cloudops.model.enums.MachineType;
import com.cloudops.model.enums.NodeRole;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class NodeSpecInput {
    public String hostname;
    public String ip;
    public NodeRole role = NodeRole.WORKER;
    public MachineType machineType = MachineType.VIRTUAL;
    public int sshPort = 22;
    public String sshUser = "root";
    public String sshKeyPath;
    public String vendor;
    public String model;
    public String idc;
    public String rack;
    public String nicSpeed;
    public String raidLevel;
    public String hostPlatform;
    public Integer vcpu;
    public Integer memoryGb;
    public Integer diskGb;
    public String imageTemplate;

    public NodeSpecInput() {}
}
