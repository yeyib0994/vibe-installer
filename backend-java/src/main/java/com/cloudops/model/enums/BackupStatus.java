package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

public enum BackupStatus {
    PENDING("pending"),
    RUNNING("running"),
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    VERIFIED("verified"),
    RESTORED("restored"),
    EXPIRED("expired");

    private final String value;

    BackupStatus(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }
}
