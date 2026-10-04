package com.cloudops.services;

import com.cloudops.core.Json;
import com.cloudops.core.Store;
import com.cloudops.model.PackageEntry;
import com.cloudops.model.PackagePiece;
import com.cloudops.model.UploadSession;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 断点续传上传服务。
 *
 *  工作流:
 *  1. init()       创建会话，返回 upload_id + chunk_size + total_chunks
 *  2. chunk()      上传单个分片，落盘到 .tmp/{uploadId}/chunk_{index}
 *  3. status()     查询已完成分片，支持客户端断点续传
 *  4. complete()   合并分片、计算 SHA256、注册为 PackageEntry
 *
 *  分片存储: data/packages/.tmp/{uploadId}/chunk_{index}
 *  合并后文件: data/packages/{uploadId}-{name}
 */
@Service
public class UploadService {

    private final Store store;
    private final Map<String, UploadSession> sessions = new ConcurrentHashMap<>();
    private static final int DEFAULT_CHUNK = 8 * 1024 * 1024; // 8 MB

    public UploadService(Store store) {
        this.store = store;
    }

    private static String sid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    // ===================== init =====================
    public UploadSession init(String name, String version, String kind,
                              long sizeBytes, Integer chunkSize, String flowId) throws IOException {
        int cs = (chunkSize != null && chunkSize > 0) ? chunkSize : DEFAULT_CHUNK;
        int total = (int) Math.ceil((double) sizeBytes / cs);
        if (sizeBytes == 0) total = 1;

        UploadSession s = new UploadSession();
        s.id = sid();
        s.name = name == null || name.isEmpty() ? "unnamed" : name;
        s.version = version == null ? "" : version;
        s.kind = kind == null || kind.isEmpty() ? "bundle" : kind;
        s.sizeBytes = sizeBytes;
        s.chunkSize = cs;
        s.totalChunks = total;
        s.flowId = flowId;

        Path tmpDir = tmpDir(s.id);
        Files.createDirectories(tmpDir);
        sessions.put(s.id, s);
        return s;
    }

    // ===================== chunk =====================
    public Map<String, Object> chunk(String uploadId, int chunkIndex, InputStream data) throws IOException {
        UploadSession s = sessions.get(uploadId);
        if (s == null) throw new IOException("上传会话不存在: " + uploadId);
        if (s.complete) throw new IOException("上传已完成，不能再追加分片");

        Path chunkFile = tmpDir(uploadId).resolve("chunk_" + chunkIndex);
        long received = 0;
        MessageDigest h = sha256();
        try (var in = data; var out = Files.newOutputStream(chunkFile)) {
            byte[] buf = new byte[1024 * 1024];
            int rd;
            while ((rd = in.read(buf)) > 0) {
                out.write(buf, 0, rd);
                h.update(buf, 0, rd);
                received += rd;
            }
        } catch (Exception e) {
            throw new IOException("分片写入失败: " + e.getMessage(), e);
        }

        // 幂等：重复上传同一片只更新进度
        if (!s.doneChunks.contains(chunkIndex)) {
            s.doneChunks.add(chunkIndex);
            s.uploadedBytes += received;
        }
        String checksum = toHex(h.digest());

        return Map.of(
                "upload_id", s.id,
                "chunk_index", chunkIndex,
                "received_bytes", received,
                "checksum", checksum,
                "progress", s.getProgress()
        );
    }

    // ===================== status =====================
    public UploadSession status(String uploadId) {
        UploadSession s = sessions.get(uploadId);
        if (s == null) throw new RuntimeException("上传会话不存在: " + uploadId);
        return s;
    }

    // ===================== complete =====================
    public PackageEntry complete(String uploadId) throws IOException {
        UploadSession s = sessions.get(uploadId);
        if (s == null) throw new IOException("上传会话不存在: " + uploadId);
        if (s.complete) return store.getPackage(uploadId);

        // 校验所有分片都已上传
        if (s.doneChunks.size() < s.totalChunks) {
            throw new IOException("分片未上传完整: " + s.doneChunks.size() + "/" + s.totalChunks);
        }

        Path pkgDir = store.dataDir.resolve("packages");
        Files.createDirectories(pkgDir);
        String safeName = s.name.replaceAll("[^a-zA-Z0-9._-]", "_");
        Path dest = pkgDir.resolve(s.id + "-" + safeName);

        // 合并分片
        MessageDigest totalH = sha256();
        List<PackagePiece> pieces = new ArrayList<>();
        try (var out = Files.newOutputStream(dest)) {
            for (int i = 0; i < s.totalChunks; i++) {
                Path chunkFile = tmpDir(uploadId).resolve("chunk_" + i);
                if (!Files.exists(chunkFile)) {
                    throw new IOException("缺失分片: chunk_" + i);
                }
                MessageDigest pieceH = sha256();
                try (var in = Files.newInputStream(chunkFile)) {
                    byte[] buf = new byte[1024 * 1024];
                    int rd;
                    while ((rd = in.read(buf)) > 0) {
                        out.write(buf, 0, rd);
                        totalH.update(buf, 0, rd);
                        pieceH.update(buf, 0, rd);
                    }
                }
                long sz = Files.size(chunkFile);
                pieces.add(new PackagePiece(i, (int) sz, toHex(pieceH.digest())));
            }
        }

        long totalSize = Files.size(dest);
        PackageEntry entry = new PackageEntry();
        entry.id = s.id;
        entry.name = s.name;
        entry.version = s.version;
        entry.kind = s.kind;
        entry.sizeBytes = totalSize;
        entry.checksum = toHex(totalH.digest());
        entry.path = dest.toString();
        entry.pieces = pieces;
        entry.uploadComplete = true;
        entry.uploadedBytes = totalSize;
        store.savePackage(entry);

        // 清理临时分片
        try {
            Path tmp = tmpDir(uploadId);
            try (var stream = Files.list(tmp)) {
                stream.forEach(f -> { try { Files.deleteIfExists(f); } catch (IOException ignored) {} });
            }
            Files.deleteIfExists(tmp);
        } catch (Exception ignored) {}

        s.complete = true;
        store.audit("admin", "package.upload", s.id, "ok", s.name + " " + totalSize + " bytes");
        return entry;
    }

    // ===================== 辅助 =====================
    private Path tmpDir(String uploadId) {
        return store.dataDir.resolve("packages").resolve(".tmp").resolve(uploadId);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 不可用", e);
        }
    }
}
