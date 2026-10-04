package com.cloudops.services;

import com.cloudops.core.Json;
import com.cloudops.model.K8sCluster;
import org.springframework.stereotype.Service;
import tools.jackson.core.type.TypeReference;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** K8s 操作服务：调用 TypeScript CLI（node dist/k8s-ops.js），解析 JSON 输出。
 *
 *  所有 K8s API 操作（helm 升级/回滚、Pod 校验、备份、冒烟测试）下沉到 TS 脚本，
 *  Java 只负责参数组装与结果解析。
 */
@Service
public class K8sOpsService {

    /** k8s-ops CLI 入口，可用环境变量 CLOUDOPS_K8S_OPS 覆盖。 */
    private static final Path K8S_OPS = Paths.get(
            System.getenv().getOrDefault("CLOUDOPS_K8S_OPS", "k8s-ops/dist/index.js"))
            .toAbsolutePath();

    /** 执行一个 K8s 操作，返回解析后的 Map。 */
    public Map<String, Object> call(String action, Map<String, Object> params) {
        Map<String, Object> payload = new HashMap<>(params);
        payload.put("action", action);
        String stdin = Json.toJson(payload);

        List<String> cmd = new ArrayList<>();
        cmd.add("node");
        cmd.add(K8S_OPS.toString());

        NodeService.CmdResult r = NodeService.run(cmd, 300, stdin);
        String out = r.stdout.strip();
        if (!r.ok || out.isEmpty()) {
            String err = r.stderr.strip().isEmpty() ? r.stdout.strip() : r.stderr.strip();
            Map<String, Object> fail = new HashMap<>();
            fail.put("ok", false);
            fail.put("error", err);
            return fail;
        }
        try {
            return Json.mapper().readValue(out, new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            Map<String, Object> fail = new HashMap<>();
            fail.put("ok", false);
            fail.put("error", "TS 脚本输出解析失败: " + e.getMessage());
            return fail;
        }
    }

    // ===================== Helm 操作 =====================

    public Map<String, Object> helmUpgrade(K8sCluster cluster, String releaseName,
                                           String chart, String version,
                                           String valuesFile, Map<String, Object> setValues) {
        Map<String, Object> p = baseParams(cluster, releaseName);
        p.put("chart", chart);
        if (version != null) p.put("version", version);
        if (valuesFile != null) p.put("values_file", valuesFile);
        if (setValues != null) p.put("set_values", setValues);
        return call("helm.upgrade", p);
    }

    public Map<String, Object> helmRollback(K8sCluster cluster, String releaseName, Integer revision) {
        Map<String, Object> p = baseParams(cluster, releaseName);
        if (revision != null) p.put("revision", revision);
        return call("helm.rollback", p);
    }

    public Map<String, Object> helmGetValues(K8sCluster cluster, String releaseName) {
        return call("helm.get_values", baseParams(cluster, releaseName));
    }

    public Map<String, Object> helmGetManifest(K8sCluster cluster, String releaseName) {
        return call("helm.get_manifest", baseParams(cluster, releaseName));
    }

    public Map<String, Object> helmHistory(K8sCluster cluster, String releaseName) {
        return call("helm.history", baseParams(cluster, releaseName));
    }

    public Map<String, Object> helmList(K8sCluster cluster) {
        Map<String, Object> p = new HashMap<>();
        p.put("namespace", cluster.namespace);
        if (cluster.kubeconfig != null) p.put("kubeconfig", cluster.kubeconfig);
        return call("helm.list", p);
    }

    // ===================== Pod 操作 =====================

    public Map<String, Object> podVerifyReady(K8sCluster cluster, String labelSelector) {
        Map<String, Object> p = baseParams(cluster, null);
        if (labelSelector != null) p.put("label_selector", labelSelector);
        return call("pod.verify_ready", p);
    }

    public Map<String, Object> podRolloutStatus(K8sCluster cluster, List<String> workloads) {
        Map<String, Object> p = baseParams(cluster, null);
        p.put("workloads", workloads);
        return call("pod.rollout_status", p);
    }

    public Map<String, Object> podGetImages(K8sCluster cluster) {
        return call("pod.get_images", baseParams(cluster, null));
    }

    // ===================== 备份操作 =====================

    public Map<String, Object> backupExportValues(K8sCluster cluster, String releaseName, String backupDir) {
        Map<String, Object> p = baseParams(cluster, releaseName);
        if (backupDir != null) p.put("backup_dir", backupDir);
        return call("backup.export_values", p);
    }

    public Map<String, Object> backupExportManifest(K8sCluster cluster, String releaseName, String backupDir) {
        Map<String, Object> p = baseParams(cluster, releaseName);
        if (backupDir != null) p.put("backup_dir", backupDir);
        return call("backup.export_manifest", p);
    }

    public Map<String, Object> backupVolumeSnapshot(K8sCluster cluster, String pvcName, String snapshotClass) {
        Map<String, Object> p = baseParams(cluster, null);
        p.put("pvc_name", pvcName);
        if (snapshotClass != null) p.put("snapshot_class", snapshotClass);
        return call("backup.volume_snapshot", p);
    }

    public Map<String, Object> backupListPvc(K8sCluster cluster) {
        return call("backup.list_pvc", baseParams(cluster, null));
    }

    // ===================== 冒烟测试 =====================

    public Map<String, Object> smokeHttp(String url, Integer timeout) {
        Map<String, Object> p = new HashMap<>();
        p.put("url", url);
        if (timeout != null) p.put("timeout", timeout);
        return call("smoke.http", p);
    }

    // ===================== 辅助 =====================

    private Map<String, Object> baseParams(K8sCluster cluster, String releaseName) {
        Map<String, Object> p = new HashMap<>();
        p.put("namespace", cluster.namespace);
        if (cluster.kubeconfig != null) p.put("kubeconfig", cluster.kubeconfig);
        if (releaseName != null) p.put("release_name", releaseName);
        return p;
    }
}
