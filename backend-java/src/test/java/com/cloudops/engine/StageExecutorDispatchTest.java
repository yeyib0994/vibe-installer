package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.FlowStage;
import com.cloudops.model.FlowStep;
import com.cloudops.model.InstallFlow;
import com.cloudops.services.BackupService;
import com.cloudops.services.BundleUnpacker;
import com.cloudops.services.K8sOpsService;
import com.cloudops.services.NodeService;
import com.cloudops.services.VersioningService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 直接驱动动作分派：execute(...) 放宽成包内可见，比经 submit() 起线程再等终态可靠。 */
class StageExecutorDispatchTest {

    static StageExecutor executor(Store store, Workflow w) {
        return new StageExecutor(store, new LogBus(), w, new NodeService(), new BackupService(),
                new VersioningService(), new K8sOpsService(), new BundleUnpacker());
    }

    private static FlowStep action(String action) {
        FlowStep s = new FlowStep();
        s.id = "s1";
        s.index = 0;
        s.title = action;
        s.detail = "";
        s.action = action;
        return s;
    }

    @Test
    void 未注册动作必须失败而不是跳过即成功(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = w.createFlow("旧记录", null, "install", "admin");
        FlowStage stage = w.stageByKey(flow, "env_register");

        // 被删模式的旧流程记录里，每一步用的都是这种 action。
        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, stage, action("upgrade.drain")));
        assertTrue(ex.getMessage().contains("已从后端移除"), ex.getMessage());
        assertTrue(ex.getMessage().contains("upgrade.drain"), ex.getMessage());
    }

    @Test
    void 已退役的升级就绪度检查同样不能再跑(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = w.createFlow("旧记录", null, "install", "admin");
        FlowStage stage = w.stageByKey(flow, "env_precheck");

        assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, stage, action("precheck.upgrade_ready")));
    }
}
