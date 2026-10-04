package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

public enum FlowStatus {
    DRAFT("draft"),
    RUNNING("running"),
    PAUSED("paused"),
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    ABORTED("aborted");

    private final String value;

    FlowStatus(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }
}
