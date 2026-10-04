package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

public enum NodeStatus {
    UNKNOWN("unknown"),
    REACHABLE("reachable"),       // SSH 可达，凭据有效
    UNREACHABLE("unreachable"),
    PREPARED("prepared"),         // 已完成环境预检
    INSTALLED("installed");

    private final String value;

    NodeStatus(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }
}
