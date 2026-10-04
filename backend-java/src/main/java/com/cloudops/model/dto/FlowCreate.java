package com.cloudops.model.dto;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class FlowCreate {
    public String name;
    public String envId;
    public String mode = "install";

    public FlowCreate() {}
}
