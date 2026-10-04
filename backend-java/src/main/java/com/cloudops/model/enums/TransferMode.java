package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

public enum TransferMode {
    SCP("scp"),
    RSYNC("rsync");

    private final String value;

    TransferMode(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }

    public static TransferMode fromValue(String v) {
        if (v == null) return RSYNC;
        for (TransferMode m : values()) {
            if (m.value.equals(v)) return m;
        }
        return RSYNC;
    }
}
