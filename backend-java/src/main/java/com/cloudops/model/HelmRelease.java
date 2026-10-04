package com.cloudops.model;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.util.ArrayList;
import java.util.List;

/** Helm Release 快照（升级前后记录）。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class HelmRelease {
    public String name;
    public String namespace;
    public String chart;
    public String currentVersion;
    public String targetVersion;
    public int revision;
    /** release 关联的 workload 名称列表（如 deploy/xxx, sts/yyy） */
    public List<String> workloads = new ArrayList<>();
}
