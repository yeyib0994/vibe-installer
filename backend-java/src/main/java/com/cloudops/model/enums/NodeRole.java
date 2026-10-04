package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

/** 节点角色 —— 决定安装哪些组件。 */
public enum NodeRole {
    CONTROL("control"),       // 控制/管理节点
    WORKER("worker"),         // 工作节点
    DATABASE("database"),     // 数据库节点
    STORAGE("storage"),       // 存储节点
    GATEWAY("gateway");       // 网关/接入节点

    private final String value;

    NodeRole(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }

    public static NodeRole fromValue(String v) {
        if (v == null) return WORKER;
        for (NodeRole r : values()) {
            if (r.value.equals(v)) return r;
        }
        return WORKER;
    }
}
