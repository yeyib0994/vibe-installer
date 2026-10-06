package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.FlowStage;
import com.cloudops.model.InstallFlow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorkflowStageCatalogTest {

    private static final List<String> INSTALL_KEYS = List.of("env_register", "env_precheck", "package_upload",
            "package_distribute", "pre_install_backup", "install_execute", "post_verify");

    private static List<String> keysOfWorkflow(Map<String, Object> catalog) {
        @SuppressWarnings("unchecked")
        List<FlowStage> stages = (List<FlowStage>) catalog.get("stages");
        return stages.stream().map(s -> s.key).toList();
    }

    @Test
    void install目录仍是七个阶段且顺序不变(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        InstallFlow flow = TestSupport.workflow(store).createFlow("安装", null, "install", "admin");
        assertEquals(INSTALL_KEYS, flow.stages.stream().map(s -> s.key).toList());
    }

    @Test
    void upgrade模式已退役_目录构造不再有第五条upgrade阶段表(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        // catalog("upgrade") 落到 switch 的 default：拿到的是 install 的七个阶段，
        // 而不是 upgrade 那五条（今天第 3 个 key 是 pre_upgrade_backup）。
        assertEquals(INSTALL_KEYS, keysOfWorkflow(w.catalog("upgrade")));
        assertEquals(INSTALL_KEYS, w.createFlow("旧模式流程", null, "upgrade", "admin")
                .stages.stream().map(s -> s.key).toList());
        // upgrade_k8s 仍是它自己的一张表，没被这次删除波及（七阶段见下一个用例）。
        assertEquals(7, keysOfWorkflow(w.catalog("upgrade_k8s")).size());
    }

    @Test
    void install的节点矩阵校验仍生效(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        InstallFlow flow = w.createFlow("安装", null, "install", "admin");
        List<String> errors = w.validateStageInputs(flow, "env_register", Map.of(
                "physical_nodes", List.of(), "virtual_nodes", List.of()));
        assertTrue(errors.stream().anyMatch(e -> e.contains("至少需要登记 1 台节点")), errors.toString());
    }

    @Test
    void k8s升级目录是七阶段且第2格是上传软件包(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        List<FlowStage> stages = w.createFlow("K8s", null, "upgrade_k8s", "admin").stages;
        assertEquals(List.of("env_register", "package_upload", "env_precheck", "pre_upgrade_backup",
                        "upgrade_execute", "post_verify", "rollback_plan"),
                stages.stream().map(s -> s.key).toList());
        assertEquals(List.of(0, 1, 2, 3, 4, 5, 6), stages.stream().map(s -> s.index).toList());
        assertEquals("上传软件包", stages.get(1).title);
        assertTrue(stages.get(1).required, "上传软件包必经：解不出 chart 就没东西可升级");
        // 只有末阶段可跳过，与 refreshLocks / StageRail 的线性推进一致
        assertEquals(List.of(true, true, true, true, true, true, false),
                stages.stream().map(s -> s.required).toList());
        assertEquals(List.of("package.receive", "package.chunk", "k8s.bundle_unpack"),
                stages.get(1).steps.stream().map(st -> st.action).toList());
    }

    @Test
    void k8s环境登记不再有三个假参数(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        FlowStage reg = w.createFlow("K8s", null, "upgrade_k8s", "admin").stages.get(0);
        List<String> keys = reg.formFields.stream().map(f -> (String) f.get("key")).toList();
        assertFalse(keys.contains("cluster_id"), "集群登记表已退役，这个必填参数指的是不存在的东西");
        assertFalse(keys.contains("chart"), "chart 来源改成离线包，手填与包冲突");
        assertFalse(keys.contains("chart_repo"), "离线包路线没有仓库拉取");
        assertEquals(List.of("kubeconfig", "namespace", "release_name", "target_chart_version"), keys);
    }

    @Test
    void 执行升级的chart是只读且不由用户必填拦下(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        FlowStage exec = w.stageByKey(flow, "upgrade_execute");
        Map<String, Object> chart = exec.formFields.stream()
                .filter(f -> "chart".equals(f.get("key"))).findFirst().orElseThrow();
        assertEquals(Boolean.TRUE, chart.get("readonly"), "chart 由解包阶段注入，界面只展示不给改");
        assertEquals(Boolean.FALSE, chart.get("required"), "必填语义交给专门的错误，否则第一步就卡死");

        // 没跑过上传阶段：chart 为空，必须给出可操作的错误，不是「必填项」
        List<String> errors = w.validateStageInputs(flow, "upgrade_execute", new HashMap<>());
        assertTrue(errors.stream().anyMatch(e -> e.contains("尚未完成「上传软件包」阶段")), errors.toString());

        // 注入之后：同一份表单不再报错
        Map<String, Object> inputs = new HashMap<>();
        inputs.put("chart", "/data/flows/f1/bundle/shipdesk-1.2.3.tgz");
        assertTrue(w.validateStageInputs(flow, "upgrade_execute", inputs).isEmpty(),
                w.validateStageInputs(flow, "upgrade_execute", inputs).toString());
    }

    @Test
    void 上传软件包阶段仍按package_id拦空(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        List<String> errors = w.validateStageInputs(flow, "package_upload", new HashMap<>());
        assertTrue(errors.stream().anyMatch(e -> e.contains("尚未上传任何安装包")), errors.toString());
    }
}
