package com.cloudops.model.dto;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.util.ArrayList;
import java.util.List;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class EnvironmentSpecInput {
    public String name;
    public String description = "";
    public String baseDomain = "";
    public String ntpServer = "";
    public List<String> dnsServers = new ArrayList<>();
    public String timezone = "Asia/Shanghai";

    public EnvironmentSpecInput() {}
}
