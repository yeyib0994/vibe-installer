package com.cloudops.model;

import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/** 断点续传上传会话。
 *
 *  客户端先 init 拿到 upload_id，再逐片上传 chunk，最后 complete 合并校验。
 *  中途断线可重新 GET status 获知已完成分片，跳过已上传的部分。
 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public class UploadSession {
    public String id;
    public String name;
    public String version = "";
    public String kind = "bundle";
    public long sizeBytes;
    public int chunkSize;
    public int totalChunks;
    public List<Integer> doneChunks = new ArrayList<>();
    public long uploadedBytes = 0;
    public boolean complete = false;
    public String flowId;
    public LocalDateTime createdAt = LocalDateTime.now();

    public UploadSession() {}

    public double getProgress() {
        if (sizeBytes == 0) return 0.0;
        return Math.round(Math.min((double) uploadedBytes / sizeBytes, 1.0) * 1000) / 10.0;
    }
}
