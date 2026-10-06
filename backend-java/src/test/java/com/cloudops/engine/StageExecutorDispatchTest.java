package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.FlowStage;
import com.cloudops.model.FlowStep;
import com.cloudops.model.InstallFlow;
import com.cloudops.model.PackageEntry;
import com.cloudops.services.BackupService;
import com.cloudops.services.BundleUnpacker;
import com.cloudops.services.K8sOpsService;
import com.cloudops.services.NodeService;
import com.cloudops.services.VersioningService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 直接驱动动作分派：execute(...) 放宽成包内可见，比经 submit() 起线程再等终态可靠。 */
class StageExecutorDispatchTest {

    /** 本类的用例真的写库（savePackage/saveFlow），连接不关 @TempDir 就删不掉。 */
    @AfterEach
    void closeStores() {
        TestSupport.closeOpened();
    }

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

    /** 造一条 K8s 流程，把 bundle 写成真实包文件并挂进 package_upload 的 inputs。 */
    private InstallFlow flowWithBundle(Store store, Workflow w, Path tmp, String targetVersion,
                                       byte[] bundleBytes) throws Exception {
        Path file = tmp.resolve("package.tar.gz");
        Files.write(file, bundleBytes);
        PackageEntry p = new PackageEntry();
        p.id = "pkg-e2e";
        p.name = "package.tar.gz";
        p.version = "1.2.3";
        p.path = file.toString();
        p.uploadComplete = true;
        p.checksum = "ab".repeat(32);
        p.sizeBytes = bundleBytes.length;
        p.uploadedBytes = bundleBytes.length;
        store.savePackage(p);

        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        FlowStage reg = w.stageByKey(flow, "env_register");
        reg.inputs.put("namespace", "cloudops");
        reg.inputs.put("release_name", "shipdesk-e2e");
        reg.inputs.put("target_chart_version", targetVersion);
        FlowStage up = w.stageByKey(flow, "package_upload");
        up.inputs.put("_package_id", p.id);
        store.saveFlow(flow);
        return flow;
    }

    @Test
    void 解包成功把chart与values注入执行升级(@TempDir Path tmp) throws Exception {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = flowWithBundle(store, w, tmp, "1.2.3", TestSupport.bundle("shipdesk", "1.2.3"));
        FlowStage up = w.stageByKey(flow, "package_upload");

        String out = executor(store, w).execute(flow, up, action("k8s.bundle_unpack"));

        assertTrue(out.contains("shipdesk"), out);
        assertTrue(out.contains("values.yaml"), out);
        assertTrue(out.contains("不导入镜像"), "必须明写镜像没有被导入：" + out);

        FlowStage exec = w.stageByKey(flow, "upgrade_execute");
        String chart = String.valueOf(exec.inputs.get("chart"));
        assertTrue(chart.endsWith("shipdesk-1.2.3.tgz"), chart);
        assertTrue(Files.isRegularFile(Path.of(chart)), "注入的必须是真实路径");
        assertEquals("1.2.3", exec.inputs.get("_chart_version"));
        assertNotNull(exec.inputs.get("_values_path"));

        // 真持久化：重新从库里读一条，注入值必须还在（阶段之间跨请求传递的唯一凭据）
        InstallFlow reloaded = store.getFlow(flow.id);
        assertEquals(chart, w.stageByKey(reloaded, "upgrade_execute").inputs.get("chart"));
    }

    @Test
    void 包内版本与登记目标不一致就失败(@TempDir Path tmp) throws Exception {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = flowWithBundle(store, w, tmp, "9.9.9", TestSupport.bundle("shipdesk", "1.2.3"));
        FlowStage up = w.stageByKey(flow, "package_upload");

        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, up, action("k8s.bundle_unpack")));
        assertTrue(ex.getMessage().contains("9.9.9"), ex.getMessage());
        assertTrue(ex.getMessage().contains("1.2.3"), ex.getMessage());
    }

    @Test
    void 没传包时不猜而是直接失败(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        FlowStage up = w.stageByKey(flow, "package_upload");

        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, up, action("k8s.bundle_unpack")));
        assertTrue(ex.getMessage().contains("尚未上传安装包"), ex.getMessage());
    }

    @Test
    void 包文件不在磁盘上时打印期望路径(@TempDir Path tmp) throws Exception {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = flowWithBundle(store, w, tmp, "1.2.3", TestSupport.bundle("shipdesk", "1.2.3"));
        Files.delete(Path.of(store.getPackage("pkg-e2e").path));
        FlowStage up = w.stageByKey(flow, "package_upload");

        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, up, action("k8s.bundle_unpack")));
        assertTrue(ex.getMessage().contains("package.tar.gz"), ex.getMessage());
    }

    @Test
    void 不合规的包让阶段失败并把契约打在脸上(@TempDir Path tmp) throws Exception {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        var m = TestSupport.entries();
        m.put("images/app.tar", new byte[16]);
        InstallFlow flow = flowWithBundle(store, w, tmp, "1.2.3", TestSupport.gz(TestSupport.tar(m)));
        FlowStage up = w.stageByKey(flow, "package_upload");

        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, up, action("k8s.bundle_unpack")));
        assertTrue(ex.getMessage().contains("chart/"), ex.getMessage());
    }

    @Test
    void 兼容检查真的读取登记目标与包内版本(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        w.stageByKey(flow, "env_register").inputs.put("target_chart_version", "1.2.3");
        w.stageByKey(flow, "upgrade_execute").inputs.put("_chart_version", "1.2.3");

        String out = executor(store, w).execute(flow, w.stageByKey(flow, "env_precheck"), action("precheck.compat"));
        assertTrue(out.contains("登记目标 Chart 版本: 1.2.3"), out);
        assertTrue(out.contains("离线包内 Chart 版本: 1.2.3"), out);
        assertTrue(out.contains("与登记目标一致"), out);
    }

    @Test
    void 没解包时兼容检查如实说没有包内版本(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        w.stageByKey(flow, "env_register").inputs.put("target_chart_version", "1.2.3");

        String out = executor(store, w).execute(flow, w.stageByKey(flow, "env_precheck"), action("precheck.compat"));
        assertTrue(out.contains("未解包"), out);
    }

    @Test
    void 执行升级没有chart时说明缺的是哪一阶段(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        FlowStage exec = w.stageByKey(flow, "upgrade_execute");

        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, exec, action("upgrade.helm_upgrade")));
        assertTrue(ex.getMessage().contains("上传软件包"), ex.getMessage());
    }
}
