package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

public enum BackupKind {
    PRE_INSTALL("pre_install"),     // 安装前备份
    PRE_UPGRADE("pre_upgrade");     // 升级前备份

    private final String value;

    BackupKind(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }
}
