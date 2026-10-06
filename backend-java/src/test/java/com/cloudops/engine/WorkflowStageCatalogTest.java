package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.InstallFlow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class WorkflowStageCatalogTest {

    @Test
    void install目录仍是七个阶段且顺序不变(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        InstallFlow flow = TestSupport.workflow(store).createFlow("安装", null, "install", "admin");
        assertEquals(List.of("env_register", "env_precheck", "package_upload", "package_distribute",
                        "pre_install_backup", "install_execute", "post_verify"),
                flow.stages.stream().map(s -> s.key).toList());
    }
}
