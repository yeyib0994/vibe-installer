package com.cloudops.model.dto;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.util.ArrayList;
import java.util.List;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class RestoreRequest {
    public String backupId;
    public List<String> nodeIds = new ArrayList<>();
    public boolean confirm = false;

    public RestoreRequest() {}
}
