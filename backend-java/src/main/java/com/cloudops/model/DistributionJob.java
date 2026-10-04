package com.cloudops.model;

import com.cloudops.model.enums.StepStatus;
import com.cloudops.model.enums.TransferMode;
import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class DistributionJob {
    public String id;
    public String flowId;
    public List<String> packageIds = new ArrayList<>();
    public String envId = "";
    public TransferMode mode = TransferMode.RSYNC;
    public int concurrency = 4;
    public String remoteDir = "/opt/packages";
    public boolean verifyChecksum = true;
    public StepStatus status = StepStatus.PENDING;
    public List<TransferRecord> records = new ArrayList<>();
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime createdAt = LocalDateTime.now();

    public DistributionJob() {}
}
