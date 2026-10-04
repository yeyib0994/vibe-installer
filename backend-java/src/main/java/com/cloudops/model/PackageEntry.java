package com.cloudops.model;

import com.fasterxml.jackson.annotation.JsonFormat;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class PackageEntry {
    public String id;
    public String name;
    public String version = "";
    public String kind = "bundle";
    public long sizeBytes = 0;
    public String checksum = "";
    public List<PackagePiece> pieces = new ArrayList<>();
    public boolean uploadComplete = false;
    public long uploadedBytes = 0;
    public String path = "";
    public String storage = "console";
    public String targetEnvId;
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss")
    public LocalDateTime createdAt = LocalDateTime.now();
    public String note = "";

    public PackageEntry() {}

    public double getProgress() {
        if (sizeBytes == 0) return 0.0;
        return Math.round(Math.min((double) uploadedBytes / sizeBytes, 1.0) * 1000) / 10.0;
    }
}
