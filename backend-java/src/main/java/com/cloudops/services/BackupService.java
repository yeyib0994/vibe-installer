package com.cloudops.services;

import com.cloudops.model.BackupPoint;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.stream.Stream;

/** 备份点摘要计算 —— 只此一处，避免登记与校验两边算法漂移。 */
@Service
public class BackupService {

    /** 返回 [digest, fileCount, sizeBytes]。 */
    public Object[] backupDigest(BackupPoint b) {
        try {
            MessageDigest h = MessageDigest.getInstance("SHA-256");
            int files = 0;
            long size = 0;
            Path base = (b.path != null && !b.path.isEmpty()) ? Paths.get(b.path) : null;
            if (base != null && Files.exists(base)) {
                List<Path> all = new ArrayList<>();
                try (Stream<Path> s = Files.walk(base)) {
                    s.filter(Files::isRegularFile).forEach(all::add);
                }
                Collections.sort(all);
                for (Path f : all) {
                    h.update(f.getFileName().toString().getBytes());
                    long sz = Files.size(f);
                    h.update(String.valueOf(sz).getBytes());
                    files++;
                    size += sz;
                }
            }
            h.update((b.sizeBytes + "|" + b.nodesCovered.size()).getBytes());
            List<String> nodes = new ArrayList<>(b.nodesCovered);
            Collections.sort(nodes);
            for (String n : nodes) {
                h.update(n.getBytes());
            }
            StringBuilder sb = new StringBuilder();
            for (byte bb : h.digest()) sb.append(String.format("%02x", bb));
            return new Object[]{sb.toString(), files, size};
        } catch (Exception e) {
            throw new RuntimeException("备份摘要计算失败: " + e.getMessage(), e);
        }
    }
}
