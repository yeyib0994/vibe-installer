package com.cloudops.model;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

/** 分片信息 —— 大包切分上传，支持断点续传。 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class PackagePiece {
    public int index;
    public int sizeBytes;
    public String checksum = "";

    public PackagePiece() {}
    public PackagePiece(int index, int sizeBytes, String checksum) {
        this.index = index;
        this.sizeBytes = sizeBytes;
        this.checksum = checksum;
    }
}
