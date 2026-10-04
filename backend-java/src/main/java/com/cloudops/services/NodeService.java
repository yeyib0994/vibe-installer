package com.cloudops.services;

import com.cloudops.core.Json;
import com.cloudops.model.NodeSpec;
import com.cloudops.model.enums.TransferMode;
import org.springframework.stereotype.Service;
import tools.jackson.core.type.TypeReference;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/** 节点接入层：SSH 采集、文件分发、远程命令执行。
 *
 * 双驱动：
 * - SshDriver  : 真实调用 ssh / scp / rsync 二进制
 * - MockDriver : 无凭据也能演示，返回可信的模拟数据
 */
@Service
public class NodeService {

    public static class CmdResult {
        public final boolean ok;
        public final String stdout;
        public final String stderr;
        public final int code;
        public final int durationMs;

        public CmdResult(boolean ok, String stdout, String stderr, int code, int durationMs) {
            this.ok = ok;
            this.stdout = stdout;
            this.stderr = stderr;
            this.code = code;
            this.durationMs = durationMs;
        }
    }

    /** POSIX 单引号包裹：把用户填写的目录/路径拼进远程命令时必须经过它。 */
    public static String shellQuote(String value) {
        return "'" + (value == null ? "" : value).replace("'", "'\\''") + "'";
    }

    public static CmdResult run(List<String> cmd, int timeout, String stdin) {
        long t0 = System.currentTimeMillis();
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(false);
            Process p = pb.start();
            if (stdin != null) {
                p.getOutputStream().write(stdin.getBytes(StandardCharsets.UTF_8));
                p.getOutputStream().close();
            }
            StringBuilder out = new StringBuilder();
            StringBuilder err = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) out.append(line).append("\n");
            }
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) err.append(line).append("\n");
            }
            boolean finished = p.waitFor(timeout, java.util.concurrent.TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                return new CmdResult(false, "", "命令超时(" + timeout + "s)", 124, (int) (System.currentTimeMillis() - t0));
            }
            int code = p.exitValue();
            return new CmdResult(code == 0, out.toString(), err.toString(), code, (int) (System.currentTimeMillis() - t0));
        } catch (java.io.IOException e) {
            return new CmdResult(false, "", "命令不存在: " + e.getMessage(), 127, (int) (System.currentTimeMillis() - t0));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new CmdResult(false, "", "命令被中断", 130, (int) (System.currentTimeMillis() - t0));
        }
    }

    // ===================== Python 预检脚本 =====================
    /** 脚本路径是相对的，取决于进程工作目录（IDE 里是仓库根，直接 java -jar 时通常是 backend-java）。 */
    private static final String[] SCRIPT_CANDIDATES = {
            "scripts/precheck.py", "../scripts/precheck.py", "backend-java/scripts/precheck.py"};

    private static volatile Path cachedScript;
    private static volatile List<String> cachedPython;

    /** 可用 CLOUDOPS_PRECHECK_SCRIPT 指定绝对路径。 */
    private static Path precheckScript() {
        Path cached = cachedScript;
        if (cached != null) return cached;
        String override = System.getenv("CLOUDOPS_PRECHECK_SCRIPT");
        if (override != null && !override.isBlank()) {
            Path p = Paths.get(override).toAbsolutePath();
            if (Files.isRegularFile(p)) {
                cachedScript = p;
                return p;
            }
        }
        for (String rel : SCRIPT_CANDIDATES) {
            Path p = Paths.get(rel).toAbsolutePath().normalize();
            if (Files.isRegularFile(p)) {
                cachedScript = p;
                return p;
            }
        }
        return null;
    }

    /**
     * 挑一个真正能用的 Python 解释器，并强制 UTF-8 输出。
     * Windows 上 python3 常是 Microsoft Store 别名，ProcessBuilder 能启动它但进程以 49 退出，
     * 所以必须实跑一次而不是只看 PATH；不带 -X utf8 时 stdout 走 GBK，Java 按 UTF-8 解码会得到乱码。
     */
    private static List<String> pythonCmd() {
        List<String> cached = cachedPython;
        if (cached != null) return cached;
        List<String> names = new ArrayList<>();
        String override = System.getenv("CLOUDOPS_PYTHON");
        if (override != null && !override.isBlank()) names.add(override);
        names.add("python3");
        names.add("python");
        names.add("py");
        for (String exe : names) {
            List<String> prefix = exe.equals("py") ? List.of("py", "-3") : List.of(exe);
            List<String> probe = new ArrayList<>(prefix);
            probe.addAll(List.of("-X", "utf8", "-c", "print(1)"));
            CmdResult r = run(probe, 20, null);
            if (r.ok && r.stdout.contains("1")) {
                cachedPython = new ArrayList<>(prefix);
                cachedPython.addAll(List.of("-X", "utf8"));
                return cachedPython;
            }
        }
        return null;
    }

    /** 调用 Python 预检脚本，返回 [ok, report, issues]。 */
    @SuppressWarnings("unchecked")
    public static Object[] runPrecheckScript(NodeSpec node, boolean mock) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("hostname", node.hostname);
        payload.put("ip", node.ip);
        payload.put("ssh_port", node.sshPort);
        payload.put("ssh_user", node.sshUser);
        payload.put("ssh_key_path", node.sshKeyPath == null ? "" : node.sshKeyPath);
        payload.put("vcpu", node.vcpu);
        payload.put("memory_gb", node.memoryGb);
        payload.put("disk_gb", node.diskGb);
        payload.put("mock", mock);

        String stdin = Json.toJson(payload);
        Path script = precheckScript();
        List<String> python = pythonCmd();
        if (script == null || python == null) {
            String what = script == null
                    ? "未找到预检脚本 scripts/precheck.py（可用环境变量 CLOUDOPS_PRECHECK_SCRIPT 指定绝对路径）"
                    : "未找到可用的 Python 解释器（已尝试 CLOUDOPS_PYTHON、python3、python、py）";
            return new Object[]{false, "预检无法执行: " + what, List.of(what)};
        }
        List<String> cmd = new ArrayList<>(python);
        cmd.add(script.toString());
        CmdResult r = run(cmd, 120, stdin);
        if (!r.ok || r.stdout.strip().isEmpty()) {
            String err = r.stderr.strip().isEmpty() ? r.stdout.strip() : r.stderr.strip();
            err = err.isEmpty() ? python.get(0) + " 退出码 " + r.code : err;
            return new Object[]{false, "预检脚本执行失败(" + python.get(0) + "): " + err,
                    List.of("预检脚本调用失败，请检查 Python 环境与 " + script)};
        }
        try {
            Map<String, Object> result = Json.mapper().readValue(r.stdout.strip(),
                    new TypeReference<Map<String, Object>>() {});
            boolean ok = Boolean.TRUE.equals(result.get("ok"));
            String report = result.get("report") != null ? result.get("report").toString() : "";
            List<String> issues = result.get("issues") != null
                    ? (List<String>) result.get("issues") : List.of();
            return new Object[]{ok, report, issues};
        } catch (Exception e) {
            return new Object[]{false, "预检脚本输出解析失败: " + e.getMessage(),
                    List.of("预检脚本 JSON 输出格式异常")};
        }
    }

    // ===================== 基础驱动 =====================
    public static abstract class BaseDriver {
        public boolean isMock = false;
        protected final NodeSpec node;

        protected BaseDriver(NodeSpec node) {
            this.node = node;
        }

        protected List<String> sshBase() {
            List<String> cmd = new ArrayList<>(List.of("ssh", "-o", "BatchMode=yes",
                    "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=8",
                    "-p", String.valueOf(node.sshPort)));
            if (node.sshKeyPath != null && !node.sshKeyPath.isEmpty()) {
                cmd.add("-i");
                cmd.add(node.sshKeyPath);
            }
            cmd.add(node.sshUser + "@" + node.ip);
            return cmd;
        }

        public CmdResult ssh(String remoteCmd, int timeout) {
            List<String> cmd = new ArrayList<>(sshBase());
            cmd.add(remoteCmd);
            return run(cmd, timeout, null);
        }

        public abstract Object[] probe();  // [ok, msg, infoMap]
        public abstract Object[] precheck();  // [ok, report, issuesList]
        public abstract Object[] push(String localPath, String remoteDir, TransferMode mode);  // [ok, out, size]
        public abstract Object[] pull(String remotePath, String localDir);  // [ok, out]
        public abstract Object[] remoteSha256(String remotePath);  // [ok, sum]
    }

    // ===================== 真实驱动 =====================
    public static class SshDriver extends BaseDriver {
        public SshDriver(NodeSpec node) {
            super(node);
            this.isMock = false;
        }

        @Override
        public Object[] probe() {
            CmdResult r = ssh("echo __OK__ && hostname && uname -r && cat /etc/os-release 2>/dev/null | head -2", 30);
            if (!r.ok || !r.stdout.contains("__OK__")) {
                return new Object[]{false, "SSH 不可达: " + (r.stderr.strip().isEmpty() ? "认证失败" : r.stderr.strip()), new HashMap<>()};
            }
            List<String> lines = new ArrayList<>();
            for (String l : r.stdout.split("\n")) {
                String s = l.strip();
                if (!s.isEmpty() && !s.equals("__OK__")) lines.add(s);
            }
            String hostname = lines.isEmpty() ? node.hostname : lines.get(0);
            String kernel = lines.size() > 1 ? lines.get(1) : "";
            String osRelease = lines.size() > 2 ? String.join(" ", lines.subList(2, lines.size())).substring(0, Math.min(120, String.join(" ", lines.subList(2, lines.size())).length())) : "";

            Map<String, Object> info = new HashMap<>();
            info.put("hostname", hostname);
            info.put("kernel", kernel);
            info.put("os_release", osRelease);

            CmdResult r2 = ssh("nproc; free -g | awk '/Mem:/{print $2}'; df -BG / | awk 'NR==2{print $4}' | tr -d G", 30);
            if (r2.ok) {
                String[] vals = r2.stdout.trim().split("\\s+");
                try {
                    if (vals.length > 0) info.put("cpu_cores", Integer.parseInt(vals[0].trim()));
                    if (vals.length > 1) info.put("mem_total_gb", Double.parseDouble(vals[1].trim()));
                    if (vals.length > 2) info.put("disk_free_gb", Double.parseDouble(vals[2].trim()));
                } catch (NumberFormatException ignored) {}
            }
            return new Object[]{true, hostname + " 可达 (" + info.getOrDefault("os_release", "未知系统").toString().substring(0, Math.min(40, info.getOrDefault("os_release", "未知系统").toString().length())) + ")", info};
        }

        @Override
        public Object[] precheck() {
            // 委托给 Python 预检脚本，便于扩展检查项
            return runPrecheckScript(node, false);
        }

        @Override
        public Object[] push(String localPath, String remoteDir, TransferMode mode) {
            long size = 0;
            try { size = Files.size(Paths.get(localPath)); } catch (Exception ignored) {}
            ssh("mkdir -p " + shellQuote(remoteDir), 30);

            if (mode == TransferMode.RSYNC) {
                StringBuilder sshCmd = new StringBuilder();
                List<String> base = sshBase();
                for (int i = 0; i < base.size() - 1; i++) sshCmd.append(base.get(i)).append(" ");
                if (node.sshKeyPath != null && !node.sshKeyPath.isEmpty()) sshCmd.append("-i ").append(node.sshKeyPath).append(" ");
                sshCmd.append("-p ").append(node.sshPort);
                List<String> cmd = List.of("rsync", "-az", "--partial", "--inplace",
                        "-e", sshCmd.toString(), localPath, node.sshUser + "@" + node.ip + ":" + remoteDir + "/");
                CmdResult r = run(cmd, 3600, null);
                if (r.ok || !r.stderr.toLowerCase().contains("command not found")) {
                    return new Object[]{r.ok, (r.stdout + r.stderr).strip(), size};
                }
            }

            List<String> cmd = new ArrayList<>(List.of("scp", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                    "-P", String.valueOf(node.sshPort)));
            if (node.sshKeyPath != null && !node.sshKeyPath.isEmpty()) {
                cmd.add("-i");
                cmd.add(node.sshKeyPath);
            }
            cmd.add(localPath);
            cmd.add(node.sshUser + "@" + node.ip + ":" + remoteDir + "/");
            CmdResult r = run(cmd, 3600, null);
            return new Object[]{r.ok, (r.stdout + r.stderr).strip(), size};
        }

        @Override
        public Object[] pull(String remotePath, String localDir) {
            try { Files.createDirectories(Paths.get(localDir)); } catch (Exception ignored) {}
            List<String> cmd = new ArrayList<>(List.of("scp", "-r", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                    "-P", String.valueOf(node.sshPort)));
            if (node.sshKeyPath != null && !node.sshKeyPath.isEmpty()) {
                cmd.add("-i");
                cmd.add(node.sshKeyPath);
            }
            cmd.add(node.sshUser + "@" + node.ip + ":" + remotePath);
            cmd.add(localDir);
            CmdResult r = run(cmd, 7200, null);
            return new Object[]{r.ok, (r.stdout + r.stderr).strip()};
        }

        @Override
        public Object[] remoteSha256(String remotePath) {
            CmdResult r = ssh("sha256sum " + shellQuote(remotePath) + " 2>/dev/null | awk '{print $1}'", 30);
            return new Object[]{r.ok && !r.stdout.strip().isEmpty(), r.stdout.strip()};
        }
    }

    // ===================== 模拟驱动 =====================
    public static class MockDriver extends BaseDriver {
        public MockDriver(NodeSpec node) {
            super(node);
            this.isMock = true;
        }

        private long seed() {
            try {
                MessageDigest md = MessageDigest.getInstance("MD5");
                byte[] d = md.digest(node.ip.getBytes());
                long v = 0;
                for (int i = 0; i < 3; i++) v = (v << 8) | (d[i] & 0xff);
                return v;
            } catch (Exception e) {
                return node.ip.hashCode();
            }
        }

        @Override
        public Object[] probe() {
            long seed = seed();
            Random rnd = new Random(seed);
            Map<String, Object> info = new HashMap<>();
            info.put("hostname", node.hostname);
            info.put("kernel", "5.14.0-284.el9.x86_64");
            info.put("os_release", "NAME=\"Red Hat Enterprise Linux\" VERSION_ID=\"9.2\"");
            info.put("cpu_cores", node.vcpu != null ? node.vcpu : rndChoice(rnd, 8, 16, 24, 32));
            info.put("mem_total_gb", (double) (node.memoryGb != null ? node.memoryGb : rndChoice(rnd, 16, 32, 64, 128)));
            info.put("disk_free_gb", (double) (node.diskGb != null ? node.diskGb : rndChoice(rnd, 200, 500, 1000)));
            return new Object[]{true, "[MOCK] " + node.hostname + " (" + node.ip + ") SSH 可达", info};
        }

        private static int rndChoice(Random r, int... vals) {
            return vals[r.nextInt(vals.length)];
        }

        @Override
        public Object[] precheck() {
            // 委托给 Python 预检脚本（mock 模式），便于扩展检查项
            return runPrecheckScript(node, true);
        }

        @Override
        public Object[] push(String localPath, String remoteDir, TransferMode mode) {
            long size = 0;
            try { size = Files.size(Paths.get(localPath)); } catch (Exception ignored) {}
            try { Thread.sleep(300 + (long) (Math.random() * 500)); } catch (InterruptedException ignored) {}
            return new Object[]{true, "[MOCK] " + mode.getValue() + " → " + node.hostname + ":" + remoteDir + " (" + size + " 字节)", size};
        }

        @Override
        public Object[] pull(String remotePath, String localDir) {
            try { Files.createDirectories(Paths.get(localDir)); } catch (Exception ignored) {}
            try { Thread.sleep(200); } catch (InterruptedException ignored) {}
            return new Object[]{true, "[MOCK] 已从 " + node.hostname + ":" + remotePath + " 拉取到 " + localDir};
        }

        @Override
        public Object[] remoteSha256(String remotePath) {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] d = md.digest(remotePath.getBytes());
                StringBuilder sb = new StringBuilder();
                for (byte b : d) sb.append(String.format("%02x", b));
                return new Object[]{true, sb.toString()};
            } catch (Exception e) {
                return new Object[]{true, ""};
            }
        }
    }

    // ===================== 工厂 =====================
    public boolean forceMock() {
        String v = System.getenv("CLOUDOPS_FORCE_MOCK");
        return v != null && !v.isEmpty() && !v.equals("0") && !v.equalsIgnoreCase("false");
    }

    public BaseDriver getDriver(NodeSpec node) {
        if (forceMock()) return new MockDriver(node);
        if (node.sshKeyPath != null && !node.sshKeyPath.isEmpty() && sshAvailable()) {
            return new SshDriver(node);
        }
        return new MockDriver(node);
    }

    public boolean sshAvailable() {
        return which("ssh") && which("scp");
    }

    public boolean rsyncAvailable() {
        return which("rsync");
    }

    private static boolean which(String cmd) {
        String[] check = System.getProperty("os.name").toLowerCase().contains("win")
                ? new String[]{"where", cmd}
                : new String[]{"which", cmd};
        CmdResult r = run(List.of(check[0], check[1]), 10, null);
        return r.ok;
    }
}
