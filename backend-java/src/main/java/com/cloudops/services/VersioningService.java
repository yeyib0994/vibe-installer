package com.cloudops.services;

import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** 版本语义与升级兼容性检查。 */
@Service
public class VersioningService {

    private static final Pattern VALID_VERSION = Pattern.compile("^[vV]?\\d+(\\.\\d+)*([-.+][\\w.]+)?$");

    public int[] parseVersion(String v) {
        if (v == null || v.isEmpty()) return new int[]{0, 0, 0};
        v = v.strip();
        if (v.charAt(0) == 'v' || v.charAt(0) == 'V') v = v.substring(1);
        String core = v.split("-")[0].split("\\+")[0];
        String[] parts = core.split("\\.");
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            if (i < parts.length) {
                StringBuilder num = new StringBuilder();
                for (char ch : parts[i].toCharArray()) {
                    if (Character.isDigit(ch)) num.append(ch);
                    else break;
                }
                out[i] = num.length() > 0 ? Integer.parseInt(num.toString()) : 0;
            } else {
                out[i] = 0;
            }
        }
        return out;
    }

    public boolean isValidVersion(String v) {
        return v != null && VALID_VERSION.matcher(v.strip()).matches();
    }

    public int compareVersions(String a, String b) {
        int[] pa = parseVersion(a);
        int[] pb = parseVersion(b);
        for (int i = 0; i < 3; i++) {
            if (pa[i] != pb[i]) return Integer.compare(pa[i], pb[i]);
        }
        return 0;
    }

    private static final Map<String, Map<String, Object>> COMPONENT_COMPAT = new HashMap<>();
    static {
        COMPONENT_COMPAT.put("mysql", Map.of(
                "message", "MySQL 大版本升级需执行 mysql_upgrade，且认证插件由 mysql_native_password 变更为 caching_sha2_password，旧版客户端将无法连接。",
                "downtime", true));
        COMPONENT_COMPAT.put("postgres", Map.of(
                "message", "PostgreSQL 大版本不支持就地升级，需 pg_upgrade 或逻辑复制，且必须停机。",
                "downtime", true));
        COMPONENT_COMPAT.put("redis", Map.of(
                "message", "Redis 大版本变更了 ACL 与持久化默认行为，需核对 RDB 版本兼容性。",
                "downtime", false));
        COMPONENT_COMPAT.put("kafka", Map.of(
                "message", "Kafka 3.x 起弱化 ZooKeeper 依赖，迁移到 KRaft 需滚动重启并重建元数据。",
                "downtime", false));
        COMPONENT_COMPAT.put("elasticsearch", Map.of(
                "message", "ES 8 默认启用安全认证，索引需 reindex，客户端须同步升级。",
                "downtime", true));
    }

    public Map<String, Object> checkUpgradeCompat(String fromV, String toV) {
        int[] pf = parseVersion(fromV);
        int[] pt = parseVersion(toV);

        if (pt[0] < pf[0] || (pt[0] == pf[0] && (pt[1] < pf[1] || (pt[1] == pf[1] && pt[2] <= pf[2])))) {
            return Map.of("level", "blocker", "breaking", true, "downtime", false,
                    "message", "目标版本 " + toV + " 不高于当前版本 " + fromV + "，疑似降级。如需回退请使用备份恢复功能。");
        }

        if (pf[0] != pt[0]) {
            return Map.of("level", "blocker", "breaking", true, "downtime", true,
                    "message", "跨主版本升级 " + fromV + " → " + toV + "，存在不兼容的数据结构变更，必须在停机窗口内执行并准备好数据迁移脚本。");
        }

        if (pf[1] != pt[1]) {
            return Map.of("level", "warning", "breaking", false, "downtime", false,
                    "message", "跨次版本升级 " + fromV + " → " + toV + "，通常向下兼容，建议先在一台节点上灰度验证。");
        }

        return Map.of("level", "ok", "breaking", false, "downtime", false,
                "message", "修订版本升级 " + fromV + " → " + toV + "，兼容性风险低。");
    }

    public List<String> componentCompatNotes(String component, String fromV, String toV) {
        List<String> notes = new ArrayList<>();
        for (var entry : COMPONENT_COMPAT.entrySet()) {
            if (component.toLowerCase().contains(entry.getKey())) {
                int[] pf = parseVersion(fromV);
                int[] pt = parseVersion(toV);
                if (pf[0] != pt[0]) {
                    notes.add(component + ": " + entry.getValue().get("message"));
                }
                break;
            }
        }
        return notes;
    }
}
