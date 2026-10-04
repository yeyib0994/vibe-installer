package com.cloudops.model;

import com.cloudops.model.enums.StepStatus;
import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class FlowStep {
    public String id;
    public int index;
    public String title;
    public String detail = "";
    public String action = "";
    public Map<String, Object> args = new HashMap<>();
    public StepStatus status = StepStatus.PENDING;
    public String output = "";
    public String error;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime startedAt;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime finishedAt;
    public int durationMs = 0;

    public FlowStep() {}
}
