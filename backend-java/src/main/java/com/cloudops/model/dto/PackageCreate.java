package com.cloudops.model.dto;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class PackageCreate {
    public String name;
    public String version = "";
    public String kind = "bundle";
    public long sizeBytes = 0;
    public String note = "";

    public PackageCreate() {}
}
