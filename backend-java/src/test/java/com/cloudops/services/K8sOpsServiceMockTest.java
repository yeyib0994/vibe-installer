package com.cloudops.services;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 显式模拟通路：演示机/验收栈靠它继续走完全流程，代价是结果必须自带 mock 标记。 */
class K8sOpsServiceMockTest {

    /** mockMode 翻成 true 的桩：call 该直接回合成结果，一个子进程都不起。 */
    private static K8sOpsService mocked() {
        return new K8sOpsService() {
            @Override
            boolean mockMode() {
                return true;
            }
        };
    }

    @Test
    void 模拟开关与节点驱动是同一个变量() {
        // 演示栈只需要设一个 CLOUDOPS_FORCE_MOCK；两处不一致就会出现「徽章说模拟、集群是真打」
        assertEquals(NodeService.forceMockEnv(), new K8sOpsService().mockMode());
    }

    @Test
    void 模拟通路不启动node直接回合成成功() {
        Map<String, Object> r = mocked().call("helm.upgrade", Map.of("namespace", "default"));
        assertEquals(true, r.get("ok"));
        assertEquals(true, r.get("mock"), "合成成功必须带 mock 标记，否则与真实成功无法区分");
        assertNotNull(r.get("data"));
    }

    @Test
    void 每个动作的合成结果都备齐执行器要读的键() {
        // 少一个键，StageExecutor 就打出一个 null，日志里看着像「0 个 Pod」这种莫名结论。
        Map<String, List<String>> consumed = Map.ofEntries(
                Map.entry("helm.list", List.of("releases")),
                Map.entry("helm.upgrade", List.of("stdout")),
                Map.entry("helm.rollback", List.of("stdout")),
                Map.entry("helm.history", List.of("revisions")),
                Map.entry("helm.get_values", List.of("values")),
                Map.entry("helm.get_manifest", List.of("manifest")),
                Map.entry("pod.verify_ready", List.of("total", "all_ready")),
                Map.entry("pod.get_images", List.of("images")),
                Map.entry("pod.rollout_status", List.of("results")),
                Map.entry("backup.export_values", List.of("file", "values")),
                Map.entry("backup.export_manifest", List.of("file", "bytes")),
                Map.entry("backup.list_pvc", List.of("pvcs")),
                Map.entry("backup.volume_snapshot", List.of("snapshot_name", "pvc")));

        for (Map.Entry<String, List<String>> e : consumed.entrySet()) {
            Map<String, Object> r = K8sOpsService.mockResult(e.getKey(),
                    Map.of("release_name", "app", "backup_dir", "/tmp/bk", "pvc_name", "data"));
            assertEquals(true, r.get("ok"), e.getKey());
            assertEquals(true, r.get("mock"), e.getKey());
            Map<?, ?> data = (Map<?, ?>) r.get("data");
            for (String key : e.getValue()) {
                assertNotNull(data.get(key), e.getKey() + " 的合成结果缺少键 " + key);
            }
        }
    }

    @Test
    void 合成备份路径说清了自己没有落盘() {
        Map<String, Object> r = K8sOpsService.mockResult("backup.export_values",
                Map.of("release_name", "app", "backup_dir", "/tmp/bk"));
        String file = String.valueOf(((Map<?, ?>) r.get("data")).get("file"));
        assertTrue(file.contains("未落盘"), file);
        assertTrue(file.contains("app-values.json"), file);
    }

    @Test
    void release名里的路径字符在合成路径里同样被收口() {
        Map<String, Object> r = K8sOpsService.mockResult("backup.export_manifest",
                Map.of("release_name", "../../etc/passwd", "backup_dir", "/tmp/bk"));
        String file = String.valueOf(((Map<?, ?>) r.get("data")).get("file"));
        String leaf = file.substring(file.lastIndexOf('/') + 1);
        // 与真实 sidecar 同一条正则（k8s-ops/src/backup.ts:17）：分隔符全被换成 _，
        // 合成路径自然也不可能被 release 名带着写到 backup_dir 之外。
        assertTrue(!leaf.contains("/") && !leaf.contains("\\"), file);
        assertEquals(".._.._etc_passwd-manifest.yaml（模拟，未落盘）", leaf);
    }
}
