package com.cloudops.model;

import com.cloudops.model.enums.FlowStatus;
import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/** 安装主编排流程。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class InstallFlow {
    public String id;
    public String name;
    public String envId = "";
    public String mode = "install";
    public FlowStatus status = FlowStatus.DRAFT;
    public List<FlowStage> stages = new ArrayList<>();
    public int currentStage = 0;
    public String operator = "admin";
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime createdAt = LocalDateTime.now();
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime updatedAt = LocalDateTime.now();
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime finishedAt;
    public String error;
    public String backupPointId;

    public InstallFlow() {}
}
