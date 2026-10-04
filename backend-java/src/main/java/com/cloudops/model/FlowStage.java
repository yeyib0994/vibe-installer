package com.cloudops.model;

import com.cloudops.model.enums.StageStatus;
import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 流程阶段 —— 编排的基本单元。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class FlowStage {
    public String key;
    public int index;
    public String title;
    public String description = "";
    public List<Map<String, Object>> formFields = new ArrayList<>();
    public Map<String, Object> inputs = new HashMap<>();
    public boolean required = true;
    public StageStatus status = StageStatus.LOCKED;
    public List<FlowStep> steps = new ArrayList<>();
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime startedAt;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime finishedAt;
    public String error;

    public FlowStage() {}
}
