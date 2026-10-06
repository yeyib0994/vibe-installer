package com.cloudops.core;

import com.cloudops.model.AuditRecord;
import com.cloudops.model.BackupPoint;
import com.cloudops.model.DistributionJob;
import com.cloudops.model.EnvironmentSpec;
import com.cloudops.model.InstallFlow;
import com.cloudops.model.PackageEntry;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** SQLite 持久化层。
 *
 * 与 Python 版一致：所有模型以 JSON 存在 data 列，WAL 模式，单连接 + synchronized。
 */
@Component
public class Store {

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    public final Path dataDir;
    public final Path dbPath;

    private Connection conn;

    public Store() {
        // K8s 友好：优先环境变量 CLOUDOPS_DATA_DIR，其次系统属性 cloudops.data.dir，默认 data
        String dataDirProp = System.getenv("CLOUDOPS_DATA_DIR");
        if (dataDirProp == null || dataDirProp.isEmpty()) {
            dataDirProp = System.getProperty("cloudops.data.dir", "data");
        }
        this.dataDir = Paths.get(dataDirProp).toAbsolutePath();
        this.dbPath = dataDir.resolve("cloudops.db");
    }

    private synchronized Connection conn() {
        try {
            if (conn == null || conn.isClosed()) {
                Files.createDirectories(dataDir);
                Files.createDirectories(dataDir.resolve("packages"));
                Files.createDirectories(dataDir.resolve("backups"));
                conn = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
                try (Statement st = conn.createStatement()) {
                    st.execute("PRAGMA journal_mode=WAL");
                    for (String sql : SCHEMA.split(";")) {
                        String trimmed = sql.trim();
                        if (!trimmed.isEmpty()) st.execute(trimmed);
                    }
                }
            }
            return conn;
        } catch (Exception e) {
            throw new RuntimeException("数据库初始化失败: " + e.getMessage(), e);
        }
    }

    private static final String SCHEMA = """
            CREATE TABLE IF NOT EXISTS env_specs (
                id TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS packages (
                id TEXT PRIMARY KEY, name TEXT, kind TEXT, data TEXT NOT NULL, created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS distributions (
                id TEXT PRIMARY KEY, flow_id TEXT, data TEXT NOT NULL, created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS backups (
                id TEXT PRIMARY KEY, env_id TEXT, kind TEXT, data TEXT NOT NULL, created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS flows (
                id TEXT PRIMARY KEY, name TEXT, env_id TEXT, status TEXT,
                data TEXT NOT NULL, created_at TEXT, updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_flows_created ON flows(created_at DESC);
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL, operator TEXT NOT NULL, action TEXT NOT NULL,
                target TEXT NOT NULL, result TEXT NOT NULL, detail TEXT DEFAULT ''
            );
            """;

    private static String now() {
        return LocalDateTime.now().format(FMT);
    }

    // ===================== 环境规格 =====================
    public EnvironmentSpec saveEnv(EnvironmentSpec env) {
        env.updatedAt = LocalDateTime.now();
        String sql = "INSERT INTO env_specs(id, name, data, updated_at) VALUES(?,?,?,?) " +
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data, updated_at=excluded.updated_at";
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            ps.setString(1, env.id);
            ps.setString(2, env.name);
            ps.setString(3, Json.toJson(env));
            ps.setString(4, now());
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("saveEnv 失败", e);
        }
        return env;
    }

    public List<EnvironmentSpec> listEnvs() {
        List<EnvironmentSpec> out = new ArrayList<>();
        try (Statement st = conn().createStatement();
             ResultSet rs = st.executeQuery("SELECT data FROM env_specs ORDER BY updated_at DESC")) {
            while (rs.next()) {
                out.add(Json.fromJson(rs.getString("data"), EnvironmentSpec.class));
            }
        } catch (Exception e) {
            throw new RuntimeException("listEnvs 失败", e);
        }
        return out;
    }

    public EnvironmentSpec getEnv(String envId) {
        try (PreparedStatement ps = conn().prepareStatement("SELECT data FROM env_specs WHERE id=?")) {
            ps.setString(1, envId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) return Json.fromJson(rs.getString("data"), EnvironmentSpec.class);
            }
        } catch (Exception e) {
            throw new RuntimeException("getEnv 失败", e);
        }
        return null;
    }

    public void deleteEnv(String envId) {
        try (PreparedStatement ps = conn().prepareStatement("DELETE FROM env_specs WHERE id=?")) {
            ps.setString(1, envId);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("deleteEnv 失败", e);
        }
    }

    // ===================== 安装包 =====================
    public PackageEntry savePackage(PackageEntry p) {
        String sql = "INSERT INTO packages(id, name, kind, data, created_at) VALUES(?,?,?,?,?) " +
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, data=excluded.data";
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            ps.setString(1, p.id);
            ps.setString(2, p.name);
            ps.setString(3, p.kind);
            ps.setString(4, Json.toJson(p));
            ps.setString(5, now());
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("savePackage 失败", e);
        }
        return p;
    }

    public List<PackageEntry> listPackages() {
        List<PackageEntry> out = new ArrayList<>();
        try (Statement st = conn().createStatement();
             ResultSet rs = st.executeQuery("SELECT data FROM packages ORDER BY created_at DESC")) {
            while (rs.next()) {
                out.add(Json.fromJson(rs.getString("data"), PackageEntry.class));
            }
        } catch (Exception e) {
            throw new RuntimeException("listPackages 失败", e);
        }
        return out;
    }

    public PackageEntry getPackage(String pid) {
        try (PreparedStatement ps = conn().prepareStatement("SELECT data FROM packages WHERE id=?")) {
            ps.setString(1, pid);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) return Json.fromJson(rs.getString("data"), PackageEntry.class);
            }
        } catch (Exception e) {
            throw new RuntimeException("getPackage 失败", e);
        }
        return null;
    }

    public void deletePackage(String pid) {
        PackageEntry p = getPackage(pid);
        if (p != null && p.path != null && !p.path.isEmpty()) {
            try { Files.deleteIfExists(Paths.get(p.path)); } catch (Exception ignored) {}
        }
        try (PreparedStatement ps = conn().prepareStatement("DELETE FROM packages WHERE id=?")) {
            ps.setString(1, pid);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("deletePackage 失败", e);
        }
    }

    // ===================== 分发任务 =====================
    public DistributionJob saveDistribution(DistributionJob d) {
        String sql = "INSERT INTO distributions(id, flow_id, data, created_at) VALUES(?,?,?,?) " +
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data";
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            ps.setString(1, d.id);
            ps.setString(2, d.flowId);
            ps.setString(3, Json.toJson(d));
            ps.setString(4, now());
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("saveDistribution 失败", e);
        }
        return d;
    }

    public DistributionJob getDistribution(String did) {
        try (PreparedStatement ps = conn().prepareStatement("SELECT data FROM distributions WHERE id=?")) {
            ps.setString(1, did);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) return Json.fromJson(rs.getString("data"), DistributionJob.class);
            }
        } catch (Exception e) {
            throw new RuntimeException("getDistribution 失败", e);
        }
        return null;
    }

    public List<DistributionJob> listDistributions(String flowId) {
        List<DistributionJob> out = new ArrayList<>();
        String sql;
        if (flowId != null) {
            sql = "SELECT data FROM distributions WHERE flow_id=? ORDER BY created_at DESC";
        } else {
            sql = "SELECT data FROM distributions ORDER BY created_at DESC LIMIT 100";
        }
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            if (flowId != null) ps.setString(1, flowId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(Json.fromJson(rs.getString("data"), DistributionJob.class));
                }
            }
        } catch (Exception e) {
            throw new RuntimeException("listDistributions 失败", e);
        }
        return out;
    }

    // ===================== 备份点 =====================
    public BackupPoint saveBackup(BackupPoint b) {
        String sql = "INSERT INTO backups(id, env_id, kind, data, created_at) VALUES(?,?,?,?,?) " +
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data";
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            ps.setString(1, b.id);
            ps.setString(2, b.envId);
            ps.setString(3, b.kind != null ? b.kind.getValue() : "");
            ps.setString(4, Json.toJson(b));
            ps.setString(5, now());
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("saveBackup 失败", e);
        }
        return b;
    }

    public List<BackupPoint> listBackups(String envId) {
        List<BackupPoint> out = new ArrayList<>();
        String sql = envId != null
                ? "SELECT data FROM backups WHERE env_id=? ORDER BY created_at DESC"
                : "SELECT data FROM backups ORDER BY created_at DESC";
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            if (envId != null) ps.setString(1, envId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(Json.fromJson(rs.getString("data"), BackupPoint.class));
                }
            }
        } catch (Exception e) {
            throw new RuntimeException("listBackups 失败", e);
        }
        return out;
    }

    public BackupPoint getBackup(String bid) {
        try (PreparedStatement ps = conn().prepareStatement("SELECT data FROM backups WHERE id=?")) {
            ps.setString(1, bid);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) return Json.fromJson(rs.getString("data"), BackupPoint.class);
            }
        } catch (Exception e) {
            throw new RuntimeException("getBackup 失败", e);
        }
        return null;
    }

    // ===================== 流程 =====================
    public InstallFlow saveFlow(InstallFlow f) {
        f.updatedAt = LocalDateTime.now();
        String sql = "INSERT INTO flows(id, name, env_id, status, data, created_at, updated_at) " +
                "VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET " +
                "name=excluded.name, status=excluded.status, data=excluded.data, updated_at=excluded.updated_at";
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            ps.setString(1, f.id);
            ps.setString(2, f.name);
            ps.setString(3, f.envId);
            ps.setString(4, f.status != null ? f.status.getValue() : "");
            ps.setString(5, Json.toJson(f));
            ps.setString(6, f.createdAt != null ? f.createdAt.format(FMT) : now());
            ps.setString(7, now());
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("saveFlow 失败", e);
        }
        return f;
    }

    public List<InstallFlow> listFlows(int limit) {
        List<InstallFlow> out = new ArrayList<>();
        try (PreparedStatement ps = conn().prepareStatement(
                "SELECT data FROM flows ORDER BY created_at DESC LIMIT ?")) {
            ps.setInt(1, limit);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(Json.fromJson(rs.getString("data"), InstallFlow.class));
                }
            }
        } catch (Exception e) {
            throw new RuntimeException("listFlows 失败", e);
        }
        return out;
    }

    public InstallFlow getFlow(String fid) {
        try (PreparedStatement ps = conn().prepareStatement("SELECT data FROM flows WHERE id=?")) {
            ps.setString(1, fid);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) return Json.fromJson(rs.getString("data"), InstallFlow.class);
            }
        } catch (Exception e) {
            throw new RuntimeException("getFlow 失败", e);
        }
        return null;
    }

    public void deleteFlow(String fid) {
        try (PreparedStatement ps = conn().prepareStatement("DELETE FROM flows WHERE id=?")) {
            ps.setString(1, fid);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("deleteFlow 失败", e);
        }
    }

    // ===================== 审计 =====================
    public void audit(String operator, String action, String target, String result) {
        audit(operator, action, target, result, "");
    }

    public void audit(String operator, String action, String target, String result, String detail) {
        String sql = "INSERT INTO audit(ts, operator, action, target, result, detail) VALUES(?,?,?,?,?,?)";
        try (PreparedStatement ps = conn().prepareStatement(sql)) {
            ps.setString(1, now());
            ps.setString(2, operator);
            ps.setString(3, action);
            ps.setString(4, target);
            ps.setString(5, result);
            ps.setString(6, detail == null ? "" : detail);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException("audit 失败", e);
        }
    }

    public List<Map<String, Object>> listAudit(int limit) {
        List<Map<String, Object>> out = new ArrayList<>();
        try (PreparedStatement ps = conn().prepareStatement(
                "SELECT * FROM audit ORDER BY id DESC LIMIT ?")) {
            ps.setInt(1, limit);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Map<String, Object> m = new HashMap<>();
                    m.put("id", rs.getLong("id"));
                    m.put("ts", rs.getString("ts"));
                    m.put("operator", rs.getString("operator"));
                    m.put("action", rs.getString("action"));
                    m.put("target", rs.getString("target"));
                    m.put("result", rs.getString("result"));
                    m.put("detail", rs.getString("detail"));
                    out.add(m);
                }
            }
        } catch (Exception e) {
            throw new RuntimeException("listAudit 失败", e);
        }
        return out;
    }
}
