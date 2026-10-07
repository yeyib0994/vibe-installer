package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.EnvironmentSpec;
import com.cloudops.model.FlowStage;
import com.cloudops.model.FlowStep;
import com.cloudops.model.InstallFlow;
import com.cloudops.model.NodeSpec;
import com.cloudops.services.BackupService;
import com.cloudops.services.BundleUnpacker;
import com.cloudops.services.K8sOpsService;
import com.cloudops.services.NodeService;
import com.cloudops.services.VersioningService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 集群侧动作的诚实性：sidecar 报 ok=false 时阶段必须红。
 *
 * 回归的是这一整类假成功 —— helm 渲染失败、Pod 未就绪、备份没落盘都曾被写成
 * `return "X: " + error`，于是步骤 ✔、阶段 passed、流程 succeeded，
 * 而集群里什么都没发生（2026-10-07 用真实 helm 实测复现）。
 */
class StageExecutorK8sHonestyTest {

    @AfterEach
    void closeStores() {
        TestSupport.closeOpened();
    }

    /** 按 action 给定回包；没列出的 action 一律回真实成功，好让单个用例只改自己那一项。 */
    private static K8sOpsService k8s(Map<String, Map<String, Object>> replies) {
        return new K8sOpsService() {
            @Override
            public Map<String, Object> call(String action, Map<String, Object> params) {
                return replies.getOrDefault(action, ok(Map.of()));
            }
        };
    }

    private static Map<String, Object> ok(Map<String, Object> data) {
        return Map.of("ok", true, "data", data);
    }

    private static Map<String, Object> fail(String why) {
        return Map.of("ok", false, "error", why);
    }

    /** 模拟通路的成功结果：与真实成功必须能分辨（靠 mock 标记）。 */
    private static Map<String, Object> mocked(Map<String, Object> data) {
        return Map.of("ok", true, "mock", true, "data", data);
    }

    private static FlowStep action(String a) {
        FlowStep s = new FlowStep();
        s.id = "s1";
        s.index = 0;
        s.title = a;
        s.detail = "";
        s.action = a;
        return s;
    }

    private static StageExecutor executor(Store store, Workflow w, K8sOpsService k8s, NodeService nodes) {
        return new StageExecutor(store, new LogBus(), w, nodes, new BackupService(),
                new VersioningService(), k8s, new BundleUnpacker());
    }

    /** 一条已过环境登记、chart 已注入的 K8s 流程（真集群里这两项分别来自阶段 1 与阶段 2）。 */
    private static InstallFlow k8sFlow(Store store, Workflow w) {
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        w.stageByKey(flow, "env_register").inputs.put("namespace", "shipdesk-verify");
        w.stageByKey(flow, "env_register").inputs.put("release_name", "app");
        w.stageByKey(flow, "upgrade_execute").inputs.put("chart", "/tmp/app-1.0.0.tgz");
        return flow;
    }

    private static FlowStage anyStage(Workflow w, InstallFlow flow, String key) {
        return w.stageByKey(flow, key);
    }

    private String run(Store store, Workflow w, InstallFlow flow, String stageKey, String action,
                       K8sOpsService k8s, NodeService nodes) {
        return executor(store, w, k8s, nodes).execute(flow, anyStage(w, flow, stageKey), action(action));
    }

    /** 断言「失败被如实抛出，且把集群原话带出来」。 */
    private void assertFailsWith(Store store, Workflow w, InstallFlow flow, String stageKey,
                                 String action, K8sOpsService k8s, String needle) {
        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> run(store, w, flow, stageKey, action, k8s, new NodeService()));
        assertTrue(ex.getMessage().contains(needle), action + " 的消息该含集群原话，实际：" + ex.getMessage());
    }

    @Test
    void helm渲染失败必须让执行升级失败(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        var k8s = k8s(Map.of("helm.upgrade", fail("UPGRADE FAILED: execution error at (templates/bad.yaml:6:12)")));

        assertFailsWith(store, w, flow, "upgrade_execute", "upgrade.helm_upgrade", k8s, "UPGRADE FAILED");
    }

    @Test
    void pod未就绪必须让rollout与configmap热更新失败(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        var k8s = k8s(Map.of("pod.verify_ready", fail("1 个 Pod 未就绪")));

        assertFailsWith(store, w, flow, "upgrade_execute", "upgrade.rollout_status", k8s, "1 个 Pod 未就绪");
        assertFailsWith(store, w, flow, "upgrade_execute", "upgrade.config_roll", k8s, "1 个 Pod 未就绪");
    }

    @Test
    void pod未就绪必须让健康检查与升级后校验失败(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        var k8s = k8s(Map.of("pod.verify_ready", fail("2 个 Pod 未就绪")));

        assertFailsWith(store, w, flow, "env_precheck", "precheck.k8s_health", k8s, "2 个 Pod 未就绪");
        assertFailsWith(store, w, flow, "post_verify", "verify.pods", k8s, "2 个 Pod 未就绪");
    }

    @Test
    void 发现不了release就不能算登记完成(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        // 旧代码在这里「记录但不阻断（演示环境）」——那正是假成功的源头。
        var k8s = k8s(Map.of("helm.list", fail("helm 启动失败: ENOENT")));

        assertFailsWith(store, w, flow, "env_register", "k8s.discover", k8s, "ENOENT");
        assertFailsWith(store, w, flow, "env_register", "k8s.lock_target", k8s, "ENOENT");
    }

    @Test
    void 备份没导出就不能说备份完成(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        var k8s = k8s(Map.of(
                "backup.export_values", fail("Error: release: not found"),
                "backup.export_manifest", fail("manifest 读取超时")));

        assertFailsWith(store, w, flow, "pre_upgrade_backup", "backup.helm_values", k8s, "not found");
        assertFailsWith(store, w, flow, "pre_upgrade_backup", "backup.helm_manifest", k8s, "超时");
    }

    @Test
    void pvc列表拿不到或快照只成一半都必须失败(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);

        assertFailsWith(store, w, flow, "pre_upgrade_backup", "backup.pvc_snapshot",
                k8s(Map.of("backup.list_pvc", fail("the server could not find the requested resource"))),
                "could not find");

        var allBad = k8s(Map.of(
                "backup.list_pvc", ok(Map.of("pvcs", java.util.List.of(
                        Map.of("name", "data-a"), Map.of("name", "data-b")))),
                "backup.volume_snapshot", fail("VolumeSnapshotClass \"default\" not found")));
        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> run(store, w, flow, "pre_upgrade_backup", "backup.pvc_snapshot", allBad, new NodeService()));
        assertTrue(ex.getMessage().contains("2/2"), "该说清成了几台，实际：" + ex.getMessage());

        // 半成功才是真正危险的那一种：日志里有一行 ✔，回滚时却发现少一份快照。
        K8sOpsService half = new K8sOpsService() {
            @Override
            public Map<String, Object> call(String action, Map<String, Object> params) {
                if (action.equals("backup.list_pvc")) {
                    return ok(Map.of("pvcs", java.util.List.of(Map.of("name", "data-a"), Map.of("name", "data-b"))));
                }
                if (action.equals("backup.volume_snapshot")) {
                    return "data-b".equals(params.get("pvc_name"))
                            ? fail("snapshot 创建被 apiserver 拒绝")
                            : ok(Map.of("snapshot_name", "data-a-snap"));
                }
                return ok(Map.of());
            }
        };
        StageExecutor.StageFailure halfEx = assertThrows(StageExecutor.StageFailure.class,
                () -> run(store, w, flow, "pre_upgrade_backup", "backup.pvc_snapshot", half, new NodeService()));
        assertTrue(halfEx.getMessage().contains("1/2"), halfEx.getMessage());
        assertTrue(halfEx.getMessage().contains("data-b"), halfEx.getMessage());
    }

    @Test
    void 版本校验读不到镜像必须失败(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        var k8s = k8s(Map.of("pod.get_images", fail("connection refused")));

        assertFailsWith(store, w, flow, "post_verify", "verify.version", k8s, "connection refused");
    }

    @Test
    void 模拟模式的每一步都带mock前缀而不是冒充真实结果(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        var k8s = k8s(Map.of(
                "helm.list", mocked(Map.of("releases", java.util.List.of())),
                "helm.upgrade", mocked(Map.of("stdout", "")),
                "pod.verify_ready", mocked(Map.of("total", 0, "all_ready", true)),
                "backup.export_values", mocked(Map.of("file", "/tmp/app-values.json（模拟，未落盘）")),
                "backup.list_pvc", mocked(Map.of("pvcs", java.util.List.of())),
                "pod.get_images", mocked(Map.of("images", java.util.List.of())),
                "helm.history", mocked(Map.of("revisions", java.util.List.of()))));

        String out = run(store, w, flow, "upgrade_execute", "upgrade.helm_upgrade", k8s, new NodeService());
        assertTrue(out.startsWith("[MOCK] "), out);
        assertTrue(run(store, w, flow, "env_register", "k8s.discover", k8s, new NodeService()).startsWith("[MOCK] "));
        assertTrue(run(store, w, flow, "env_precheck", "precheck.k8s_health", k8s, new NodeService()).startsWith("[MOCK] "));
        assertTrue(run(store, w, flow, "pre_upgrade_backup", "backup.helm_values", k8s, new NodeService()).startsWith("[MOCK] "));
        assertTrue(run(store, w, flow, "post_verify", "verify.pods", k8s, new NodeService()).startsWith("[MOCK] "));
        // 真实成功不该带前缀
        var real = k8s(Map.of("helm.upgrade", ok(Map.of("stdout", "Release \"app\" has been upgraded."))));
        assertTrue(!run(store, w, flow, "upgrade_execute", "upgrade.helm_upgrade", real, new NodeService())
                .startsWith("[MOCK] "));
    }

    @Test
    void 回滚预案读不到历史时明写未经集群确认(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);
        // 预案本身是文本，不必非要碰到集群才算成；但它必须承认自己没被验证过。
        var k8s = k8s(Map.of("helm.history", fail("helm 启动失败: ENOENT")));

        String out = run(store, w, flow, "rollback_plan", "rollback.steps", k8s, new NodeService());
        assertTrue(out.contains("未经集群确认"), out);
        assertTrue(out.contains("ENOENT"), out);
    }

    /** 排水/恢复调度：模拟模式不碰集群，真实模式任何一台失败就整步失败。 */
    private static NodeService nodesMocked() {
        return new NodeService() {
            @Override
            public boolean forceMock() {
                return true;
            }
        };
    }

    private static InstallFlow flowWithNodes(Store store, Workflow w, int n) {
        EnvironmentSpec env = new EnvironmentSpec();
        env.id = "env-" + System.nanoTime();
        env.name = "verify-env";
        for (int i = 1; i <= n; i++) {
            NodeSpec node = new NodeSpec();
            node.hostname = "node-" + i;
            node.ip = "10.0.0." + i;
            env.nodes.add(node);
        }
        store.saveEnv(env);
        InstallFlow flow = k8sFlow(store, w);
        flow.envId = env.id;
        return flow;
    }

    @Test
    void 模拟模式下的节点排水标注未触碰集群(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = flowWithNodes(store, w, 2);

        String out = run(store, w, flow, "upgrade_execute", "upgrade.node_drain",
                k8s(Map.of()), nodesMocked());
        assertTrue(out.startsWith("[MOCK] 节点排水完成"), out);
        assertTrue(out.contains("未触碰集群"), out);
        assertTrue(run(store, w, flow, "upgrade_execute", "upgrade.node_uncordon",
                k8s(Map.of()), nodesMocked()).startsWith("[MOCK] 节点恢复调度完成"));
    }

    @Test
    void 没有节点时排水与恢复调度才是跳过(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = k8sFlow(store, w);

        assertEquals("节点排水跳过（无节点）",
                run(store, w, flow, "upgrade_execute", "upgrade.node_drain", k8s(Map.of()), new NodeService()));
    }
}
