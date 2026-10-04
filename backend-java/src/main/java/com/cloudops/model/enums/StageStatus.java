package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

public enum StageStatus {
    LOCKED("locked"),
    READY("ready"),
    RUNNING("running"),
    PASSED("passed"),
    FAILED("failed"),
    SKIPPED("skipped");

    private final String value;

    StageStatus(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }
}
