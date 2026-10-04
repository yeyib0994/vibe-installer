package com.cloudops.model;

import com.cloudops.model.enums.StepStatus;
import com.cloudops.model.enums.TransferMode;
import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class TransferRecord {
    public String nodeId;
    public String hostname;
    public String ip;
    public StepStatus status = StepStatus.PENDING;
    public TransferMode mode = TransferMode.RSYNC;
    public long bytesSent = 0;
    public double speedMbps = 0.0;
    public Boolean checksumOk;
    public String remotePath = "";
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime startedAt;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime finishedAt;
    public String error;

    public TransferRecord() {}
}
