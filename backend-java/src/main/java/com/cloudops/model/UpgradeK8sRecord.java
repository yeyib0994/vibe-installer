package com.cloudops.model;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;

/** K8s 升级流程记录。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class UpgradeK8sRecord {
    public String flowId;
    public HelmRelease release;
    public String strategy;          // rolling / canary / blue_green
    public String beforeVersion;
    public String afterVersion;
    public int beforeRevision;
    public int afterRevision;
    /** 回滚目标 revision（升级前自动记录） */
    public int rollbackRevision;
    public String backupPointId;
    public LocalDateTime startedAt;
    public LocalDateTime finishedAt;
}
