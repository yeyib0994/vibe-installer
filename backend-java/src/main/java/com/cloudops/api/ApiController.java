package com.cloudops.api;

import com.cloudops.core.Json;
import com.cloudops.core.Store;
import com.cloudops.engine.LogBus;
import com.cloudops.engine.StageExecutor;
import com.cloudops.engine.Workflow;
import com.cloudops.model.BackupPoint;
import com.cloudops.model.EnvironmentSpec;
import com.cloudops.model.FlowStage;
import com.cloudops.model.InstallFlow;
import com.cloudops.model.NodeSpec;
import com.cloudops.model.PackageEntry;
import com.cloudops.model.PackagePiece;
import com.cloudops.model.dto.EnvironmentSpecInput;
import com.cloudops.model.dto.FlowCreate;
import com.cloudops.model.dto.NodeSpecInput;
import com.cloudops.model.dto.PackageCreate;
import com.cloudops.model.dto.RestoreRequest;
import com.cloudops.model.dto.StageActionRequest;
import com.cloudops.model.dto.StageInputSubmit;
import com.cloudops.model.enums.BackupStatus;
import com.cloudops.model.enums.FlowStatus;
import com.cloudops.model.enums.MachineType;
import com.cloudops.model.enums.NodeRole;
import com.cloudops.model.enums.StageStatus;
import com.cloudops.model.enums.StepStatus;
import com.cloudops.services.BackupService;
import com.cloudops.services.NodeService;
import com.cloudops.services.UploadService;
import tools.jackson.core.type.TypeReference;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** REST API 路由 —— 与 Python 版 routes.py 对齐。 */
@RestController
@RequestMapping("/api")
public class ApiController {

    private final Store store;
    private final Workflow workflow;
    private final StageExecutor executor;
    private final LogBus bus;
    private final NodeService nodes;
    private final BackupService backupSvc;
    private final UploadService uploadSvc;
    private final com.cloudops.services.K8sOpsService k8s;

    public ApiController(Store store, Workflow workflow, StageExecutor executor,
                         LogBus bus, NodeService nodes, BackupService backupSvc,
                         UploadService uploadSvc, com.cloudops.services.K8sOpsService k8s) {
        this.store = store;
        this.workflow = workflow;
        this.executor = executor;
        this.bus = bus;
        this.nodes = nodes;
        this.backupSvc = backupSvc;
        this.uploadSvc = uploadSvc;
        this.k8s = k8s;
    }

    private static String sid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    private Map<String, Object> toMap(Object o) {
        return Json.mapper().convertValue(o, new TypeReference<Map<String, Object>>() {});
    }

    // ===================== 环境规格 =====================
    @GetMapping("/environments")
    public List<Map<String, Object>> listEnvironments() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (EnvironmentSpec e : store.listEnvs()) {
            Map<String, Object> d = toMap(e);
            d.put("summary", e.summary());
            out.add(d);
        }
        return out;
    }

    @PostMapping("/environments")
    public EnvironmentSpec createEnvironment(@RequestBody EnvironmentSpecInput body) {
        EnvironmentSpec env = new EnvironmentSpec();
        env.id = sid();
        env.name = body.name;
        env.description = body.description;
        env.baseDomain = body.baseDomain;
        env.ntpServer = body.ntpServer;
        env.dnsServers = body.dnsServers;
        env.timezone = body.timezone;
        store.saveEnv(env);
        store.audit("admin", "env.create", env.id, "ok", env.name);
        return env;
    }

    @GetMapping("/environments/{envId}")
    public Map<String, Object> getEnvironment(@PathVariable String envId) {
        EnvironmentSpec env = store.getEnv(envId);
        if (env == null) throw new ApiException(404, "环境不存在");
        Map<String, Object> d = toMap(env);
        d.put("summary", env.summary());
        return d;
    }

    @DeleteMapping("/environments/{envId}")
    public Map<String, Object> deleteEnvironment(@PathVariable String envId) {
        store.deleteEnv(envId);
        store.audit("admin", "env.delete", envId, "ok");
        return Map.of("ok", true);
    }

    @PostMapping("/environments/{envId}/nodes")
    public Map<String, Object> addNodes(@PathVariable String envId, @RequestBody List<NodeSpecInput> nodes) {
        EnvironmentSpec env = store.getEnv(envId);
        if (env == null) throw new ApiException(404, "环境不存在");
        for (NodeSpecInput n : nodes) {
            NodeSpec spec = new NodeSpec();
            spec.id = sid();
            spec.hostname = n.hostname;
            spec.ip = n.ip;
            spec.role = n.role;
            spec.machineType = n.machineType;
            spec.sshPort = n.sshPort;
            spec.sshUser = n.sshUser;
            spec.sshKeyPath = n.sshKeyPath;
            spec.vendor = n.vendor;
            spec.model = n.model;
            spec.idc = n.idc;
            spec.rack = n.rack;
            spec.nicSpeed = n.nicSpeed;
            spec.raidLevel = n.raidLevel;
            spec.hostPlatform = n.hostPlatform;
            spec.vcpu = n.vcpu;
            spec.memoryGb = n.memoryGb;
            spec.diskGb = n.diskGb;
            spec.imageTemplate = n.imageTemplate;
            env.nodes.add(spec);
        }
        store.saveEnv(env);
        return Map.of("ok", true, "total", env.nodes.size());
    }

    @DeleteMapping("/environments/{envId}/nodes/{nodeId}")
    public Map<String, Object> deleteNode(@PathVariable String envId, @PathVariable String nodeId) {
        EnvironmentSpec env = store.getEnv(envId);
        if (env == null) throw new ApiException(404, "环境不存在");
        env.nodes.removeIf(n -> n.id.equals(nodeId));
        store.saveEnv(env);
        return Map.of("ok", true);
    }

    // ===================== 工作流目录 =====================
    @GetMapping("/catalog/{mode}")
    public Map<String, Object> catalog(@PathVariable String mode) {
        return workflow.catalog(mode);
    }

    // ===================== 流程 =====================
    @GetMapping("/flows")
    public List<Map<String, Object>> listFlows(@RequestParam(defaultValue = "100") int limit) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (InstallFlow f : store.listFlows(limit)) {
            Map<String, Object> d = toMap(f);
            long done = f.stages.stream().filter(s -> s.status == StageStatus.PASSED || s.status == StageStatus.SKIPPED).count();
            Map<String, Object> progress = new HashMap<>();
            progress.put("done", done);
            progress.put("total", f.stages.size());
            d.put("progress", progress);
            out.add(d);
        }
        return out;
    }

    @PostMapping("/flows")
    public InstallFlow createFlow(@RequestBody FlowCreate body) {
        if (!"install".equals(body.mode) && !"upgrade".equals(body.mode) && !"upgrade_k8s".equals(body.mode)) {
            throw new ApiException(400, "mode 必须是 install、upgrade 或 upgrade_k8s");
        }
        EnvironmentSpec env = store.getEnv(body.envId);
        if (env == null && "install".equals(body.mode)) {
            throw new ApiException(400, "请先创建环境");
        }
        InstallFlow flow = workflow.createFlow(body.name, body.envId, body.mode, "admin");
        workflow.refreshLocks(flow);
        store.saveFlow(flow);
        store.audit("admin", "flow.create:" + body.mode, flow.id, "ok", flow.name);
        return flow;
    }

    @GetMapping("/flows/{flowId}")
    public Map<String, Object> getFlow(@PathVariable String flowId) {
        InstallFlow flow = store.getFlow(flowId);
        if (flow == null) throw new ApiException(404, "流程不存在");
        Map<String, Object> d = toMap(flow);
        EnvironmentSpec env = store.getEnv(flow.envId);
        d.put("env_summary", env != null ? env.summary() : Map.of("total", 0, "by_role", Map.of(), "by_type", Map.of(), "physical", 0, "virtual", 0));
        d.put("env_name", env != null ? env.name : "");
        List<Map<String, Object>> nodes = new ArrayList<>();
        if (env != null) for (NodeSpec n : env.nodes) nodes.add(toMap(n));
        d.put("nodes", nodes);
        long paths = flow.stages.stream().filter(s -> s.status == StageStatus.PASSED || s.status == StageStatus.SKIPPED).count();
        Map<String, Object> progress = new HashMap<>();
        progress.put("done", paths);
        progress.put("total", flow.stages.size());
        d.put("progress", progress);
        return d;
    }

    @DeleteMapping("/flows/{flowId}")
    public Map<String, Object> deleteFlow(@PathVariable String flowId) {
        store.deleteFlow(flowId);
        store.audit("admin", "flow.delete", flowId, "ok");
        return Map.of("ok", true);
    }

    // ===================== 阶段 =====================
    private FlowStage getStage(InstallFlow flow, String key) {
        FlowStage st = workflow.stageByKey(flow, key);
        if (st == null) throw new ApiException(404, "阶段 " + key + " 不存在");
        return st;
    }

    @PostMapping("/flows/{flowId}/stages/{stageKey}/inputs")
    public Map<String, Object> submitInputs(@PathVariable String flowId, @PathVariable String stageKey,
                                            @RequestBody StageInputSubmit body) {
        InstallFlow flow = store.getFlow(flowId);
        if (flow == null) throw new ApiException(404, "流程不存在");
        FlowStage st = getStage(flow, stageKey);

        String blocker = workflow.upstreamReady(flow, stageKey);
        if (blocker != null) throw new ApiException(409, "前置阶段「" + blocker + "」尚未通过，无法填写本阶段");

        List<String> errors = workflow.validateStageInputs(flow, stageKey, body.inputs);
        if (!errors.isEmpty()) {
            throw new ApiException(422, Map.of("errors", errors, "message", "表单校验未通过"));
        }

        if ("env_register".equals(stageKey) && !"upgrade_k8s".equals(flow.mode)) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> physical = (List<Map<String, Object>>) body.inputs.getOrDefault("physical_nodes", List.of());
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> virtual = (List<Map<String, Object>>) body.inputs.getOrDefault("virtual_nodes", List.of());
            EnvironmentSpec env = store.getEnv(flow.envId);
            if (env == null) throw new ApiException(404, "环境不存在");
            List<NodeSpec> built = new ArrayList<>();
            for (Map<String, Object> n : physical) {
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
            for (Map<String, Object> n : virtual) {
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
            if (body.inputs.get("base_domain") != null) env.baseDomain = s(body.inputs.get("base_domain"));
            if (body.inputs.get("ntp_server") != null) env.ntpServer = s(body.inputs.get("ntp_server"));
            @SuppressWarnings("unchecked")
            List<String> dns = (List<String>) body.inputs.getOrDefault("dns_servers", env.dnsServers);
            env.dnsServers = dns;
            if (body.inputs.get("timezone") != null) env.timezone = s(body.inputs.get("timezone"));
            store.saveEnv(env);
        }

        st.inputs.putAll(body.inputs);
        st.error = null;
        store.saveFlow(flow);
        EnvironmentSpec env = store.getEnv(flow.envId);
        Map<String, Object> out = new HashMap<>();
        out.put("ok", true);
        out.put("inputs", st.inputs);
        out.put("nodes", env != null ? env.nodes.size() : 0);
        return out;
    }

    @PostMapping("/flows/{flowId}/stages/{stageKey}/validate")
    public Map<String, Object> validateStage(@PathVariable String flowId, @PathVariable String stageKey,
                                             @RequestBody StageInputSubmit body) {
        InstallFlow flow = store.getFlow(flowId);
        if (flow == null) throw new ApiException(404, "流程不存在");
        Map<String, Object> merged = new HashMap<>(getStage(flow, stageKey).inputs);
        merged.putAll(body.inputs);
        List<String> errors = workflow.validateStageInputs(flow, stageKey, merged);
        return Map.of("valid", errors.isEmpty(), "errors", errors);
    }

    @PostMapping("/flows/{flowId}/stages/{stageKey}/run")
    public Map<String, Object> runStage(@PathVariable String flowId, @PathVariable String stageKey,
                                        @RequestBody StageActionRequest body) {
        InstallFlow flow = store.getFlow(flowId);
        if (flow == null) throw new ApiException(404, "流程不存在");
        FlowStage st = getStage(flow, stageKey);

        if (executor.isRunning(flowId, stageKey)) throw new ApiException(409, "该阶段正在执行中");

        String blocker = workflow.upstreamReady(flow, stageKey);
        if (blocker != null) throw new ApiException(409, "前置阶段「" + blocker + "」尚未通过");

        List<String> errors = workflow.validateStageInputs(flow, stageKey, st.inputs);
        if (!errors.isEmpty()) {
            throw new ApiException(422, Map.of("errors", errors, "message", "表单校验未通过，无法执行"));
        }

        executor.submit(flow, stageKey, body.operator);
        return Map.of("ok", true, "stage", stageKey, "status", "running");
    }

    @PostMapping("/flows/{flowId}/stages/{stageKey}/cancel")
    public Map<String, Object> cancelStage(@PathVariable String flowId, @PathVariable String stageKey) {
        return Map.of("ok", executor.cancel(flowId, stageKey));
    }

    @PostMapping("/flows/{flowId}/stages/{stageKey}/skip")
    public Map<String, Object> skipStage(@PathVariable String flowId, @PathVariable String stageKey,
                                         @RequestBody StageActionRequest body) {
        InstallFlow flow = store.getFlow(flowId);
        if (flow == null) throw new ApiException(404, "流程不存在");
        FlowStage st = getStage(flow, stageKey);

        if (st.required) throw new ApiException(409, "阶段「" + st.title + "」为必经阶段，不可跳过");
        String blocker = workflow.upstreamReady(flow, stageKey);
        if (blocker != null) throw new ApiException(409, "前置阶段「" + blocker + "」尚未通过");

        st.status = StageStatus.SKIPPED;
        st.finishedAt = LocalDateTime.now();
        workflow.refreshLocks(flow);
        boolean allDone = flow.stages.stream().allMatch(s -> s.status == StageStatus.PASSED || s.status == StageStatus.SKIPPED);
        if (allDone) {
            flow.status = FlowStatus.SUCCEEDED;
            flow.finishedAt = LocalDateTime.now();
        }
        store.saveFlow(flow);
        store.audit(body.operator, "stage.skip:" + stageKey, flowId, "ok");
        Map<String, Object> out = new HashMap<>();
        out.put("ok", true);
        out.put("stage", toMap(st));
        return out;
    }

    @GetMapping("/flows/{flowId}/stages/{stageKey}/logs")
    public List<Map<String, Object>> stageLogs(@PathVariable String flowId, @PathVariable String stageKey) {
        return bus.history(flowId + ":" + stageKey);
    }

    @GetMapping(value = "/flows/{flowId}/stages/{stageKey}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamStage(@PathVariable String flowId, @PathVariable String stageKey) {
        SseEmitter emitter = new SseEmitter(0L);
        String key = flowId + ":" + stageKey;
        Consumer<Map<String, Object>> cb = event -> {
            try {
                emitter.send(SseEmitter.event().data(Json.toJson(event)));
            } catch (IOException e) {
                emitter.completeWithError(e);
            }
        };
        // 先推送历史
        for (Map<String, Object> e : bus.history(key)) {
            try { emitter.send(SseEmitter.event().data(Json.toJson(e))); } catch (IOException ignored) {}
        }
        bus.subscribe(key, cb);
        emitter.onCompletion(() -> bus.unsubscribe(key, cb));
        emitter.onTimeout(() -> bus.unsubscribe(key, cb));
        emitter.onError(t -> bus.unsubscribe(key, cb));

        // 后台线程轮询阶段状态，结束时推送 close
        Executors.newSingleThreadExecutor().submit(() -> {
            try {
                while (true) {
                    Thread.sleep(300);
                    InstallFlow f = store.getFlow(flowId);
                    FlowStage st = f != null ? workflow.stageByKey(f, stageKey) : null;
                    if (st != null && (st.status == StageStatus.PASSED || st.status == StageStatus.FAILED || st.status == StageStatus.SKIPPED)) {
                        Map<String, Object> close = new HashMap<>();
                        close.put("type", "close");
                        close.put("status", st.status.getValue());
                        try { emitter.send(SseEmitter.event().data(Json.toJson(close))); } catch (IOException ignored) {}
                        emitter.complete();
                        break;
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        return emitter;
    }

    // ===================== 安装包 =====================
    @GetMapping("/packages")
    public List<Map<String, Object>> listPackages() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (PackageEntry p : store.listPackages()) {
            Map<String, Object> d = toMap(p);
            d.put("progress", p.getProgress());
            out.add(d);
        }
        return out;
    }

    @PostMapping("/packages")
    public PackageEntry createPackage(@RequestBody PackageCreate body) {
        PackageEntry p = new PackageEntry();
        p.id = sid();
        p.name = body.name;
        p.version = body.version;
        p.kind = body.kind;
        p.sizeBytes = body.sizeBytes;
        p.note = body.note;
        store.savePackage(p);
        return p;
    }

    @PostMapping("/packages/upload")
    public Map<String, Object> uploadPackage(@RequestParam("file") MultipartFile file,
                                             @RequestParam(value = "name", defaultValue = "") String name,
                                             @RequestParam(value = "version", defaultValue = "") String version,
                                             @RequestParam(value = "kind", defaultValue = "bundle") String kind,
                                             @RequestParam(value = "flow_id", defaultValue = "") String flowId) throws IOException, java.security.NoSuchAlgorithmException {
        String pid = sid();
        Path pkgDir = store.dataDir.resolve("packages");
        Files.createDirectories(pkgDir);
        Path dest = pkgDir.resolve(pid + "-" + file.getOriginalFilename());

        MessageDigest h = MessageDigest.getInstance("SHA-256");
        long total = 0;
        final long CHUNK = 64L * 1024 * 1024;
        int pieceIdx = 0;
        long pieceSize = 0;
        MessageDigest pieceH = MessageDigest.getInstance("SHA-256");
        List<PackagePiece> pieces = new ArrayList<>();

        try (var in = file.getInputStream(); var out = Files.newOutputStream(dest)) {
            byte[] buf = new byte[4 * 1024 * 1024];
            int rd;
            while ((rd = in.read(buf)) > 0) {
                out.write(buf, 0, rd);
                h.update(buf, 0, rd);
                pieceH.update(buf, 0, rd);
                total += rd;
                pieceSize += rd;
                if (pieceSize >= CHUNK) {
                    pieces.add(new PackagePiece(pieceIdx, (int) pieceSize, toHex(pieceH.digest())));
                    pieceIdx++;
                    pieceSize = 0;
                    pieceH = MessageDigest.getInstance("SHA-256");
                }
            }
        }
        if (pieceSize > 0) pieces.add(new PackagePiece(pieceIdx, (int) pieceSize, toHex(pieceH.digest())));

        PackageEntry entry = new PackageEntry();
        entry.id = pid;
        entry.name = name.isEmpty() ? (file.getOriginalFilename() != null ? file.getOriginalFilename() : pid) : name;
        entry.version = version;
        entry.kind = kind;
        entry.sizeBytes = total;
        entry.checksum = toHex(h.digest());
        entry.path = dest.toString();
        entry.pieces = pieces;
        entry.uploadComplete = true;
        entry.uploadedBytes = total;
        store.savePackage(entry);
        store.audit("admin", "package.upload", pid, "ok", entry.name + " " + total + " bytes");

        if (!flowId.isEmpty()) {
            InstallFlow flow = store.getFlow(flowId);
            if (flow != null) {
                FlowStage st = workflow.stageByKey(flow, "package_upload");
                if (st != null) {
                    st.inputs.put("_package_id", pid);
                    @SuppressWarnings("unchecked")
                    List<String> ids = (List<String>) st.inputs.getOrDefault("_package_ids", new ArrayList<String>());
                    if (!ids.contains(pid)) ids.add(pid);
                    st.inputs.put("_package_ids", ids);
                    store.saveFlow(flow);
                }
            }
        }

        Map<String, Object> out = toMap(entry);
        out.put("pieces_count", pieces.size());
        return out;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    // ===================== 断点续传上传 =====================

    /** 初始化上传会话，返回 upload_id 与分片参数。客户端据此分片上传。 */
    @PostMapping("/packages/upload/init")
    public Map<String, Object> initUpload(@RequestBody Map<String, Object> body) throws IOException {
        String name = s(body.get("name"));
        String version = s(body.get("version"));
        String kind = s(body.getOrDefault("kind", "bundle").toString());
        long sizeBytes = body.get("size_bytes") != null ? Long.parseLong(s(body.get("size_bytes"))) : 0;
        Integer chunkSize = body.get("chunk_size") != null ? Integer.parseInt(s(body.get("chunk_size"))) : null;
        String flowId = s(body.get("flow_id"));

        var sess = uploadSvc.init(name, version, kind, sizeBytes, chunkSize, flowId);
        Map<String, Object> out = new HashMap<>();
        out.put("upload_id", sess.id);
        out.put("name", sess.name);
        out.put("size_bytes", sess.sizeBytes);
        out.put("chunk_size", sess.chunkSize);
        out.put("total_chunks", sess.totalChunks);
        out.put("flow_id", sess.flowId);
        return out;
    }

    /** 上传单个分片。支持重复上传（幂等），已上传的分片可跳过。 */
    @PostMapping("/packages/upload/chunk")
    public Map<String, Object> uploadChunk(@RequestParam("upload_id") String uploadId,
                                           @RequestParam("chunk_index") int chunkIndex,
                                           @RequestParam("file") MultipartFile file) throws IOException {
        return uploadSvc.chunk(uploadId, chunkIndex, file.getInputStream());
    }

    /** 查询上传状态：已完成分片列表、进度，用于断点续传。 */
    @GetMapping("/packages/upload/{uploadId}")
    public Map<String, Object> uploadStatus(@PathVariable String uploadId) {
        var sess = uploadSvc.status(uploadId);
        Map<String, Object> out = new HashMap<>();
        out.put("upload_id", sess.id);
        out.put("name", sess.name);
        out.put("size_bytes", sess.sizeBytes);
        out.put("uploaded_bytes", sess.uploadedBytes);
        out.put("chunk_size", sess.chunkSize);
        out.put("total_chunks", sess.totalChunks);
        out.put("done_chunks", sess.doneChunks);
        out.put("progress", sess.getProgress());
        out.put("complete", sess.complete);
        return out;
    }

    /** 完成上传：合并分片、计算校验和、注册安装包。 */
    @PostMapping("/packages/upload/{uploadId}/complete")
    public Map<String, Object> completeUpload(@PathVariable String uploadId) throws IOException {
        PackageEntry entry = uploadSvc.complete(uploadId);

        // 关联到流程的包上传阶段
        var sess = uploadSvc.status(uploadId);
        if (sess.flowId != null && !sess.flowId.isEmpty()) {
            InstallFlow flow = store.getFlow(sess.flowId);
            if (flow != null) {
                FlowStage st = workflow.stageByKey(flow, "package_upload");
                if (st != null) {
                    st.inputs.put("_package_id", entry.id);
                    @SuppressWarnings("unchecked")
                    List<String> ids = (List<String>) st.inputs.getOrDefault("_package_ids", new ArrayList<String>());
                    if (!ids.contains(entry.id)) ids.add(entry.id);
                    st.inputs.put("_package_ids", ids);
                    store.saveFlow(flow);
                }
            }
        }

        Map<String, Object> out = toMap(entry);
        out.put("pieces_count", entry.pieces.size());
        return out;
    }

    @DeleteMapping("/packages/{pid}")
    public Map<String, Object> deletePackage(@PathVariable String pid) {
        store.deletePackage(pid);
        return Map.of("ok", true);
    }

    // ===================== 分发 =====================
    @GetMapping("/flows/{flowId}/distributions")
    public Object listDistributions(@PathVariable String flowId) {
        return store.listDistributions(flowId);
    }

    @GetMapping("/distributions/{did}")
    public Object getDistribution(@PathVariable String did) {
        Object d = store.getDistribution(did);
        if (d == null) throw new ApiException(404, "分发任务不存在");
        return d;
    }

    // ===================== 备份 =====================
    @GetMapping("/backups")
    public Object listBackups(@RequestParam(required = false) String envId) {
        return store.listBackups(envId);
    }

    @GetMapping("/backups/{bid}")
    public BackupPoint getBackup(@PathVariable String bid) {
        BackupPoint b = store.getBackup(bid);
        if (b == null) throw new ApiException(404, "备份点不存在");
        return b;
    }

    @PostMapping("/backups/{bid}/verify")
    public Map<String, Object> verifyBackup(@PathVariable String bid) {
        BackupPoint b = store.getBackup(bid);
        if (b == null) throw new ApiException(404, "备份点不存在");
        Path base = Paths.get(b.path);
        if (!Files.exists(base)) {
            b.status = BackupStatus.FAILED;
            b.error = "备份目录不存在";
            store.saveBackup(b);
            throw new ApiException(409, "备份目录不存在，备份点已标记为失败");
        }

        MessageDigest h;
        int files = 0;
        long size = 0;
        try {
            h = MessageDigest.getInstance("SHA-256");
            try (var stream = Files.walk(base)) {
                List<Path> all = stream.filter(Files::isRegularFile).sorted().toList();
                for (Path f : all) {
                    h.update(f.getFileName().toString().getBytes());
                    long sz = Files.size(f);
                    h.update(String.valueOf(sz).getBytes());
                    files++;
                    size += sz;
                }
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }

        String digest = (String) backupSvc.backupDigest(b)[0];
        b.verifiedAt = LocalDateTime.now();
        boolean ok = digest.equals(b.checksum);
        if (ok) {
            b.status = BackupStatus.VERIFIED;
            store.saveBackup(b);
        }
        store.audit("admin", "backup.verify", bid, ok ? "ok" : "mismatch");
        Map<String, Object> out = new HashMap<>();
        out.put("ok", ok);
        out.put("files", files);
        out.put("size_bytes", size);
        out.put("expected", b.checksum.substring(0, Math.min(32, b.checksum.length())));
        out.put("actual", digest.substring(0, Math.min(32, digest.length())));
        out.put("message", ok ? "校验通过，备份可正常恢复" : "校验和不一致，备份可能已损坏");
        return out;
    }

    @PostMapping("/backups/{bid}/restore")
    public Map<String, Object> restoreBackup(@PathVariable String bid, @RequestBody RestoreRequest body) {
        BackupPoint b = store.getBackup(bid);
        if (b == null) throw new ApiException(404, "备份点不存在");
        if (!body.confirm) {
            throw new ApiException(428, "恢复操作将覆盖目标节点数据，需显式确认。备份点 " + b.name + " 覆盖 " + b.nodesCovered.size() + " 台节点");
        }
        if (!b.restorable) throw new ApiException(409, "该备份点未标记为可恢复");
        if (b.status == BackupStatus.EXPIRED) throw new ApiException(409, "该备份点已过期，可能已被清理");

        EnvironmentSpec env = store.getEnv(b.envId);
        if (env == null) throw new ApiException(404, "环境不存在");
        List<NodeSpec> targets = body.nodeIds.isEmpty()
                ? env.nodes
                : env.nodes.stream().filter(n -> body.nodeIds.contains(n.id)).toList();
        if (targets.isEmpty()) throw new ApiException(400, "没有匹配的恢复目标节点");

        Path base = Paths.get(b.path);
        List<String> lines = new ArrayList<>();
        for (NodeSpec n : targets) {
            Path nodeDir = base.resolve(n.hostname);
            if (!Files.exists(nodeDir)) {
                lines.add("  – " + n.hostname + ": 无备份数据，跳过");
                continue;
            }
            NodeService.BaseDriver drv = nodes.getDriver(n);
            if (drv.isMock) {
                lines.add(String.format("  ✔ %-20s [MOCK] 已恢复目录与配置文件", n.hostname));
            } else {
                NodeService.CmdResult r = drv.ssh("mkdir -p /opt/restore && echo ok", 60);
                lines.add(String.format("  %s %-20s %s", r.ok ? "✔" : "✘", n.hostname, r.ok ? "已回传备份数据" : r.stderr.strip().substring(0, Math.min(60, r.stderr.strip().length()))));
            }
        }
        b.status = BackupStatus.RESTORED;
        store.saveBackup(b);
        store.audit("admin", "backup.restore", bid, "ok", targets.size() + " 台节点");
        Map<String, Object> out = new HashMap<>();
        out.put("ok", true);
        out.put("restored_nodes", targets.stream().map(n -> n.hostname).toList());
        out.put("detail", String.join("\n", lines));
        return out;
    }

    @PostMapping("/backups/{bid}/expire")
    public Map<String, Object> expireBackup(@PathVariable String bid) {
        BackupPoint b = store.getBackup(bid);
        if (b == null) throw new ApiException(404, "备份点不存在");
        b.status = BackupStatus.EXPIRED;
        b.restorable = false;
        store.saveBackup(b);
        return Map.of("ok", true);
    }

    // ===================== 概览 / 审计 / 能力 =====================
    @GetMapping("/capabilities")
    public Map<String, Object> capabilities() {
        boolean forced = nodes.forceMock();
        boolean sshOk = nodes.sshAvailable();
        boolean effectiveMock = forced || !sshOk;
        String notice;
        if (forced) notice = "已设置 CLOUDOPS_FORCE_MOCK=1，节点操作全部以模拟模式执行";
        else if (!sshOk) notice = "本机缺少 ssh/scp，节点操作将以模拟模式执行";
        else notice = "";
        Map<String, Object> out = new HashMap<>();
        out.put("ssh", sshOk);
        out.put("rsync", nodes.rsyncAvailable());
        out.put("force_mock", forced);
        out.put("effective_mode", effectiveMock ? "mock" : "real");
        out.put("mock_notice", notice);
        return out;
    }

    @GetMapping("/overview")
    public Map<String, Object> overview() {
        List<EnvironmentSpec> envs = store.listEnvs();
        List<InstallFlow> flows = store.listFlows(200);
        List<PackageEntry> pkgs = store.listPackages();
        List<BackupPoint> backups = store.listBackups(null);

        Map<String, EnvironmentSpec> envById = new HashMap<>();
        for (EnvironmentSpec e : envs) envById.put(e.id, e);

        long nodesTotal = envs.stream().mapToLong(e -> e.nodes.size()).sum();
        long physical = envs.stream().mapToLong(e -> e.nodes.stream().filter(n -> n.machineType == MachineType.PHYSICAL).count()).sum();
        long virtual = envs.stream().mapToLong(e -> e.nodes.stream().filter(n -> n.machineType == MachineType.VIRTUAL).count()).sum();

        Map<String, Long> byStatus = new HashMap<>();
        for (InstallFlow f : flows) byStatus.merge(f.status.getValue(), 1L, Long::sum);

        long packagesBytes = pkgs.stream().mapToLong(p -> p.sizeBytes).sum();
        long backupsBytes = backups.stream().mapToLong(b -> b.sizeBytes).sum();
        long restorable = backups.stream().filter(b -> b.restorable && b.status != BackupStatus.EXPIRED).count();

        List<Map<String, Object>> recentFlows = new ArrayList<>();
        for (InstallFlow f : flows.subList(0, Math.min(8, flows.size()))) {
            Map<String, Object> d = toMap(f);
            long done = f.stages.stream().filter(s -> s.status == StageStatus.PASSED || s.status == StageStatus.SKIPPED).count();
            Map<String, Object> progress = new HashMap<>();
            progress.put("done", done);
            progress.put("total", f.stages.size());
            d.put("progress", progress);
            EnvironmentSpec env = envById.get(f.envId);
            d.put("env_name", env != null ? env.name : "");
            recentFlows.add(d);
        }

        List<Map<String, Object>> envsDetail = new ArrayList<>();
        for (EnvironmentSpec e : envs) {
            Map<String, Object> d = toMap(e);
            d.put("summary", e.summary());
            envsDetail.add(d);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("environments", envs.size());
        out.put("flows_total", flows.size());
        out.put("flows_by_status", byStatus);
        out.put("packages", pkgs.size());
        out.put("packages_bytes", packagesBytes);
        out.put("backups", backups.size());
        out.put("backups_bytes", backupsBytes);
        out.put("backups_restorable", restorable);
        out.put("nodes_total", nodesTotal);
        out.put("nodes_physical", physical);
        out.put("nodes_virtual", virtual);
        out.put("recent_flows", recentFlows);
        out.put("environments_detail", envsDetail);
        return out;
    }

    @GetMapping("/audit")
    public List<Map<String, Object>> listAudit(@RequestParam(defaultValue = "200") int limit) {
        return store.listAudit(limit);
    }

    // ===================== K8s 集群管理 =====================

    @PostMapping("/k8s/clusters")
    public com.cloudops.model.K8sCluster createCluster(@RequestBody com.cloudops.model.K8sCluster c) {
        return store.saveCluster(c);
    }

    @GetMapping("/k8s/clusters")
    public List<com.cloudops.model.K8sCluster> listClusters() {
        return store.listClusters();
    }

    @GetMapping("/k8s/clusters/{id}")
    public com.cloudops.model.K8sCluster getCluster(@PathVariable String id) {
        com.cloudops.model.K8sCluster c = store.getCluster(id);
        if (c == null) throw new ApiException(404, Map.of("detail", "集群不存在"));
        return c;
    }

    @DeleteMapping("/k8s/clusters/{id}")
    public Map<String, Object> deleteCluster(@PathVariable String id) {
        store.deleteCluster(id);
        return Map.of("ok", true, "id", id);
    }

    /** 列出目标集群的 Helm Releases。 */
    @GetMapping("/k8s/clusters/{id}/releases")
    public Map<String, Object> listReleases(@PathVariable String id) {
        com.cloudops.model.K8sCluster c = store.getCluster(id);
        if (c == null) throw new ApiException(404, Map.of("detail", "集群不存在"));
        return k8s.helmList(c);
    }

    /** 执行 Helm 回滚。 */
    @PostMapping("/flows/{flowId}/rollback")
    public Map<String, Object> rollbackFlow(@PathVariable String flowId,
                                            @RequestBody(required = false) Map<String, Object> body) {
        InstallFlow flow = store.getFlow(flowId);
        if (flow == null) throw new ApiException(404, Map.of("detail", "流程不存在"));
        // 从 env_register 阶段读取集群信息
        FlowStage register = workflow.stageByKey(flow, "env_register");
        if (register == null) throw new ApiException(400, Map.of("detail", "流程缺少环境登记阶段"));
        com.cloudops.model.K8sCluster c = new com.cloudops.model.K8sCluster();
        c.namespace = s(register.inputs.getOrDefault("namespace", "default"));
        Object kc = register.inputs.get("kubeconfig");
        c.kubeconfig = kc != null ? kc.toString() : null;
        String release = s(register.inputs.get("release_name"));
        Integer revision = body != null && body.get("revision") != null
                ? Integer.parseInt(s(body.get("revision"))) : null;
        Map<String, Object> r = k8s.helmRollback(c, release, revision);
        store.audit("admin", "flow.rollback", flowId,
                Boolean.TRUE.equals(r.get("ok")) ? "ok" : "failed", release);
        return r;
    }

    private static String s(Object v) {
        return v == null ? "" : v.toString();
    }

    // ===================== 异常 =====================
    public static class ApiException extends RuntimeException {
        public final int status;
        public final Object body;
        public ApiException(int status, String message) {
            super(message);
            this.status = status;
            this.body = Map.of("detail", message);
        }
        public ApiException(int status, Map<String, Object> body) {
            super(String.valueOf(body.get("message")));
            this.status = status;
            this.body = body;
        }
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(ApiException.class)
    public ResponseEntity<Object> handleApi(ApiException e) {
        return ResponseEntity.status(HttpStatus.valueOf(e.status)).body(e.body);
    }
}
