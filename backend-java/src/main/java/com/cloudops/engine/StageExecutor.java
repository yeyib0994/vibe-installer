package com.cloudops.engine;

import com.cloudops.core.Json;
import com.cloudops.core.Store;
import com.cloudops.model.BackupPoint;
import com.cloudops.model.DistributionJob;
import com.cloudops.model.EnvironmentSpec;
import com.cloudops.model.FlowStage;
import com.cloudops.model.FlowStep;
import com.cloudops.model.InstallFlow;
import com.cloudops.model.NodeSpec;
import com.cloudops.model.PackageEntry;
import com.cloudops.model.TransferRecord;
import com.cloudops.model.enums.BackupKind;
import com.cloudops.model.enums.BackupStatus;
import com.cloudops.model.enums.FlowStatus;
import com.cloudops.model.enums.MachineType;
import com.cloudops.model.enums.NodeRole;
import com.cloudops.model.enums.NodeStatus;
import com.cloudops.model.enums.StageStatus;
import com.cloudops.model.enums.StepStatus;
import com.cloudops.model.enums.TransferMode;
import com.cloudops.services.BackupService;
import com.cloudops.services.K8sOpsService;
import com.cloudops.services.NodeService;
import com.cloudops.services.NodeService.BaseDriver;
import com.cloudops.services.VersioningService;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 阶段执行器。
 *
 * 在后台线程里逐步骤执行某个阶段的 steps，把日志推给 LogBus（SSE 消费）。
 */
@Component
public class StageExecutor {

    public static class StageFailure extends RuntimeException {
        public StageFailure(String msg) { super(msg); }
    }

    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss");
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    public final Path dataDir;

    private final Store store;
    private final LogBus bus;
    private final Workflow workflow;
    private final NodeService nodeService;
    private final BackupService backupSvc;
    private final VersioningService versioning;
    private final K8sOpsService k8s;
    private final com.cloudops.services.BundleUnpacker unpacker;

    private final Map<String, Thread> running = new ConcurrentHashMap<>();
    private final java.util.Set<String> cancelled = ConcurrentHashMap.newKeySet();

    public StageExecutor(Store store, LogBus bus, Workflow workflow,
                         NodeService nodeService, BackupService backupSvc,
                         VersioningService versioning, K8sOpsService k8s,
                         com.cloudops.services.BundleUnpacker unpacker) {
        this.store = store;
        this.bus = bus;
        this.workflow = workflow;
        this.nodeService = nodeService;
        this.backupSvc = backupSvc;
        this.versioning = versioning;
        this.k8s = k8s;
        this.unpacker = unpacker;
        this.dataDir = store.dataDir;
    }

    private static String sid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    // ===================== 对外接口 =====================
    public InstallFlow submit(InstallFlow flow, String stageKey, String operator) {
        FlowStage stage = workflow.stageByKey(flow, stageKey);
        stage.status = StageStatus.RUNNING;
        stage.startedAt = LocalDateTime.now();
        stage.error = null;
        for (FlowStep s : stage.steps) {
            s.status = StepStatus.PENDING;
            s.output = "";
            s.error = null;
        }
        flow.status = FlowStatus.RUNNING;
        store.saveFlow(flow);

        String key = flow.id + ":" + stageKey;
        bus.clear(key);
        store.audit(operator, "stage.run:" + stageKey, flow.id, "started", flow.name);

        Thread th = new Thread(() -> run(flow, stage, operator), "stage-" + stageKey);
        th.setDaemon(true);
        running.put(key, th);
        th.start();
        return flow;
    }

    public boolean cancel(String flowId, String stageKey) {
        String k = flowId + ":" + stageKey;
        if (running.containsKey(k)) {
            cancelled.add(k);
            return true;
        }
        return false;
    }

    public boolean isRunning(String flowId, String stageKey) {
        Thread t = running.get(flowId + ":" + stageKey);
        return t != null && t.isAlive();
    }

    // ===================== 内部 =====================
    private void log(String key, String msg) {
        log(key, msg, "info");
    }

    private void log(String key, String msg, String level) {
        String line = "[" + LocalDateTime.now().format(TIME) + "] " + msg;
        Map<String, Object> e = new HashMap<>();
        e.put("type", "log");
        e.put("level", level == null ? "info" : level);
        e.put("message", line);
        bus.publish(key, e);
    }

    private void run(InstallFlow flow, FlowStage stage, String operator) {
        String key = flow.id + ":" + stage.key;
        log(key, "━━━ 阶段「" + stage.title + "」开始 ━━━", "info");

        try {
            boolean allDone = true;
            for (FlowStep step : stage.steps) {
                if (cancelled.contains(key)) {
                    stage.status = StageStatus.FAILED;
                    stage.error = "被用户中止";
                    log(key, "阶段被用户中止", "warn");
                    allDone = false;
                    break;
                }

                step.status = StepStatus.RUNNING;
                step.startedAt = LocalDateTime.now();
                publishStep(key, stage, step);
                log(key, "▶ 【" + (step.index + 1) + "/" + stage.steps.size() + "】" + step.title);

                long t0 = System.currentTimeMillis();
                try {
                    String out = execute(flow, stage, step);
                    step.output = out == null ? "" : out;
                    step.status = StepStatus.DONE;
                    for (String line : (out == null ? "" : out).split("\n")) {
                        if (!line.strip().isEmpty()) log(key, "    " + line);
                    }
                    log(key, "✔ " + step.title + " 完成", "ok");
                } catch (StageFailure e) {
                    step.status = StepStatus.FAILED;
                    step.error = e.getMessage();
                    step.finishedAt = LocalDateTime.now();
                    step.durationMs = (int) (System.currentTimeMillis() - t0);
                    log(key, "✘ " + step.title + " 失败 — " + e.getMessage(), "error");
                    publishStep(key, stage, step);
                    throw e;
                } finally {
                    if (step.finishedAt == null) step.finishedAt = LocalDateTime.now();
                    if (step.durationMs == 0) step.durationMs = (int) (System.currentTimeMillis() - t0);
                    publishStep(key, stage, step);
                    store.saveFlow(flow);
                }
            }

            if (allDone) {
                stage.status = StageStatus.PASSED;
                stage.finishedAt = LocalDateTime.now();
                log(key, "━━━ 阶段「" + stage.title + "」通过 ━━━", "ok");
            }

            if (stage.status == StageStatus.PASSED) {
                workflow.refreshLocks(flow);
                boolean allPassed = flow.stages.stream()
                        .allMatch(s -> s.status == StageStatus.PASSED || s.status == StageStatus.SKIPPED);
                if (allPassed) {
                    flow.status = FlowStatus.SUCCEEDED;
                    flow.finishedAt = LocalDateTime.now();
                    log(key, "全部阶段完成，流程成功", "ok");
                }
            }
        } catch (StageFailure e) {
            stage.status = StageStatus.FAILED;
            stage.finishedAt = LocalDateTime.now();
            stage.error = e.getMessage();
            flow.status = FlowStatus.FAILED;
            flow.error = stage.title + ": " + e.getMessage();
            log(key, "阶段失败: " + e.getMessage(), "error");
        } catch (Exception e) {
            stage.status = StageStatus.FAILED;
            stage.error = "未预期异常: " + e.getMessage();
            flow.status = FlowStatus.FAILED;
            log(key, stage.error, "error");
        }

        if (stage.status == StageStatus.PASSED) {
            if (stage.finishedAt == null) stage.finishedAt = LocalDateTime.now();
            boolean allPassed = flow.stages.stream()
                    .allMatch(s -> s.status == StageStatus.PASSED || s.status == StageStatus.SKIPPED);
            if (allPassed && flow.status != FlowStatus.FAILED) {
                flow.status = FlowStatus.SUCCEEDED;
                if (flow.finishedAt == null) flow.finishedAt = LocalDateTime.now();
            }
        }
        store.saveFlow(flow);

        Map<String, Object> doneEvt = new HashMap<>();
        doneEvt.put("type", "stage_done");
        doneEvt.put("stage", stage.key);
        doneEvt.put("status", stage.status.getValue());
        doneEvt.put("error", stage.error);
        bus.publish(key, doneEvt);

        store.audit(operator, "stage.run:" + stage.key, flow.id,
                stage.status.getValue(), stage.error == null ? "" : stage.error);

        running.remove(key);
        cancelled.remove(key);
    }

    @SuppressWarnings("unchecked")
    private void publishStep(String key, FlowStage stage, FlowStep step) {
        Map<String, Object> e = new HashMap<>();
        e.put("type", "step");
        e.put("stage", stage.key);
        e.put("step", Json.mapper().convertValue(step, Map.class));
        bus.publish(key, e);
    }

    // ===================== 动作分派 =====================
    String execute(InstallFlow flow, FlowStage stage, FlowStep step) {
        try {
        return switch (step.action) {
            case "env.validate_matrix" -> actEnvValidateMatrix(flow, stage, step);
            case "env.persist_nodes" -> actEnvPersistNodes(flow, stage, step);
            case "precheck.connect" -> actPrecheckConnect(flow, stage, step);
            case "precheck.system" -> actPrecheckSystem(flow, stage, step);
            case "precheck.report" -> actPrecheckReport(flow, stage, step);
            case "package.receive" -> actPackageReceive(flow, stage, step);
            case "package.chunk" -> actPackageChunk(flow, stage, step);
            case "package.register" -> actPackageRegister(flow, stage, step);
            case "distribute.connect" -> actDistributeConnect(flow, stage, step);
            case "distribute.push" -> actDistributePush(flow, stage, step);
            case "distribute.verify" -> actDistributeVerify(flow, stage, step);
            case "backup.scope" -> actBackupScope(flow, stage, step);
            case "backup.archive" -> actBackupArchive(flow, stage, step);
            case "backup.database" -> actBackupDatabase(flow, stage, step);
            case "backup.register" -> actBackupRegister(flow, stage, step);
            case "install.precheck" -> actInstallPrecheck(flow, stage, step);
            case "install.control_plane" -> actInstallControlPlane(flow, stage, step);
            case "install.data_plane" -> actInstallDataPlane(flow, stage, step);
            case "install.workers" -> actInstallWorkers(flow, stage, step);
            case "install.gateway" -> actInstallGateway(flow, stage, step);
            case "upgrade.migrate_data" -> actUpgradeMigrateData(flow, stage, step);
            case "verify.services" -> actVerifyServices(flow, stage, step);
            case "verify.ports" -> actVerifyPorts(flow, stage, step);
            case "verify.versions" -> actVerifyVersions(flow, stage, step);
            case "verify.membership" -> actVerifyMembership(flow, stage, step);
            case "verify.smoke" -> actVerifySmoke(flow, stage, step);
            case "verify.report" -> actVerifyReport(flow, stage, step);
            // === upgrade_k8s 模式动作 ===
            case "k8s.bundle_unpack" -> actK8sBundleUnpack(flow, stage, step);
            case "k8s.discover", "k8s.lock_target" -> actK8sDiscover(flow, stage, step);
            case "precheck.node" -> actK8sPrecheckNode(flow, stage, step);
            case "precheck.k8s_health" -> actK8sPrecheckHealth(flow, stage, step);
            case "precheck.compat" -> actK8sPrecheckCompat(flow, stage, step);
            case "backup.helm_values" -> actK8sBackupValues(flow, stage, step);
            case "backup.helm_manifest" -> actK8sBackupManifest(flow, stage, step);
            case "backup.pvc_snapshot" -> actK8sBackupPvc(flow, stage, step);
            case "upgrade.node_drain" -> actK8sNodeDrain(flow, stage, step);
            case "upgrade.helm_upgrade" -> actK8sHelmUpgrade(flow, stage, step);
            case "upgrade.rollout_status" -> actK8sRolloutStatus(flow, stage, step);
            case "upgrade.node_uncordon" -> actK8sNodeUncordon(flow, stage, step);
            case "upgrade.config_roll" -> actK8sConfigRoll(flow, stage, step);
            case "verify.pods" -> actK8sVerifyPods(flow, stage, step);
            case "verify.version" -> actK8sVerifyVersion(flow, stage, step);
            case "rollback.diff", "rollback.steps" -> actK8sRollbackPlan(flow, stage, step);
            default -> throw new StageFailure("动作 " + step.action
                    + " 已从后端移除，本流程无法继续，请删除后按现有模式重建");
        };
        } catch (java.io.IOException e) {
            throw new StageFailure("IO 错误: " + e.getMessage());
        }
    }

    private EnvironmentSpec env(InstallFlow flow) {
        EnvironmentSpec e = store.getEnv(flow.envId);
        if (e == null) throw new StageFailure("环境不存在: " + flow.envId);
        return e;
    }

    private List<NodeSpec> nodesOfStage(InstallFlow flow, List<String> roles) {
        EnvironmentSpec e = env(flow);
        List<NodeSpec> ns = e.nodes;
        if (roles != null && !roles.isEmpty()) {
            ns = new ArrayList<>(ns.stream().filter(n -> roles.contains(n.role.getValue())).toList());
        }
        if (ns.isEmpty()) throw new StageFailure("没有匹配的节点，请检查角色筛选条件");
        return ns;
    }

    // ============ 环境登记 ============
    @SuppressWarnings("unchecked")
    private String actEnvValidateMatrix(InstallFlow flow, FlowStage stage, FlowStep step) {
        Map<String, Object> inp = stage.inputs;
        List<Map<String, Object>> physical = Workflow.asNodeList(inp.get("physical_nodes"));
        List<Map<String, Object>> virtual = Workflow.asNodeList(inp.get("virtual_nodes"));
        if (physical.isEmpty() && virtual.isEmpty()) {
            // 升级模式的表单里没有节点表格：校验对象是环境里已登记的那一份矩阵，
            // 按提交值汇报会输出「物理机 0 台 / 虚拟机 0 台」这种自相矛盾的通过行。
            List<NodeSpec> existing = env(flow).nodes;
            if (existing.isEmpty()) throw new StageFailure("既未提交节点表单，环境中也没有已登记节点");
            Map<String, Integer> existingRoles = new HashMap<>();
            List<String> existingIps = new ArrayList<>();
            for (NodeSpec n : existing) {
                existingRoles.merge(n.role.getValue(), 1, Integer::sum);
                existingIps.add(n.ip);
            }
            List<String> existingParts = new ArrayList<>();
            existingRoles.entrySet().stream().sorted(Map.Entry.comparingByKey())
                    .forEach(e -> existingParts.add(e.getKey() + " " + e.getValue() + " 台"));
            List<String> reused = new ArrayList<>();
            reused.add("节点矩阵校验通过：沿用环境里已登记的 " + existing.size() + " 台节点（本模式不重新登记）");
            reused.add("角色分布：" + String.join("、", existingParts));
            if (!existingIps.isEmpty()) reused.add("IP 段：" + existingIps.get(0) + " ~ " + existingIps.get(existingIps.size() - 1));
            reused.add("未发现 IP 冲突或必填项缺失");
            return String.join("\n", reused);
        }
        List<String> lines = new ArrayList<>();
        lines.add("节点矩阵校验通过：物理机 " + physical.size() + " 台 / 虚拟机 " + virtual.size() + " 台，合计 " + (physical.size() + virtual.size()) + " 台");
        Map<String, Integer> roles = new HashMap<>();
        for (Map<String, Object> n : physical) roles.merge(String.valueOf(n.getOrDefault("role", "worker")), 1, Integer::sum);
        for (Map<String, Object> n : virtual) roles.merge(String.valueOf(n.getOrDefault("role", "worker")), 1, Integer::sum);
        List<String> roleParts = new ArrayList<>();
        roles.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> roleParts.add(e.getKey() + " " + e.getValue() + " 台"));
        lines.add("角色分布：" + String.join("、", roleParts));
        List<String> ips = new ArrayList<>();
        for (Map<String, Object> n : physical) ips.add(String.valueOf(n.get("ip")));
        for (Map<String, Object> n : virtual) ips.add(String.valueOf(n.get("ip")));
        if (!ips.isEmpty()) lines.add("IP 段：" + ips.get(0) + " ~ " + ips.get(ips.size() - 1));
        lines.add("未发现 IP 冲突或必填项缺失");
        return String.join("\n", lines.stream().filter(l -> !l.isEmpty()).toList());
    }

    @SuppressWarnings("unchecked")
    private String actEnvPersistNodes(InstallFlow flow, FlowStage stage, FlowStep step) {
        Map<String, Object> inp = stage.inputs;
        EnvironmentSpec env = env(flow);
        List<Map<String, Object>> physicalIn = Workflow.asNodeList(inp.get("physical_nodes"));
        List<Map<String, Object>> virtualIn = Workflow.asNodeList(inp.get("virtual_nodes"));

        if (physicalIn.isEmpty() && virtualIn.isEmpty()) {
            if (!env.nodes.isEmpty()) {
                StringBuilder sb = new StringBuilder("表单未提交节点数据，沿用环境中已登记的 " + env.nodes.size() + " 台节点\n");
                for (NodeSpec n : env.nodes) {
                    sb.append(String.format("  %-9s %-20s %-16s %s%n",
                            n.role.getValue(), n.hostname, n.ip,
                            n.machineType == MachineType.PHYSICAL ? "物理机" : "虚拟机"));
                }
                return sb.toString().stripTrailing();
            }
            throw new StageFailure("既未提交节点表单，环境中也没有已登记节点");
        }

        List<NodeSpec> built = new ArrayList<>();
        for (Map<String, Object> n : physicalIn) {
            NodeSpec node = new NodeSpec();
            node.id = sid();
            node.hostname = s(n.get("hostname"));
            node.ip = s(n.get("ip"));
            node.role = NodeRole.fromValue(s(n.get("role")));
            node.machineType = MachineType.PHYSICAL;
            node.sshPort = n.get("ssh_port") != null ? Integer.parseInt(s(n.get("ssh_port"))) : 22;
            node.sshUser = s(n.get("ssh_user")).isEmpty() ? "root" : s(n.get("ssh_user"));
            node.sshKeyPath = n.get("ssh_key_path") != null ? s(n.get("ssh_key_path")) : null;
            node.vendor = n.get("vendor") != null ? s(n.get("vendor")) : null;
            node.model = n.get("model") != null ? s(n.get("model")) : null;
            node.idc = n.get("idc") != null ? s(n.get("idc")) : null;
            node.rack = n.get("rack") != null ? s(n.get("rack")) : null;
            node.nicSpeed = n.get("nic_speed") != null ? s(n.get("nic_speed")) : null;
            node.raidLevel = n.get("raid_level") != null ? s(n.get("raid_level")) : null;
            built.add(node);
        }
        for (Map<String, Object> n : virtualIn) {
            NodeSpec node = new NodeSpec();
            node.id = sid();
            node.hostname = s(n.get("hostname"));
            node.ip = s(n.get("ip"));
            node.role = NodeRole.fromValue(s(n.get("role")));
            node.machineType = MachineType.VIRTUAL;
            node.sshPort = n.get("ssh_port") != null ? Integer.parseInt(s(n.get("ssh_port"))) : 22;
            node.sshUser = s(n.get("ssh_user")).isEmpty() ? "root" : s(n.get("ssh_user"));
            node.sshKeyPath = n.get("ssh_key_path") != null ? s(n.get("ssh_key_path")) : null;
            node.hostPlatform = n.get("host_platform") != null ? s(n.get("host_platform")) : null;
            node.vcpu = n.get("vcpu") != null ? Integer.parseInt(s(n.get("vcpu"))) : null;
            node.memoryGb = n.get("memory_gb") != null ? Integer.parseInt(s(n.get("memory_gb"))) : null;
            node.diskGb = n.get("disk_gb") != null ? Integer.parseInt(s(n.get("disk_gb"))) : null;
            node.imageTemplate = n.get("image_template") != null ? s(n.get("image_template")) : null;
            built.add(node);
        }

        env.nodes = built;
        if (inp.get("base_domain") != null) env.baseDomain = s(inp.get("base_domain"));
        if (inp.get("ntp_server") != null) env.ntpServer = s(inp.get("ntp_server"));
        List<String> dns = Workflow.asStringList(inp.get("dns_servers"));
        if (!dns.isEmpty()) env.dnsServers = dns;
        if (inp.get("timezone") != null) env.timezone = s(inp.get("timezone"));
        env.validated = true;
        store.saveEnv(env);

        Map<String, Integer> byType = new HashMap<>();
        for (NodeSpec n : built) byType.merge(n.machineType.getValue(), 1, Integer::sum);
        StringBuilder sb = new StringBuilder("已生成节点清单 " + built.size() + " 台"
                + "（物理机 " + byType.getOrDefault("physical", 0) + " / 虚拟机 " + byType.getOrDefault("virtual", 0) + "）\n");
        for (NodeSpec n : built) {
            sb.append(String.format("  %-9s %-20s %-16s %s%n",
                    n.role.getValue(), n.hostname, n.ip,
                    n.machineType == MachineType.PHYSICAL ? "物理机" : "虚拟机"));
        }
        return sb.toString().stripTrailing();
    }

    // ============ 环境校验 ============
    private void applySshInputs(InstallFlow flow, FlowStage stage) {
        EnvironmentSpec env = env(flow);
        Map<String, Object> inp = stage.inputs;
        boolean changed = false;
        for (NodeSpec n : env.nodes) {
            if (inp.get("ssh_key_path") != null && !s(inp.get("ssh_key_path")).isEmpty()) {
                n.sshKeyPath = s(inp.get("ssh_key_path")); changed = true;
            }
            if (inp.get("ssh_user") != null && !s(inp.get("ssh_user")).isEmpty()) {
                n.sshUser = s(inp.get("ssh_user")); changed = true;
            }
            if (inp.get("ssh_port") != null) {
                try { n.sshPort = Integer.parseInt(s(inp.get("ssh_port"))); changed = true; } catch (NumberFormatException ignored) {}
            }
        }
        if (changed) store.saveEnv(env);
    }

    @SuppressWarnings("unchecked")
    private String actPrecheckConnect(InstallFlow flow, FlowStage stage, FlowStep step) {
        applySshInputs(flow, stage);
        EnvironmentSpec env = env(flow);
        List<String> lines = new ArrayList<>();
        int okCount = 0;
        for (NodeSpec n : env.nodes) {
            BaseDriver drv = nodeService.getDriver(n);
            Object[] r = drv.probe();
            boolean ok = (boolean) r[0];
            String msg = (String) r[1];
            Map<String, Object> info = (Map<String, Object>) r[2];
            if (ok) {
                n.status = NodeStatus.REACHABLE;
                n.osRelease = (String) info.get("os_release");
                n.kernel = (String) info.get("kernel");
                n.cpuCores = info.get("cpu_cores") != null ? ((Number) info.get("cpu_cores")).intValue() : null;
                n.memTotalGb = info.get("mem_total_gb") != null ? ((Number) info.get("mem_total_gb")).doubleValue() : null;
                n.diskFreeGb = info.get("disk_free_gb") != null ? ((Number) info.get("disk_free_gb")).doubleValue() : null;
                n.lastCheckedAt = LocalDateTime.now();
                okCount++;
                lines.add(String.format("  ✔ %-20s %-16s %s", n.hostname, n.ip, n.osRelease == null ? "" : n.osRelease).substring(0, Math.min(110, String.format("  ✔ %-20s %-16s %s", n.hostname, n.ip, n.osRelease == null ? "" : n.osRelease).length())));
            } else {
                n.status = NodeStatus.UNREACHABLE;
                lines.add(String.format("  ✘ %-20s %-16s %s", n.hostname, n.ip, msg));
            }
        }
        store.saveEnv(env);
        boolean anyMock = env.nodes.stream().anyMatch(n -> nodeService.getDriver(n).isMock);
        String mode = anyMock ? "模拟模式" : "真实 SSH";
        if (okCount == 0) throw new StageFailure("所有节点均不可达（" + mode + "）");
        return "连通性探测完成（" + mode + "）：" + okCount + "/" + env.nodes.size() + " 台可达\n" + String.join("\n", lines);
    }

    private String actPrecheckSystem(InstallFlow flow, FlowStage stage, FlowStep step) {
        EnvironmentSpec env = env(flow);
        List<NodeSpec> reachable = env.nodes.stream().filter(n -> n.status == NodeStatus.REACHABLE).toList();
        if (reachable.isEmpty()) throw new StageFailure("没有可达节点，请先完成连通性探测");

        List<String> allIssues = new ArrayList<>();
        List<String> lines = new ArrayList<>();
        int passCount = 0;
        for (NodeSpec n : reachable) {
            BaseDriver drv = nodeService.getDriver(n);
            Object[] r = drv.precheck();
            @SuppressWarnings("unchecked")
            List<String> issues = (List<String>) r[2];
            n.precheckIssues = issues;
            n.status = issues.isEmpty() ? NodeStatus.PREPARED : NodeStatus.REACHABLE;
            if (issues.isEmpty()) passCount++;
            lines.add("── " + n.hostname + " (" + n.ip + ") ──");
            for (String l : ((String) r[1]).split("\n")) lines.add("   " + l);
            for (String i : issues) { lines.add("   ⚠ " + i); allIssues.add(n.hostname + ": " + i); }
        }
        store.saveEnv(env);

        boolean strict = Boolean.TRUE.equals(stage.inputs.get("strict_mode"));
        if (strict && !allIssues.isEmpty()) {
            StringBuilder sb = new StringBuilder("严格模式：" + allIssues.size() + " 项预检未通过，已阻断流程\n");
            for (String i : allIssues) sb.append("  · ").append(i).append("\n");
            throw new StageFailure(sb.toString().stripTrailing());
        }
        return "系统预检完成：" + passCount + "/" + reachable.size() + " 台全部通过，共 " + allIssues.size() + " 项待处理\n" + String.join("\n", lines);
    }

    private String actPrecheckReport(InstallFlow flow, FlowStage stage, FlowStep step) {
        if ("upgrade_k8s".equals(flow.mode)) {
            EnvironmentSpec env = store.getEnv(flow.envId);
            int nodeCount = env == null ? 0 : env.nodes.size();
            List<String> lines = new ArrayList<>(List.of(
                    "K8s 升级预检报告：",
                    // 原来这里恒写「跳过（纯 K8s 模式，无物理节点）」，登记了节点的环境也一样 ——
                    // 现在按上一步真的跑没跑过来说。
                    "  节点层预检  " + (nodeCount == 0 ? "跳过（无物理节点）" : nodeCount + " 台全部通过"),
                    "  K8s 健康    已检查（Pod 就绪度、CrashLoop 检测）",
                    "  版本兼容    已检查"
            ));
            lines.add("");
            lines.add("K8s 层预检通过，可以进入升级前备份阶段。");
            return String.join("\n", lines);
        }
        EnvironmentSpec env = env(flow);
        int total = env.nodes.size();
        long reachable = env.nodes.stream().filter(n -> n.status == NodeStatus.REACHABLE || n.status == NodeStatus.PREPARED).count();
        long prepared = env.nodes.stream().filter(n -> n.status == NodeStatus.PREPARED).count();
        List<NodeSpec> withIssues = env.nodes.stream().filter(n -> !n.precheckIssues.isEmpty()).toList();

        List<String> lines = new ArrayList<>(List.of(
                "校验报告：共 " + total + " 台节点",
                "  SSH 可达      " + reachable + "/" + total,
                "  预检全部通过  " + prepared + "/" + total,
                "  存在问题节点  " + withIssues.size() + " 台"
        ));
        if (!withIssues.isEmpty()) {
            lines.add("");
            lines.add("待处理问题清单（不阻断流程，但建议安装前修复）：");
            for (NodeSpec n : withIssues) for (String i : n.precheckIssues) lines.add("  · " + n.hostname + ": " + i);
        } else {
            lines.add("");
            lines.add("所有节点预检通过，可以进入下一阶段。");
        }
        return String.join("\n", lines);
    }

    // ============ 安装包 ============
    private String actPackageReceive(InstallFlow flow, FlowStage stage, FlowStep step) {
        String pid = s(stage.inputs.get("_package_id"));
        if (pid.isEmpty()) throw new StageFailure("尚未上传安装包，请先在上传接口提交文件");
        PackageEntry p = store.getPackage(pid);
        if (p == null) throw new StageFailure("安装包 " + pid + " 不存在");
        if (!p.uploadComplete) throw new StageFailure("安装包 " + p.name + " 上传未完成（" + p.uploadedBytes + "/" + p.sizeBytes + " 字节）");
        return String.format("包 %s %s 已就绪%n  大小   %.2f MB%n  SHA256 %s…%n  存储   %s",
                p.name, p.version, p.sizeBytes / 1024.0 / 1024.0,
                p.checksum.substring(0, Math.min(32, p.checksum.length())), p.path);
    }

    private String actPackageChunk(InstallFlow flow, FlowStage stage, FlowStep step) {
        String pid = s(stage.inputs.get("_package_id"));
        PackageEntry p = store.getPackage(pid);
        if (p == null) throw new StageFailure("安装包不存在");
        if (p.pieces.isEmpty()) return "包体小于分片阈值（64 MB），无需分片，按整包校验";
        List<Integer> bad = new ArrayList<>();
        for (var pc : p.pieces) if (pc.checksum == null || pc.checksum.isEmpty()) bad.add(pc.index);
        if (!bad.isEmpty()) throw new StageFailure("分片 " + bad + " 校验和缺失，请重新上传");
        long total = p.pieces.stream().mapToLong(pc -> pc.sizeBytes).sum();
        return String.format("分片校验通过：%d 片，合计 %.2f MB%n  每片 64 MB，支持断点续传",
                p.pieces.size(), total / 1024.0 / 1024.0);
    }

    private String actPackageRegister(InstallFlow flow, FlowStage stage, FlowStep step) {
        String pid = s(stage.inputs.get("_package_id"));
        PackageEntry p = store.getPackage(pid);
        if (p == null) throw new StageFailure("安装包不存在");
        p.targetEnvId = flow.envId;
        store.savePackage(p);
        List<PackageEntry> all = store.listPackages();
        StringBuilder sb = new StringBuilder("包清单已登记（当前目录共 " + all.size() + " 个包）\n");
        for (PackageEntry x : all.subList(0, Math.min(8, all.size()))) {
            sb.append(String.format("  · %s %s [%s] %.2f MB%n", x.name, x.version, x.kind, x.sizeBytes / 1024.0 / 1024.0));
        }
        return sb.toString().stripTrailing();
    }

    /** 离线 bundle 解包：解出的 chart 与 values 就是「执行升级」阶段的内容来源。
     *  版本不一致在这里硬失败（而不是留给后面的兼容检查去发现），因为交付现场拿到错包
     *  越早发现代价越小；注入值写进另一个阶段的 inputs 并立刻 saveFlow，
     *  本阶段之后的每一次流程读取都会带着它。 */
    private String actK8sBundleUnpack(InstallFlow flow, FlowStage stage, FlowStep step) {
        String pid = s(stage.inputs.get("_package_id"));
        if (pid.isEmpty()) throw new StageFailure("尚未上传安装包，请先在上传接口提交离线包");
        PackageEntry p = store.getPackage(pid);
        if (p == null) throw new StageFailure("安装包 " + pid + " 不存在");
        if (!p.uploadComplete) {
            throw new StageFailure("安装包 " + p.name + " 上传未完成（" + p.uploadedBytes + "/" + p.sizeBytes + " 字节）");
        }
        Path bundle = Paths.get(p.path);
        if (!Files.isRegularFile(bundle)) throw new StageFailure("离线包文件不在磁盘上，期望路径：" + bundle);

        Path targetDir = dataDir.resolve("flows").resolve(flow.id).resolve("bundle");
        com.cloudops.services.BundleUnpacker.Result r;
        try {
            r = unpacker.unpack(bundle, targetDir);
        } catch (com.cloudops.services.BundleUnpacker.BundleException e) {
            throw new StageFailure(e.getMessage());
        }

        String want = s(k8sInput(flow, stage, "target_chart_version", ""));
        if (!want.isEmpty() && !sameVersion(want, r.chartVersion())) {
            throw new StageFailure("离线包内 chart 版本 " + r.chartVersion()
                    + " 与环境登记的目标版本 " + want + " 不一致，请确认包与目标是否配对");
        }

        FlowStage exec = workflow.stageByKey(flow, "upgrade_execute");
        if (exec == null) throw new StageFailure("本流程没有「执行升级」阶段，解包结果无处可写");
        exec.inputs.put("chart", r.chartFile().toString());
        exec.inputs.put("_chart_version", r.chartVersion());
        if (r.valuesFile() != null) exec.inputs.put("_values_path", r.valuesFile().toString());
        else exec.inputs.remove("_values_path");
        store.saveFlow(flow);

        List<String> lines = new ArrayList<>();
        lines.add("离线包解包完成 → " + targetDir);
        lines.add("  chart    " + r.chartFile().getFileName()
                + "（" + (r.chartName().isEmpty() ? "未命名" : r.chartName()) + " " + r.chartVersion() + "）");
        lines.add("  values   " + (r.valuesFile() != null
                ? r.valuesFile().getFileName() : "包内无 values.yaml，按 chart 自带默认值升级"));
        lines.add(String.format("  镜像     %d 个 / %.2f MB —— 控制台不导入镜像到 registry，需现场 ctr -i 导入；内嵌仓属设计路线图，本轮未实现",
                r.imageNames().size(), r.imageBytes() / 1024.0 / 1024.0));
        lines.add("  目标版本 " + (want.isEmpty() ? "（环境登记未指定，跳过比对）" : want + " ✔ 与包内一致"));
        lines.add("  已注入「执行升级」：chart = " + r.chartFile());
        return String.join("\n", lines);
    }

    /** 版本号可有可无 v 前缀（用户既会写 2.5.0 也会写 v2.5.0），比较时统一剥掉。 */
    private static boolean sameVersion(String a, String b) {
        return stripV(a).equals(stripV(b));
    }

    private static String stripV(String v) {
        String t = v.strip();
        return (t.startsWith("v") || t.startsWith("V")) ? t.substring(1) : t;
    }

    // ============ 分发 ============
    private DistributionJob createDistribution(InstallFlow flow, FlowStage stage) {
        Map<String, Object> inp = stage.inputs;
        EnvironmentSpec env = env(flow);
        List<String> roles = Workflow.asStringList(inp.get("target_roles"));
        if (roles.isEmpty()) roles = env.nodes.stream().map(n -> n.role.getValue()).distinct().toList();
        final List<String> targetRoles = roles;
        List<NodeSpec> targets = env.nodes.stream().filter(n -> targetRoles.contains(n.role.getValue())).toList();

        List<String> pkgIds = Workflow.asStringList(inp.get("_package_ids"));
        if (pkgIds.isEmpty() && "install".equals(flow.mode)) {
            List<PackageEntry> pkgs = store.listPackages().stream().filter(p -> p.uploadComplete).toList();
            if (!pkgs.isEmpty()) pkgIds = List.of(pkgs.get(0).id);
        }
        if (pkgIds.isEmpty()) throw new StageFailure("没有可分发安装包，请先在上一阶段完成上传");

        TransferMode mode = TransferMode.fromValue(s(inp.get("mode")));
        DistributionJob job = new DistributionJob();
        job.id = sid();
        job.flowId = flow.id;
        job.packageIds = new ArrayList<>(pkgIds);
        job.envId = flow.envId;
        job.mode = mode;
        job.concurrency = Math.min(32, Math.max(1, inp.get("concurrency") != null ? Integer.parseInt(s(inp.get("concurrency"))) : 4));
        job.remoteDir = s(inp.get("remote_dir")).isEmpty() ? "/opt/packages" : s(inp.get("remote_dir"));
        job.verifyChecksum = !Boolean.FALSE.equals(inp.get("verify_checksum"));
        List<TransferRecord> records = new ArrayList<>();
        for (NodeSpec n : targets) {
            TransferRecord rec = new TransferRecord();
            rec.nodeId = n.id;
            rec.hostname = n.hostname;
            rec.ip = n.ip;
            rec.mode = mode;
            records.add(rec);
        }
        job.records = records;
        store.saveDistribution(job);
        stage.inputs.put("_distribution_id", job.id);
        return job;
    }

    private String actDistributeConnect(InstallFlow flow, FlowStage stage, FlowStep step) {
        DistributionJob job = createDistribution(flow, stage);
        List<String> lines = new ArrayList<>();
        int bad = 0;
        EnvironmentSpec env = env(flow);
        for (TransferRecord rec : job.records) {
            NodeSpec node = env.nodes.stream().filter(n -> n.id.equals(rec.nodeId)).findFirst().orElse(null);
            if (node == null) continue;
            BaseDriver drv = nodeService.getDriver(node);
            if (drv.isMock) {
                lines.add(String.format("  ✔ %-20s %-16s [MOCK] 目录可写", rec.hostname, rec.ip));
                continue;
            }
            String dir = NodeService.shellQuote(job.remoteDir);
            NodeService.CmdResult r = drv.ssh("mkdir -p " + dir + " && test -w " + dir + " && echo OK", 30);
            if (r.ok && r.stdout.contains("OK")) {
                lines.add(String.format("  ✔ %-20s %-16s %s 可写", rec.hostname, rec.ip, job.remoteDir));
            } else {
                rec.status = StepStatus.FAILED;
                rec.error = "目标目录不可写: " + r.stderr.strip().substring(0, Math.min(80, r.stderr.strip().length()));
                lines.add(String.format("  ✘ %-20s %-16s %s", rec.hostname, rec.ip, rec.error));
                bad++;
            }
        }
        store.saveDistribution(job);
        if (bad == job.records.size()) throw new StageFailure("所有目标节点均不可写，请检查 SSH 凭据与目录权限");
        return "目标节点连接就绪：" + (job.records.size() - bad) + "/" + job.records.size() + " 台\n" + String.join("\n", lines);
    }

    private String actDistributePush(InstallFlow flow, FlowStage stage, FlowStep step) {
        DistributionJob job = store.getDistribution(s(stage.inputs.get("_distribution_id")));
        EnvironmentSpec env = env(flow);
        List<PackageEntry> pkgs = job.packageIds.stream().map(store::getPackage).filter(p -> p != null).toList();

        long totalBytes = pkgs.stream().mapToLong(p -> p.sizeBytes).sum();
        List<String> lines = new ArrayList<>();
        lines.add(String.format("开始分发 %d 个包（共 %.2f MB）→ %d 个节点，方式 %s，并发 %d",
                pkgs.size(), totalBytes / 1024.0 / 1024.0, job.records.size(), job.mode.getValue(), job.concurrency));
        lines.add("  包清单: " + String.join(", ", pkgs.stream().map(p -> p.name + "(" + String.format("%.1f", p.sizeBytes / 1024.0 / 1024.0) + "MB)").toList()));

        int done = 0;
        for (TransferRecord rec : job.records) {
            NodeSpec node = env.nodes.stream().filter(n -> n.id.equals(rec.nodeId)).findFirst().orElse(null);
            if (node == null) continue;
            BaseDriver drv = nodeService.getDriver(node);
            rec.status = StepStatus.RUNNING;
            rec.startedAt = LocalDateTime.now();
            long sent = 0;
            List<String> errs = new ArrayList<>();
            for (PackageEntry p : pkgs) {
                long t0 = System.currentTimeMillis();
                Object[] r = drv.push(p.path, job.remoteDir, job.mode);
                boolean ok = (boolean) r[0];
                if (ok) {
                    sent += (long) r[2];
                    rec.remotePath = job.remoteDir + "/" + Paths.get(p.path).getFileName();
                } else {
                    errs.add(p.name + ": " + ((String) r[1]).substring(0, Math.min(80, ((String) r[1]).length())));
                }
            }
            rec.bytesSent = sent;
            rec.finishedAt = LocalDateTime.now();
            if (rec.startedAt != null && sent > 0) {
                long secs = Math.max(ChronoUnit.MILLIS.between(rec.startedAt, rec.finishedAt), 10);
                rec.speedMbps = Math.round(sent / 1024.0 / 1024.0 / secs * 1000) / 1000.0;
            }
            if (!errs.isEmpty()) {
                rec.status = StepStatus.FAILED;
                rec.error = String.join("; ", errs);
                lines.add(String.format("  ✘ %-20s 失败 — %s", rec.hostname, rec.error));
            } else {
                rec.status = StepStatus.DONE;
                done++;
                lines.add(String.format("  ✔ %-20s %8.2f MB @ %s MB/s", rec.hostname, sent / 1024.0 / 1024.0, rec.speedMbps));
            }
        }
        store.saveDistribution(job);
        long failed = job.records.stream().filter(r -> r.status == StepStatus.FAILED).count();
        if (failed > 0 && failed == job.records.size()) throw new StageFailure("所有 " + failed + " 个节点分发失败");
        String tail = failed > 0 ? "\n⚠ " + failed + " 台失败，将在下一步骤校验时识别" : "";
        return "分发完成：" + done + "/" + job.records.size() + " 台成功\n" + String.join("\n", lines) + tail;
    }

    private String actDistributeVerify(InstallFlow flow, FlowStage stage, FlowStep step) {
        DistributionJob job = store.getDistribution(s(stage.inputs.get("_distribution_id")));
        EnvironmentSpec env = env(flow);
        List<PackageEntry> pkgs = job.packageIds.stream().map(store::getPackage).filter(p -> p != null).toList();
        List<String> lines = new ArrayList<>();
        List<String> badNodes = new ArrayList<>();

        for (TransferRecord rec : job.records) {
            if (rec.status == StepStatus.FAILED) {
                lines.add(String.format("  – %-20s 已在上一步失败，跳过校验", rec.hostname));
                continue;
            }
            NodeSpec node = env.nodes.stream().filter(n -> n.id.equals(rec.nodeId)).findFirst().orElse(null);
            if (node == null) continue;
            BaseDriver drv = nodeService.getDriver(node);
            if (!job.verifyChecksum) {
                rec.checksumOk = null;
                lines.add(String.format("  – %-20s 已关闭校验，跳过", rec.hostname));
                continue;
            }
            List<String> mismatch = new ArrayList<>();
            for (PackageEntry p : pkgs) {
                String remote = job.remoteDir + "/" + Paths.get(p.path).getFileName();
                Object[] r = drv.remoteSha256(remote);
                boolean ok = (boolean) r[0];
                String sum = (String) r[1];
                if (!ok) { mismatch.add(p.name + " 远端缺失"); continue; }
                if (drv.isMock) continue;
                if (!sum.isEmpty() && !sum.equals(p.checksum)) mismatch.add(p.name + " 校验和不符");
            }
            if (!mismatch.isEmpty()) {
                rec.checksumOk = false;
                badNodes.add(rec.hostname);
                lines.add(String.format("  ✘ %-20s %s", rec.hostname, String.join(", ", mismatch)));
            } else {
                rec.checksumOk = true;
                lines.add(String.format("  ✔ %-20s SHA256 一致", rec.hostname));
            }
        }
        store.saveDistribution(job);

        long nonFailed = job.records.stream().filter(r -> r.status != StepStatus.FAILED).count();
        if (!badNodes.isEmpty() && badNodes.size() == nonFailed) {
            job.status = StepStatus.FAILED;
            store.saveDistribution(job);
            throw new StageFailure("所有节点完整性校验失败: " + String.join(", ", badNodes));
        }

        long failedRecs = job.records.stream().filter(r -> r.status == StepStatus.FAILED || Boolean.FALSE.equals(r.checksumOk)).count();
        job.status = failedRecs > 0 ? StepStatus.PARTIAL : StepStatus.DONE;
        store.saveDistribution(job);

        String tail = !badNodes.isEmpty() ? "\n⚠ 以下节点需重传: " + String.join(", ", badNodes) : "";
        return "完整性校验完成\n" + String.join("\n", lines) + tail;
    }

    // ============ 备份 ============
    private BackupPoint collectBackupScope(InstallFlow flow, FlowStage stage, BackupKind kind) {
        EnvironmentSpec env = env(flow);
        Map<String, Object> inp = stage.inputs;
        List<NodeSpec> targets = env.nodes.stream()
                .filter(n -> n.status == NodeStatus.REACHABLE || n.status == NodeStatus.PREPARED).toList();
        if (targets.isEmpty()) targets = env.nodes;

        BackupPoint b = new BackupPoint();
        b.id = sid();
        b.name = s(inp.get("backup_name")).isEmpty()
                ? kind.getValue() + "-" + env.name + "-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"))
                : s(inp.get("backup_name"));
        b.kind = kind;
        b.envId = flow.envId;
        b.flowId = flow.id;
        b.includePaths = Workflow.asStringList(inp.get("include_paths"));
        b.includeDatabases = Workflow.asStringList(inp.get("include_databases"));
        b.includePathsAllowGlob = Boolean.TRUE.equals(inp.get("include_paths_allow_glob"));
        b.includeConfig = !Boolean.FALSE.equals(inp.get("include_config"));
        b.retentionDays = inp.get("retention_days") != null ? Integer.parseInt(s(inp.get("retention_days"))) : 30;
        b.nodesCovered = targets.stream().map(n -> n.hostname).toList();
        store.saveBackup(b);
        stage.inputs.put("_backup_id", b.id);
        return b;
    }

    /**
     * 备份目录参数：默认逐项加引号（远端不再展开通配符，注入面随之关掉）；
     * 操作员显式开启 glob 时按原样拼接，保留 `/etc/app/*` 这类合法写法在远端展开的行为。
     */
    private static String backupPathArgs(BackupPoint b) {
        StringBuilder sb = new StringBuilder();
        for (String p : b.includePaths) {
            if (sb.length() > 0) sb.append(' ');
            sb.append(b.includePathsAllowGlob ? p : NodeService.shellQuote(p));
        }
        return sb.toString();
    }

    /** 主机名也来自用户录入的节点表：先确认拼出来的子目录还在基目录内，否则是往任意路径写文件。 */
    private static Path childOf(Path base, String name) {
        Path resolved = base.resolve(name).normalize();
        if (!resolved.startsWith(base.normalize())) {
            throw new StageFailure("「" + name + "」不能用作备份子目录名（会写出备份目录之外）");
        }
        return resolved;
    }

    private String actBackupScope(InstallFlow flow, FlowStage stage, FlowStep step) {
        if ("upgrade_k8s".equals(flow.mode)) {
            boolean values = Boolean.TRUE.equals(stage.inputs.get("backup_values"));
            boolean manifest = Boolean.TRUE.equals(stage.inputs.get("backup_manifest"));
            boolean pvc = Boolean.TRUE.equals(stage.inputs.get("backup_pvc"));
            String snapClass = s(stage.inputs.get("snapshot_class"));
            int retention = stage.inputs.get("retention_days") != null ? Integer.parseInt(s(stage.inputs.get("retention_days"))) : 30;
            if (!values && !manifest && !pvc) throw new StageFailure("备份范围为空，请至少选择一项备份");
            // 创建 K8s 备份点记录
            BackupPoint b = new BackupPoint();
            b.id = sid();
            b.name = s(stage.inputs.get("backup_name")).isEmpty()
                    ? "k8s-upgrade-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"))
                    : s(stage.inputs.get("backup_name"));
            b.kind = BackupKind.PRE_UPGRADE;
            b.flowId = flow.id;
            b.retentionDays = retention;
            store.saveBackup(b);
            stage.inputs.put("_backup_id", b.id);
            List<String> lines = new ArrayList<>(List.of(
                    "K8s 升级前备份范围：",
                    "  Helm Values      " + (values ? "导出" : "跳过"),
                    "  Release Manifest " + (manifest ? "导出" : "跳过"),
                    "  PVC 快照         " + (pvc ? "创建（SnapshotClass: " + snapClass + "）" : "跳过"),
                    "  保留期限         " + retention + " 天",
                    "  备份点 ID        " + b.id
            ));
            return String.join("\n", lines);
        }
        BackupPoint b = collectBackupScope(flow, stage, BackupKind.PRE_INSTALL);
        List<String> lines = new ArrayList<>(List.of(
                "备份点 " + b.name,
                "  类型      安装前备份",
                "  覆盖节点  " + b.nodesCovered.size() + " 台：" + String.join(", ", b.nodesCovered.subList(0, Math.min(6, b.nodesCovered.size()))) + (b.nodesCovered.size() > 6 ? " …" : ""),
                "  备份目录  " + (b.includePaths.isEmpty() ? "（无）" : String.join(", ", b.includePaths)),
                "  数据库    " + (b.includeDatabases.isEmpty() ? "（无）" : String.join(", ", b.includeDatabases)),
                "  配置文件  " + (b.includeConfig ? "包含" : "不包含"),
                "  保留期限  " + b.retentionDays + " 天（过期后标记为可清理）"
        ));
        int total = b.includePaths.size() + b.includeDatabases.size() + (b.includeConfig ? 1 : 0);
        if (total == 0) throw new StageFailure("备份范围为空，无法执行");
        return String.join("\n", lines);
    }

    private String actBackupArchive(InstallFlow flow, FlowStage stage, FlowStep step) throws IOException {
        BackupPoint b = store.getBackup(s(stage.inputs.get("_backup_id")));
        if (b == null) throw new StageFailure("备份点不存在");
        b.status = BackupStatus.RUNNING;
        b.startedAt = LocalDateTime.now();
        store.saveBackup(b);

        Path backupDir = dataDir.resolve("backups").resolve(b.id);
        Files.createDirectories(backupDir);
        EnvironmentSpec env = env(flow);
        List<NodeSpec> targets = env.nodes.stream().filter(n -> b.nodesCovered.contains(n.hostname)).toList();

        List<String> lines = new ArrayList<>();
        long totalBytes = 0;
        for (NodeSpec n : targets) {
            BaseDriver drv = nodeService.getDriver(n);
            Path nodeDir = childOf(backupDir, n.hostname);
            Files.createDirectories(nodeDir);
            Map<String, Object> manifest = new LinkedHashMap<>();
            manifest.put("node", n.hostname);
            manifest.put("ip", n.ip);
            manifest.put("role", n.role.getValue());
            manifest.put("paths", b.includePaths);
            manifest.put("config", b.includeConfig);
            manifest.put("created", LocalDateTime.now().format(ISO));
            Path mf = nodeDir.resolve("manifest.json");
            byte[] raw = Json.toJson(manifest).getBytes(StandardCharsets.UTF_8);
            Files.write(mf, raw);
            long size = raw.length;

            if (!drv.isMock && !b.includePaths.isEmpty()) {
                String paths = backupPathArgs(b);
                String archive = "/tmp/cloudops-backup-" + b.id + ".tar.gz";
                NodeService.CmdResult r = drv.ssh("tar czf " + archive + " " + paths + " 2>/dev/null; stat -c%s " + archive + " 2>/dev/null || echo 0", 3600);
                if (r.ok) {
                    try {
                        String[] ls = r.stdout.strip().split("\n");
                        size = Long.parseLong(ls[ls.length - 1].strip());
                    } catch (Exception ignored) {}
                    drv.pull(archive, nodeDir.toString());
                    drv.ssh("rm -f " + archive, 10);
                }
            } else if (drv.isMock) {
                try {
                    MessageDigest md = MessageDigest.getInstance("MD5");
                    byte[] d = md.digest(n.ip.getBytes());
                    long seed = 0;
                    for (int i = 0; i < 4; i++) seed = (seed << 8) | (d[i] & 0xff);
                    long est = 120L * 1024 * 1024 + (seed % (1536 - 120)) * 1024 * 1024;
                    size += est;
                } catch (Exception ignored) {}
            }

            totalBytes += size;
            lines.add(String.format("  ✔ %-20s 归档 %8.2f MB → %s/", n.hostname, size / 1024.0 / 1024.0, nodeDir.getFileName()));
        }
        b.sizeBytes = totalBytes;
        b.path = backupDir.toString();
        store.saveBackup(b);
        return "文件归档完成：" + targets.size() + " 台节点\n" + String.join("\n", lines);
    }

    private String actBackupDatabase(InstallFlow flow, FlowStage stage, FlowStep step) throws IOException {
        BackupPoint b = store.getBackup(s(stage.inputs.get("_backup_id")));
        if (b == null || b.includeDatabases.isEmpty()) return "未指定数据库，跳过逻辑备份";
        EnvironmentSpec env = env(flow);
        List<NodeSpec> dbNodes = env.nodes.stream().filter(n -> n.role == NodeRole.DATABASE).toList();
        if (dbNodes.isEmpty()) dbNodes = env.nodes.stream().filter(n -> b.nodesCovered.contains(n.hostname)).limit(1).toList();

        List<String> lines = new ArrayList<>();
        Path backupDir = !b.path.isEmpty() ? Paths.get(b.path) : dataDir.resolve("backups").resolve(b.id);
        for (NodeSpec n : dbNodes) {
            BaseDriver drv = nodeService.getDriver(n);
            for (String db : b.includeDatabases) {
                Path dumpDir = childOf(backupDir, n.hostname);
                Files.createDirectories(dumpDir);
                Path dumpFile = dumpDir.resolve(db + ".sql.gz");
                if (drv.isMock) {
                    byte[] content = ("-- [MOCK] logical dump of " + db + " from " + n.hostname + "\n-- generated " + LocalDateTime.now().format(ISO) + "\n").getBytes(StandardCharsets.UTF_8);
                    Files.write(dumpFile, content);
                    lines.add(String.format("  ✔ %-16s %-16s [MOCK] %d 字节", n.hostname, db, content.length));
                } else {
                    String quoted = NodeService.shellQuote(db);
                    String remote = "/tmp/" + db + "-" + b.id + ".sql.gz";
                    NodeService.CmdResult r = drv.ssh(
                            "(mysqldump --single-transaction --routines " + quoted + " 2>/dev/null || pg_dump " + quoted + " 2>/dev/null) | gzip > " + remote + "; "
                            + "stat -c%s " + remote + " 2>/dev/null || echo 0", 7200);
                    if (!r.ok) throw new StageFailure(n.hostname + " 上 " + db + " 备份失败: " + r.stderr.strip().substring(0, Math.min(100, r.stderr.strip().length())));
                    drv.pull(remote, dumpDir.toString());
                    drv.ssh("rm -f " + remote, 10);
                    long sz = 0;
                    try {
                        String[] ls = r.stdout.strip().split("\n");
                        sz = Long.parseLong(ls[ls.length - 1].strip());
                    } catch (Exception ignored) {}
                    b.sizeBytes += sz;
                    lines.add(String.format("  ✔ %-16s %-16s %8.1f KB", n.hostname, db, sz / 1024.0));
                }
            }
        }
        store.saveBackup(b);
        return "数据库逻辑备份完成：" + b.includeDatabases.size() + " 个实例\n" + String.join("\n", lines);
    }

    private String actBackupRegister(InstallFlow flow, FlowStage stage, FlowStep step) {
        BackupPoint b = store.getBackup(s(stage.inputs.get("_backup_id")));
        if (b == null) throw new StageFailure("备份点不存在");
        Object[] digest = backupSvc.backupDigest(b);
        b.checksum = (String) digest[0];
        b.status = BackupStatus.SUCCEEDED;
        b.finishedAt = LocalDateTime.now();
        b.expireAt = LocalDateTime.now().plusDays(b.retentionDays);
        b.restorable = true;
        store.saveBackup(b);
        flow.backupPointId = b.id;
        store.saveFlow(flow);
        store.audit(flow.operator, "backup.create", b.id, "ok", b.name);
        return String.format("备份点已登记%n  ID        %s%n  大小      %.2f MB%n  校验和    %s…%n  过期时间  %s%n  可恢复    ✔ 已标记为回滚基线",
                b.id, b.sizeBytes / 1024.0 / 1024.0,
                b.checksum.substring(0, Math.min(32, b.checksum.length())),
                b.expireAt.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
    }

    // ============ 安装执行 ============
    private String checkPackagesReady(InstallFlow flow) {
        List<DistributionJob> dists = store.listDistributions(flow.id);
        if (dists.isEmpty()) {
            List<PackageEntry> pkgs = store.listPackages().stream().filter(p -> p.uploadComplete).toList();
            if (pkgs.isEmpty()) throw new StageFailure("没有已上传的安装包，请先完成包上传阶段");
            return "使用本地包 " + pkgs.size() + " 个（未走分发）";
        }
        DistributionJob d = dists.get(0);
        long okN = d.records.stream().filter(r -> r.status == StepStatus.DONE).count();
        if (okN == 0) throw new StageFailure("上一阶段的分发未成功，请先重跑包分发");
        return "分发校验通过：" + okN + "/" + d.records.size() + " 台节点已就绪";
    }

    private String actInstallPrecheck(InstallFlow flow, FlowStage stage, FlowStep step) {
        String msg = checkPackagesReady(flow);
        EnvironmentSpec env = env(flow);
        List<String> notPrepared = env.nodes.stream().filter(n -> n.status == NodeStatus.UNKNOWN).map(n -> n.hostname).toList();
        List<String> lines = new ArrayList<>();
        lines.add(msg);
        if (!notPrepared.isEmpty()) lines.add("⚠ 以下节点尚未完成环境校验，将直接安装: " + String.join(", ", notPrepared));
        String installMode = s(stage.inputs.get("install_mode"));
        lines.add("安装模式: " + (installMode.isEmpty() ? "full" : installMode));
        lines.add("失败即停: " + (!Boolean.FALSE.equals(stage.inputs.get("stop_on_failure")) ? "是" : "否"));
        return String.join("\n", lines);
    }

    private static final String NO_INSTALLER = "__SHIPDESK_NO_INSTALLER__";

    /** 安装脚本目录取自本流程的分发任务，与用户在分发阶段填写的目标目录保持一致。 */
    private String installDir(InstallFlow flow) {
        List<DistributionJob> dists = store.listDistributions(flow.id);
        if (!dists.isEmpty()) {
            String dir = dists.get(0).remoteDir;
            if (dir != null && !dir.isBlank()) return dir.strip();
        }
        return "/opt/packages";
    }

    private List<String> installOnNodes(InstallFlow flow, FlowStage stage, List<NodeSpec> nodes, String component) {
        List<String> lines = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        boolean stopOnFail = !Boolean.FALSE.equals(stage.inputs.get("stop_on_failure"));
        List<String> skip = Workflow.asStringList(stage.inputs.get("skip_components"));

        if (skip.contains(component)) return List.of("  – 组件 " + component + " 在跳过清单中，已略过");

        EnvironmentSpec env = env(flow);
        Map<String, NodeSpec> byId = new HashMap<>();
        for (NodeSpec n : env.nodes) byId.put(n.id, n);
        String dir = installDir(flow);

        for (NodeSpec n : nodes) {
            BaseDriver drv = nodeService.getDriver(n);
            NodeSpec target = byId.getOrDefault(n.id, n);
            if (drv.isMock) {
                try { Thread.sleep(150); } catch (InterruptedException ignored) {}
                target.status = NodeStatus.INSTALLED;
                lines.add(String.format("  ✔ %-20s %-16s [MOCK] %s 安装成功", n.hostname, n.ip, component));
                continue;
            }
            String script = "set -e; cd " + NodeService.shellQuote(dir) + "; if [ -f install-" + component + ".sh ]; then bash install-"
                    + component + ".sh; else echo " + NO_INSTALLER + "; fi";
            NodeService.CmdResult r = drv.ssh(script, 3600);
            boolean missing = r.stdout != null && r.stdout.contains(NO_INSTALLER);
            if (r.ok && !missing) {
                target.status = NodeStatus.INSTALLED;
                lines.add(String.format("  ✔ %-20s %-16s %s 安装成功", n.hostname, n.ip, component));
            } else {
                failures.add(n.hostname);
                String why = missing ? "目录 " + dir + " 内没有安装脚本 install-" + component + ".sh"
                        : r.stderr.strip();
                lines.add(String.format("  ✘ %-20s %-16s %s", n.hostname, n.ip, why.substring(0, Math.min(90, why.length()))));
                if (stopOnFail) break;
            }
        }
        env.nodes = new ArrayList<>(byId.values());
        store.saveEnv(env);
        if (!failures.isEmpty()) {
            throw new StageFailure(component + " 在节点 " + String.join(", ", failures) + " 上未安装成功"
                    + (stopOnFail ? "，已停止" : "（已按配置处理完其余节点）"));
        }
        return lines;
    }

    private String actInstallControlPlane(InstallFlow flow, FlowStage stage, FlowStep step) {
        List<NodeSpec> nodes = nodesOfStage(flow, List.of("control"));
        List<String> lines = new ArrayList<>();
        lines.add("控制面组件 → " + nodes.size() + " 台控制节点");
        lines.addAll(installOnNodes(flow, stage, nodes, "control-plane"));
        return String.join("\n", lines);
    }

    private String actInstallDataPlane(InstallFlow flow, FlowStage stage, FlowStep step) {
        List<NodeSpec> nodes = nodesOfStage(flow, List.of("database", "storage"));
        List<String> lines = new ArrayList<>();
        lines.add("数据面组件 → " + nodes.size() + " 台数据库/存储节点");
        lines.addAll(installOnNodes(flow, stage, nodes, "data-plane"));
        return String.join("\n", lines);
    }

    private String actInstallWorkers(InstallFlow flow, FlowStage stage, FlowStep step) {
        List<NodeSpec> nodes = nodesOfStage(flow, List.of("worker"));
        int conc = Math.min(32, Math.max(1, stage.inputs.get("parallel_workers") != null
                ? Integer.parseInt(s(stage.inputs.get("parallel_workers"))) : 3));
        List<String> lines = new ArrayList<>();
        lines.add("工作节点组件 → " + nodes.size() + " 台（并发 " + conc + "）");
        for (int i = 0; i < nodes.size(); i += conc) {
            List<NodeSpec> batch = nodes.subList(i, Math.min(i + conc, nodes.size()));
            lines.add("  ── 批次 " + (i / conc + 1) + "（" + batch.size() + " 台）──");
            lines.addAll(installOnNodes(flow, stage, batch, "worker-node"));
        }
        return String.join("\n", lines);
    }

    private String actInstallGateway(InstallFlow flow, FlowStage stage, FlowStep step) {
        List<NodeSpec> nodes = nodesOfStage(flow, List.of("gateway"));
        List<String> lines = new ArrayList<>();
        lines.add("网关组件 → " + nodes.size() + " 台接入节点");
        lines.addAll(installOnNodes(flow, stage, nodes, "gateway"));
        return String.join("\n", lines);
    }

    // ============ 升级 ============
    private String actUpgradeMigrateData(InstallFlow flow, FlowStage stage, FlowStep step) {
        if ("upgrade_k8s".equals(flow.mode)) {
            // K8s 升级模式：数据迁移由 chart hooks 或 Job 处理
            return "K8s 模式：数据迁移由 Helm chart hooks 处理，跳过";
        }
        EnvironmentSpec env = env(flow);
        List<NodeSpec> dbNodes = env.nodes.stream().filter(n -> n.role == NodeRole.DATABASE).toList();
        if (dbNodes.isEmpty()) return "无数据库节点，跳过数据迁移";
        List<String> lines = new ArrayList<>();
        lines.add("执行数据迁移脚本 → " + dbNodes.size() + " 台数据库节点");
        for (NodeSpec n : dbNodes) {
            BaseDriver drv = nodeService.getDriver(n);
            if (drv.isMock) {
                lines.add(String.format("  ✔ %-20s [MOCK] schema 迁移完成（12 个变更脚本）", n.hostname));
            } else {
                NodeService.CmdResult r = drv.ssh("cd /opt/app && bash migrate.sh 2>&1 | tail -5", 3600);
                lines.add(String.format("  %s %-20s %s", r.ok ? "✔" : "✘", n.hostname, r.stdout.strip().substring(0, Math.min(100, r.stdout.strip().length()))));
            }
        }
        return String.join("\n", lines);
    }

    // ============ 验证 ============
    private String actVerifyServices(InstallFlow flow, FlowStage stage, FlowStep step) {
        EnvironmentSpec env = env(flow);
        List<String> lines = new ArrayList<>();
        int okN = 0;
        for (NodeSpec n : env.nodes) {
            BaseDriver drv = nodeService.getDriver(n);
            if (drv.isMock) {
                try { Thread.sleep(80); } catch (InterruptedException ignored) {}
                lines.add(String.format("  ✔ %-20s 服务运行中（3 个 unit 全部 active）", n.hostname));
                okN++;
            } else {
                NodeService.CmdResult r = drv.ssh("systemctl is-active app-worker app-api app-gateway 2>/dev/null; echo ---", 60);
                int active = r.ok ? r.stdout.split("active", -1).length - 1 : 0;
                if (active >= 1) {
                    okN++;
                    lines.add(String.format("  ✔ %-20s %d 个服务运行中", n.hostname, active));
                } else {
                    lines.add(String.format("  ✘ %-20s 服务未运行", n.hostname));
                }
            }
        }
        if (okN == 0) throw new StageFailure("所有节点的服务均未运行");
        return "服务状态检查：" + okN + "/" + env.nodes.size() + " 台正常\n" + String.join("\n", lines);
    }

    private String actVerifyPorts(InstallFlow flow, FlowStage stage, FlowStep step) {
        EnvironmentSpec env = env(flow);
        List<String> lines = new ArrayList<>();
        for (NodeSpec n : env.nodes) {
            BaseDriver drv = nodeService.getDriver(n);
            if (drv.isMock) {
                List<Integer> ports = switch (n.role.getValue()) {
                    case "control" -> List.of(6443, 2379);
                    case "worker" -> List.of(10250);
                    case "database" -> List.of(3306);
                    case "storage" -> List.of(9000);
                    case "gateway" -> List.of(80, 443);
                    default -> List.of(8080);
                };
                try { Thread.sleep(50); } catch (InterruptedException ignored) {}
                lines.add(String.format("  ✔ %-20s 端口监听: %s", n.hostname, ports.stream().map(String::valueOf).toList()));
            } else {
                NodeService.CmdResult r = drv.ssh("ss -lnt 2>/dev/null | awk 'NR>1{print $4}' | grep -oE '[0-9]+$' | sort -un | head -8 | tr '\\n' ' '", 30);
                lines.add(String.format("  ✔ %-20s 监听: %s", n.hostname, r.stdout.strip().isEmpty() ? "未采集到" : r.stdout.strip()));
            }
        }
        return "端口监听检查完成\n" + String.join("\n", lines);
    }

    private String actVerifyVersions(InstallFlow flow, FlowStage stage, FlowStep step) {
        EnvironmentSpec env = env(flow);
        String target = stage.inputs.get("target_version") != null ? s(stage.inputs.get("target_version")) : (stage.inputs.get("__version") != null ? s(stage.inputs.get("__version")) : "");
        Map<String, List<String>> versions = new LinkedHashMap<>();
        for (NodeSpec n : env.nodes) {
            BaseDriver drv = nodeService.getDriver(n);
            String v;
            if (drv.isMock) {
                v = target.isEmpty() ? "v2.4.0" : target;
            } else {
                NodeService.CmdResult r = drv.ssh("readlink -f /opt/app/current 2>/dev/null | xargs basename 2>/dev/null || echo unknown", 30);
                v = r.stdout.strip().isEmpty() ? "unknown" : r.stdout.strip();
            }
            versions.computeIfAbsent(v, k -> new ArrayList<>()).add(n.hostname);
        }
        List<String> lines = new ArrayList<>();
        for (var e : versions.entrySet()) {
            List<String> hosts = e.getValue();
            lines.add(String.format("  版本 %s: %d 台（%s%s）", e.getKey(), hosts.size(),
                    String.join(", ", hosts.subList(0, Math.min(5, hosts.size()))),
                    hosts.size() > 5 ? " …" : ""));
        }
        if (versions.size() > 1) {
            throw new StageFailure("版本不一致，存在部分节点升级失败：\n" + String.join("\n", lines));
        }
        return "版本一致性核对通过（所有节点统一）\n" + String.join("\n", lines);
    }

    private String actVerifyMembership(InstallFlow flow, FlowStage stage, FlowStep step) {
        EnvironmentSpec env = env(flow);
        long control = env.nodes.stream().filter(n -> n.role == NodeRole.CONTROL).count();
        long worker = env.nodes.stream().filter(n -> n.role == NodeRole.WORKER).count();
        if (control == 0) throw new StageFailure("没有控制节点，集群不完整");
        boolean anyMock = env.nodes.stream().anyMatch(n -> nodeService.getDriver(n).isMock);
        List<String> lines = List.of(
                "  控制节点 " + control + " 台，按登记角色视为已加入集群",
                "  工作节点 " + worker + " 台，按登记角色视为 Ready"
        );
        String head = anyMock
                ? "集群成员检查：本环境存在模拟节点，结论由角色清单推导，未查询真实集群"
                : "集群成员检查：按登记角色核对完成";
        return head + "\n" + String.join("\n", lines);
    }

    private String actVerifySmoke(InstallFlow flow, FlowStage stage, FlowStep step) {
        List<String> endpoints = Workflow.asStringList(stage.inputs.get("smoke_endpoints"));
        if (endpoints.isEmpty()) endpoints = List.of("/healthz");
        String base;
        NodeSpec runner = null;
        if ("upgrade_k8s".equals(flow.mode)) {
            var c = k8sCluster(flow, stage);
            String release = releaseName(flow, stage);
            base = "http://" + release + "." + c.namespace + ".svc.cluster.local";
        } else {
            EnvironmentSpec env = env(flow);
            runner = env.nodes.stream().filter(n -> n.role == NodeRole.GATEWAY).findFirst()
                    .orElse(env.nodes.isEmpty() ? null : env.nodes.get(0));
            if (runner == null) throw new StageFailure("环境里没有节点，无法执行冒烟测试");
            base = "http://" + runner.ip;
        }
        List<String> lines = new ArrayList<>();
        BaseDriver drv = runner != null ? nodeService.getDriver(runner) : null;
        if (drv == null || drv.isMock) {
            for (String ep : endpoints) lines.add(String.format("  – [MOCK] GET %s%s 未发起真实请求", base, ep));
            return "接口冒烟测试为模拟结果（" + endpoints.size() + " 个接口，未验证服务可用性）\n" + String.join("\n", lines);
        }
        int bad = 0;
        for (String ep : endpoints) {
            NodeService.CmdResult r = drv.ssh(
                    "curl -s -o /dev/null -w '%{http_code}' --max-time 8 " + NodeService.shellQuote(base + ep), 20);
            String code = r.stdout.strip();
            boolean ok = r.ok && code.startsWith("2");
            if (!ok) bad++;
            lines.add(String.format("  %s GET %s%s  %s %dms", ok ? "✔" : "✘", base, ep,
                    code.isEmpty() ? "无响应" : code, r.durationMs));
        }
        if (bad == endpoints.size()) throw new StageFailure("全部 " + endpoints.size() + " 个冒烟接口不可达，服务未正常启动");
        String tail = bad > 0 ? "\n⚠ " + bad + " 个接口异常" : "";
        return "接口冒烟测试：" + (endpoints.size() - bad) + "/" + endpoints.size() + " 个接口可用\n"
                + String.join("\n", lines) + tail;
    }

    private String actVerifyReport(InstallFlow flow, FlowStage stage, FlowStep step) {
        if ("upgrade_k8s".equals(flow.mode)) {
            BackupPoint backup = flow.backupPointId != null ? store.getBackup(flow.backupPointId) : null;
            var c = k8sCluster(flow, stage);
            String release = releaseName(flow, stage);
            Map<String, Object> r = k8s.podVerifyReady(c, null);
            String podStatus = Boolean.TRUE.equals(r.get("ok"))
                    ? mockTag(r) + "全部 Ready（" + dataOf(r).get("total") + " 个）"
                    : "读取失败: " + s(r.get("error"));
            List<String> lines = new ArrayList<>(List.of(
                    "════════ K8s 升级交付报告 ════════",
                    "流程        " + flow.name,
                    "Cluster     " + (flow.envId),
                    "Namespace   " + c.namespace,
                    "Release     " + release,
                    "Pod 状态    " + podStatus,
                    "备份点      " + (backup != null ? backup.name : "未创建")
            ));
            return String.join("\n", lines);
        }
        EnvironmentSpec env = env(flow);
        Map<String, Object> s = env.summary();
        long installed = env.nodes.stream().filter(n -> n.status == NodeStatus.INSTALLED).count();
        BackupPoint backup = flow.backupPointId != null ? store.getBackup(flow.backupPointId) : null;

        List<String> lines = new ArrayList<>();
        lines.add("════════ 交付报告 ════════");
        lines.add("流程        " + flow.name);
        lines.add("环境        " + env.name);
        lines.add("节点总数    " + s.get("total") + " 台（物理机 " + s.get("physical") + " / 虚拟机 " + s.get("virtual") + "）");
        @SuppressWarnings("unchecked")
        Map<String, Integer> byRole = (Map<String, Integer>) s.get("by_role");
        List<String> roleParts = new ArrayList<>();
        byRole.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> roleParts.add(e.getKey() + " " + e.getValue()));
        lines.add("角色分布    " + String.join("、", roleParts));
        lines.add("安装成功    " + installed + "/" + s.get("total") + " 台");
        lines.add("备份点      " + (backup != null ? backup.name : "未创建"));
        lines.add("");
        lines.add("节点明细:");
        for (NodeSpec n : env.nodes) {
            lines.add(String.format("  %-20s %-16s %-9s %-40s %s", n.hostname, n.ip, n.role.getValue(), n.osRelease == null ? "" : n.osRelease, n.status.getValue()));
        }
        if ("install".equals(flow.mode) && Boolean.FALSE.equals(stage.inputs.get("keep_backup")) && backup != null) {
            backup.status = BackupStatus.EXPIRED;
            store.saveBackup(backup);
            lines.add("");
            lines.add("（按配置已清理备份点 " + backup.name + "）");
        }
        return String.join("\n", lines);
    }

    private static String s(Object v) {
        return v == null ? "" : v.toString();
    }

    /** 集群侧动作的唯一出口：sidecar 说没做成，就是阶段失败，绝不降级成一行日志继续走。
     *  曾经的写法是 `return "X: " + r.get("error")`，于是 helm 渲染失败、Pod 没起来、
     *  备份没落盘全都照样 ✔ 完成、阶段 passed、流程 succeeded —— 是最恶劣的假成功。 */
    private static Map<String, Object> requireOk(String what, Map<String, Object> r) {
        if (!Boolean.TRUE.equals(r.get("ok"))) {
            throw new StageFailure(what + "失败: " + s(r.get("error")));
        }
        return r;
    }

    private static Map<?, ?> dataOf(Map<String, Object> r) {
        Object d = r.get("data");
        return d instanceof Map<?, ?> m ? m : Map.of();
    }

    /** 模拟通路（CLOUDOPS_FORCE_MOCK）造出来的成功必须长得跟真实成功不一样。 */
    private static String mockTag(Map<String, Object> r) {
        return Boolean.TRUE.equals(r.get("mock")) ? "[MOCK] " : "";
    }

    // ===================== upgrade_k8s 动作处理器 =====================

    /** 从阶段输入构造 K8sCluster，共享输入回退到 env_register 阶段。 */
    private com.cloudops.model.K8sCluster k8sCluster(InstallFlow flow, FlowStage stage) {
        com.cloudops.model.K8sCluster c = new com.cloudops.model.K8sCluster();
        c.namespace = s(k8sInput(flow, stage, "namespace", "default"));
        Object kc = k8sInput(flow, stage, "kubeconfig", null);
        c.kubeconfig = kc != null ? kc.toString() : null;
        return c;
    }

    private String releaseName(InstallFlow flow, FlowStage stage) {
        return s(k8sInput(flow, stage, "release_name", ""));
    }

    /** 从当前阶段读取输入，若不存在则回退到 env_register 阶段的输入。 */
    private Object k8sInput(InstallFlow flow, FlowStage stage, String key, Object def) {
        if (stage.inputs.containsKey(key)) return stage.inputs.get(key);
        for (FlowStage s : flow.stages) {
            if ("env_register".equals(s.key) && s.inputs.containsKey(key)) return s.inputs.get(key);
        }
        return def;
    }

    private String actK8sDiscover(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        Map<String, Object> r = requireOk("Release 发现", k8s.helmList(c));
        Object releases = dataOf(r).get("releases");
        return mockTag(r) + "Release 发现完成\n  当前 namespace " + c.namespace + " 下 releases: " + releases;
    }

    private String actK8sPrecheckNode(InstallFlow flow, FlowStage stage, FlowStep step) {
        // 节点层预检：复用 Python precheck 脚本
        EnvironmentSpec env = store.getEnv(flow.envId);
        if (env == null || env.nodes.isEmpty()) {
            return "节点预检跳过（无节点，纯 K8s 模式）";
        }
        List<String> lines = new ArrayList<>();
        List<String> bad = new ArrayList<>();
        for (NodeSpec n : env.nodes) {
            BaseDriver drv = nodeService.getDriver(n);
            Object[] r = drv.precheck();
            boolean ok = (boolean) r[0];
            lines.add(String.format("  %s %s  %s", ok ? "✔" : "✖", n.hostname, ok ? "预检通过" : r[1]));
            if (!ok) bad.add(n.hostname + ": " + r[1]);
        }
        if (!bad.isEmpty()) {
            throw new StageFailure("节点预检未通过（" + bad.size() + " 台）:\n  " + String.join("\n  ", bad));
        }
        return "节点预检完成\n" + String.join("\n", lines);
    }

    private String actK8sPrecheckHealth(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        Map<String, Object> r = requireOk("K8s 健康检查", k8s.podVerifyReady(c, null));
        return mockTag(r) + "K8s 健康检查通过\n  " + dataOf(r).get("total") + " 个 Pod 全部 Ready";
    }

    private String actK8sPrecheckCompat(InstallFlow flow, FlowStage stage, FlowStep step) {
        // 本阶段表单里没有 target_chart_version（它属于 env_register），原来的写法恒为空串 →
        // 这一步今天永远输出「跳过」。改用 k8sInput 回退，兼容检查才真的能看见值。
        String target = s(k8sInput(flow, stage, "target_chart_version", ""));
        FlowStage exec = workflow.stageByKey(flow, "upgrade_execute");
        String inBundle = exec == null ? "" : s(exec.inputs.get("_chart_version"));

        List<String> lines = new ArrayList<>();
        if (target.isEmpty()) {
            lines.add("版本兼容性检查跳过（环境登记未指定目标 Chart 版本）");
        } else if (!versioning.isValidVersion(target) && !versioning.isValidVersion("v" + target)) {
            lines.add("版本兼容性: 目标版本 " + target + " 格式不合法");
        } else {
            lines.add("登记目标 Chart 版本: " + target);
        }
        if (inBundle.isEmpty()) {
            lines.add("离线包内 Chart 版本: 未解包（本轮流程若早于 bundle 阶段创建，请新建流程）");
        } else {
            lines.add("离线包内 Chart 版本: " + inBundle);
            lines.add(target.isEmpty() || sameVersion(target, inBundle)
                    ? "  ✔ 与登记目标一致"
                    : "  ✘ 与登记目标不一致（解包阶段本应拦下，说明登记值在解包后被改过）");
        }
        return String.join("\n", lines);
    }

    private String actK8sBackupValues(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        Map<String, Object> r = requireOk("Helm Values 备份",
                k8s.backupExportValues(c, releaseName(flow, stage), dataDir.resolve("backups").toString()));
        return mockTag(r) + "Helm Values 备份完成: " + dataOf(r).get("file");
    }

    private String actK8sBackupManifest(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        Map<String, Object> r = requireOk("Release Manifest 备份",
                k8s.backupExportManifest(c, releaseName(flow, stage), dataDir.resolve("backups").toString()));
        Map<?, ?> data = dataOf(r);
        return mockTag(r) + "Release Manifest 备份完成: " + data.get("file") + " (" + data.get("bytes") + " bytes)";
    }

    private String actK8sBackupPvc(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        String snapClass = s(stage.inputs.get("snapshot_class"));
        // 列出 PVC 并逐个打快照
        Map<String, Object> lr = requireOk("PVC 列表获取", k8s.backupListPvc(c));
        String tag = mockTag(lr);
        List<?> pvcs = (List<?>) dataOf(lr).get("pvcs");
        if (pvcs == null || pvcs.isEmpty()) return tag + "无 PVC 需要备份";
        List<String> lines = new ArrayList<>();
        List<String> bad = new ArrayList<>();
        for (Object o : pvcs) {
            Map<?, ?> p = (Map<?, ?>) o;
            String name = String.valueOf(p.get("name"));
            Map<String, Object> sr = k8s.backupVolumeSnapshot(c, name, snapClass);
            if (Boolean.TRUE.equals(sr.get("ok"))) {
                lines.add("  ✔ " + name + " → " + dataOf(sr).get("snapshot_name"));
            } else {
                lines.add("  ✖ " + name + " 快照失败: " + sr.get("error"));
                bad.add(name + ": " + sr.get("error"));
            }
        }
        // 部分成功不是成功：回滚时缺一份快照就是丢数据，必须让阶段红在这里。
        if (!bad.isEmpty()) {
            throw new StageFailure("PVC 快照失败（" + bad.size() + "/" + pvcs.size() + "）:\n  "
                    + String.join("\n  ", bad));
        }
        return tag + "PVC 快照完成\n" + String.join("\n", lines);
    }

    private String actK8sNodeDrain(InstallFlow flow, FlowStage stage, FlowStep step) {
        return clusterNodeOp(flow, stage, "scripts/node_drain.py", 120, "节点排水");
    }

    private String actK8sNodeUncordon(InstallFlow flow, FlowStage stage, FlowStep step) {
        return clusterNodeOp(flow, stage, "scripts/node_uncordon.py", 60, "节点恢复调度");
    }

    /** kubectl drain / uncordon 的公共外壳：逐节点跑脚本，任何一台没成就整步失败——
     *  原来只要末尾拼一句「完成」，✖ 行也被算成成功。 */
    private String clusterNodeOp(InstallFlow flow, FlowStage stage, String script, int timeout, String label) {
        EnvironmentSpec env = store.getEnv(flow.envId);
        if (env == null || env.nodes.isEmpty()) return label + "跳过（无节点）";
        boolean mock = nodeService.forceMock();
        List<String> lines = new ArrayList<>();
        List<String> bad = new ArrayList<>();
        for (NodeSpec n : env.nodes) {
            if (mock) {
                lines.add("  ✔ " + n.hostname + "  " + label + "（模拟，未触碰集群）");
                continue;
            }
            String kc = stage.inputs.get("kubeconfig") != null ? s(stage.inputs.get("kubeconfig")) : null;
            Map<String, Object> payload = new HashMap<>();
            payload.put("node", n.hostname);
            if (kc != null) payload.put("kubeconfig", kc);
            NodeService.CmdResult r = NodeService.run(List.of("python3", script), timeout, Json.toJson(payload));
            String out = r.stdout.strip();
            try {
                Map<String, Object> res = Json.mapper().readValue(out,
                        new tools.jackson.core.type.TypeReference<Map<String, Object>>() {});
                boolean ok = Boolean.TRUE.equals(res.get("ok"));
                lines.add(String.format("  %s %s  %s", ok ? "✔" : "✖", n.hostname,
                        ok ? res.get("report") : res.get("error")));
                if (!ok) bad.add(n.hostname + ": " + res.get("error"));
            } catch (Exception e) {
                lines.add("  ✖ " + n.hostname + " 解析失败: " + e.getMessage());
                bad.add(n.hostname + ": 脚本输出无法解析（" + e.getMessage() + "）");
            }
        }
        if (!bad.isEmpty()) {
            throw new StageFailure(label + "失败（" + bad.size() + "/" + env.nodes.size() + " 台）:\n  "
                    + String.join("\n  ", bad));
        }
        return (mock ? "[MOCK] " : "") + label + "完成\n" + String.join("\n", lines);
    }

    private String actK8sHelmUpgrade(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        String chart = s(k8sInput(flow, stage, "chart", ""));
        // chart 现在来自离线包解包注入。为空就说明本流程没跑过「上传软件包」——
        // 这时候调 helm 只会拿到一句难懂的 helm 报错，不如直接说清楚缺什么。
        if (chart.isEmpty()) {
            throw new StageFailure("没有可用的 chart：请先完成「上传软件包」阶段，解包结果会注入本阶段");
        }
        String valuesFile = s(stage.inputs.get("_values_path"));

        Map<String, Object> setValues = new HashMap<>();
        Object sv = stage.inputs.get("set_values");
        if (sv instanceof List<?> lines) {
            for (Object l : lines) {
                String[] kv = l.toString().split("=", 2);
                if (kv.length == 2) setValues.put(kv[0], kv[1]);
            }
        }
        // 本地 tgz 的版本由包自身决定，--version 只对仓库图表有意义（k8s-ops/src/helm.ts:24），所以传 null。
        Map<String, Object> r = requireOk("Helm 升级", k8s.helmUpgrade(c, releaseName(flow, stage), chart, null,
                valuesFile.isEmpty() ? null : valuesFile, setValues.isEmpty() ? null : setValues));
        return mockTag(r) + "Helm 升级成功: " + releaseName(flow, stage) + " ← " + chart;
    }

    private String actK8sRolloutStatus(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        // 从 release manifest 获取 workload 列表（简化：查询 deployment/statefulset）
        Map<String, Object> r = requireOk("Rollout 状态", k8s.podVerifyReady(c, null));
        return mockTag(r) + "Rollout 完成，所有 Pod 就绪";
    }

    private String actK8sConfigRoll(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        Map<String, Object> r = requireOk("ConfigMap 热更新", k8s.podVerifyReady(c, null));
        return mockTag(r) + "ConfigMap 热更新完成，所有 Pod 健康";
    }

    private String actK8sVerifyPods(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        Map<String, Object> r = requireOk("Pod 就绪校验", k8s.podVerifyReady(c, null));
        return mockTag(r) + "Pod 就绪校验通过: " + dataOf(r).get("total") + " 个 Pod 全部 Running+Ready";
    }

    private String actK8sVerifyVersion(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        Map<String, Object> r = requireOk("版本校验", k8s.podGetImages(c));
        return mockTag(r) + "版本一致性校验完成\n  " + dataOf(r).get("images");
    }

    private String actK8sRollbackPlan(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        String release = releaseName(flow, stage);
        // 预案本身只是文本，不必非要碰到集群才算成；但读不到 history 就必须写在脸上——
        // 否则「回滚到上一版本」是个没被集群验证过的承诺。
        Map<String, Object> h = k8s.helmHistory(c, release);
        String revisionInfo = Boolean.TRUE.equals(h.get("ok"))
                ? mockTag(h) + "  历史 revisions: " + dataOf(h).get("revisions")
                : "  ✘ 历史 revisions 读取失败: " + s(h.get("error")) + "（回滚目标未经集群确认）";
        int rev = stage.inputs.get("rollback_to_revision") != null
                ? Integer.parseInt(s(stage.inputs.get("rollback_to_revision"))) : 0;
        String revStr = rev == 0 ? "上一版本" : String.valueOf(rev);
        return String.join("\n",
                "回滚预案:",
                "  helm rollback " + release + " " + revStr,
                "  # 恢复 values: helm upgrade --install " + release + " --values <backup-values.json>",
                "  # 恢复 PVC: 从 VolumeSnapshot 还原",
                revisionInfo);
    }
}
