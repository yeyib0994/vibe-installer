package com.cloudops.model;

import com.cloudops.model.enums.BackupKind;
import com.cloudops.model.enums.BackupStatus;
import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class BackupPoint {
    public String id;
    public String name;
    public BackupKind kind = BackupKind.PRE_INSTALL;
    public String envId = "";
    public String flowId;
    public List<String> includePaths = new ArrayList<>();
    public List<String> includeDatabases = new ArrayList<>();
    /** false：备份目录逐项 shellQuote，远端不展开；true：按原样拼接，由远端 shell 展开 * 等通配符。 */
    public boolean includePathsAllowGlob = false;
    public boolean includeConfig = true;
    public int retentionDays = 30;
    public BackupStatus status = BackupStatus.PENDING;
    public long sizeBytes = 0;
    public String checksum = "";
    public String path = "";
    public List<String> nodesCovered = new ArrayList<>();
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime startedAt;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime finishedAt;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime expireAt;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime verifiedAt;
    public boolean restorable = false;
    public String error;

    public BackupPoint() {}
}
