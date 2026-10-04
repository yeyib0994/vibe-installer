package com.cloudops.model;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;

/** K8s 集群连接信息。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class K8sCluster {
    public String id;
    public String name;
    /** kubeconfig 文件路径或 base64 内容 */
    public String kubeconfig;
    public String namespace = "default";
    public String context = "";
    public LocalDateTime createdAt = LocalDateTime.now();
}
