package com.cloudops.model;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class AuditRecord {
    public long id;
    public String ts;
    public String operator;
    public String action;
    public String target;
    public String result;
    public String detail = "";

    public AuditRecord() {}
}
