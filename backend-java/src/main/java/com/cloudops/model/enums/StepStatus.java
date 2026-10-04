package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

public enum StepStatus {
    PENDING("pending"),
    RUNNING("running"),
    DONE("done"),
    PARTIAL("partial"),
    FAILED("failed"),
    SKIPPED("skipped");

    private final String value;

    StepStatus(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }
}
