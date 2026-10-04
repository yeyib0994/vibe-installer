package com.cloudops.model.enums;

import com.fasterxml.jackson.annotation.JsonValue;

/** 机器形态 —— 决定采集哪些硬件字段。 */
public enum MachineType {
    PHYSICAL("physical"),   // 物理机：型号、机房、机架、网卡、RAID
    VIRTUAL("virtual");     // 虚拟机：宿主、CPU、内存、磁盘、镜像模板

    private final String value;

    MachineType(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }

    public static MachineType fromValue(String v) {
        if (v == null) return VIRTUAL;
        for (MachineType mt : values()) {
            if (mt.value.equals(v)) return mt;
        }
        return VIRTUAL;
    }
}
