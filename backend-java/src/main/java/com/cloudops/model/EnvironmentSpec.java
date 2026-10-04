package com.cloudops.model;

import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 安装环境：按硬件类型分组的节点矩阵 + 全局参数。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class EnvironmentSpec {
    public String id;
    public String name;
    public String description = "";
    public String baseDomain = "";
    public String ntpServer = "";
    public List<String> dnsServers = new ArrayList<>();
    public String timezone = "Asia/Shanghai";
    public List<NodeSpec> nodes = new ArrayList<>();
    public boolean validated = false;
    public List<String> validationIssues = new ArrayList<>();
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime createdAt = LocalDateTime.now();
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime updatedAt = LocalDateTime.now();

    public EnvironmentSpec() {}

    public Map<String, Object> summary() {
        Map<String, Integer> byRole = new HashMap<>();
        Map<String, Integer> byType = new HashMap<>();
        for (NodeSpec n : nodes) {
            byRole.merge(n.role.getValue(), 1, Integer::sum);
            byType.merge(n.machineType.getValue(), 1, Integer::sum);
        }
        Map<String, Object> m = new HashMap<>();
        m.put("total", nodes.size());
        m.put("by_role", byRole);
        m.put("by_type", byType);
        m.put("physical", byType.getOrDefault("physical", 0));
        m.put("virtual", byType.getOrDefault("virtual", 0));
        return m;
    }
}
