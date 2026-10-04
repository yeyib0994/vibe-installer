package com.cloudops.model.dto;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class StageActionRequest {
    public String operator = "admin";
    public boolean confirm = false;

    public StageActionRequest() {}
}
