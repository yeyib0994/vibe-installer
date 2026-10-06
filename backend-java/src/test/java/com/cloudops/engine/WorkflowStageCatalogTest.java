package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.FlowStage;
import com.cloudops.model.InstallFlow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
        // upgrade_k8s 仍是它自己的一张表，没被这次删除波及（当前六个阶段）。
        assertEquals(List.of("env_register", "env_precheck", "pre_upgrade_backup", "upgrade_execute",
                        "post_verify", "rollback_plan"),
                keysOfWorkflow(w.catalog("upgrade_k8s")));
    }

    @Test
    void install的节点矩阵校验仍生效(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        InstallFlow flow = w.createFlow("安装", null, "install", "admin");
        List<String> errors = w.validateStageInputs(flow, "env_register", Map.of(
                "physical_nodes", List.of(), "virtual_nodes", List.of()));
        assertTrue(errors.stream().anyMatch(e -> e.contains("至少需要登记 1 台节点")), errors.toString());
    }
}
