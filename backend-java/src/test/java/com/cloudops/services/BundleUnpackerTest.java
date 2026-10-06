package com.cloudops.services;

import com.cloudops.TestSupport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class BundleUnpackerTest {

    private final BundleUnpacker unpacker = new BundleUnpacker();

    /** 合规包：chart tgz + values.yaml + 两个镜像 tar + 一堆该被忽略的东西。 */
    private byte[] validBundle() throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("README.txt", TestSupport.text("离线交付包\n"));
        m.put("chart/shipdesk-1.2.3.tgz", TestSupport.chartTgz("shipdesk", "1.2.3"));
        m.put("values.yaml", TestSupport.text("replicaCount: 2\nimage: { tag: 1.2.3 }\n"));
        m.put("images/app.tar", new byte[3000]);
        m.put("images/sidecar.tar", new byte[1000]);
        m.put("docs/runbook.md", TestSupport.text("# 现场手册\n"));
        return TestSupport.gz(TestSupport.tar(m));
    }

    @Test
    void 合规包解出chart与values并统计镜像(@TempDir Path tmp) throws IOException {
        Path bundle = tmp.resolve("bundle.tar.gz");
        Files.write(bundle, validBundle());
        Path out = tmp.resolve("flows/f1/bundle");

        BundleUnpacker.Result r = unpacker.unpack(bundle, out);

        assertEquals("shipdesk", r.chartName());
        assertEquals("1.2.3", r.chartVersion());
        assertTrue(Files.isRegularFile(r.chartFile()), "chart 应落在目标目录里");
        assertEquals(out.toAbsolutePath().normalize(), r.chartFile().getParent());
        assertTrue(r.chartFile().getFileName().toString().endsWith(".tgz"));
        assertNotNull(r.valuesFile());
        assertEquals("values.yaml", r.valuesFile().getFileName().toString());
        assertEquals(List.of("images/app.tar", "images/sidecar.tar"), r.imageNames());
        assertEquals(4000, r.imageBytes());
        assertTrue(r.topLevelEntries().containsAll(
                List.of("README.txt", "chart", "values.yaml", "images", "docs")));
    }

    @Test
    void 裸tar与gzip包一样接受(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-0.1.0.tgz", TestSupport.chartTgz("app", "0.1.0"));
        Path bundle = tmp.resolve("bundle.tar");
        Files.write(bundle, TestSupport.tar(m));

        BundleUnpacker.Result r = unpacker.unpack(bundle, tmp.resolve("out"));
        assertEquals("0.1.0", r.chartVersion());
        assertNull(r.valuesFile(), "包里没有 values.yaml 就是 null，不许造假路径");
    }

    @Test
    void 顶层单个tgz也算chart(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("app-2.0.0.tgz", TestSupport.chartTgz("app", "2.0.0"));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        assertEquals("2.0.0", unpacker.unpack(bundle, tmp.resolve("out")).chartVersion());
    }

    @Test
    void 重复执行会先清空目标目录(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.chartTgz("app", "1.0.0"));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));
        Path out = tmp.resolve("out");
        Files.createDirectories(out);
        Files.write(out.resolve("stale.txt"), TestSupport.text("上一版包的残留"));

        unpacker.unpack(bundle, out);

        assertFalse(Files.exists(out.resolve("stale.txt")), "旧文件必须被清掉，否则两版包混在一起");
    }

    @Test
    void 没有chart时失败并打印顶层条目与目录约定(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("images/app.tar", new byte[10]);
        m.put("values.yaml", TestSupport.text("a: 1\n"));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("没有 chart 压缩包"), ex.getMessage());
        assertTrue(ex.getMessage().contains("images"), "要列出扫到的顶层条目：" + ex.getMessage());
        assertTrue(ex.getMessage().contains("chart/"), "要重申目录约定：" + ex.getMessage());
    }

    @Test
    void 多个chart时列出候选而不是取第一个(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/a-1.0.0.tgz", TestSupport.chartTgz("a", "1.0.0"));
        m.put("chart/b-2.0.0.tgz", TestSupport.chartTgz("b", "2.0.0"));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("2 个 chart"), ex.getMessage());
        assertTrue(ex.getMessage().contains("chart/a-1.0.0.tgz"), ex.getMessage());
        assertTrue(ex.getMessage().contains("chart/b-2.0.0.tgz"), ex.getMessage());
    }

    @Test
    void 不是tar就明说(@TempDir Path tmp) throws IOException {
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.text("这不是归档文件，这是一段文本\n"));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("tar"), ex.getMessage());
    }

    @Test
    void zipSlip条目被拒绝(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.chartTgz("app", "1.0.0"));
        m.put("../escaped.txt", TestSupport.text("越界写入"));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("越界"), ex.getMessage());
    }

    @Test
    void 绝对路径条目被拒绝(@TempDir Path tmp) throws IOException {
        // 必须用 rawTar：commons-compress 的写侧会把开头的 "/" 剥掉，那样的包根本不含绝对路径条目。
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.chartTgz("app", "1.0.0"));
        m.put("/etc/passwd", TestSupport.text("x"));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.rawTar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("绝对路径"), ex.getMessage());
    }

    @Test
    void chart包里缺Chart_yaml就失败(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> inner = TestSupport.entries();
        inner.put("app/templates/configmap.yaml", TestSupport.text("kind: ConfigMap\n"));
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.gz(TestSupport.tar(inner)));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("Chart.yaml"), ex.getMessage());
    }

    @Test
    void Chart_yaml缺version就失败(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> inner = TestSupport.entries();
        inner.put("app/Chart.yaml", TestSupport.text("apiVersion: v2\nname: app\n"));
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.gz(TestSupport.tar(inner)));
        Path bundle = tmp.resolve("b.tar.gz");
        Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("version"), ex.getMessage());
    }

    @Test
    void 条目数超上限就拒绝解包(@TempDir Path tmp) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (var out = new org.apache.commons.compress.archivers.tar.TarArchiveOutputStream(buf)) {
            for (int i = 0; i <= BundleUnpacker.MAX_ENTRIES; i++) {
                var e = new org.apache.commons.compress.archivers.tar.TarArchiveEntry("filler/" + i + ".txt");
                e.setSize(0);
                out.putArchiveEntry(e);
                out.closeArchiveEntry();
            }
        }
        Path bundle = tmp.resolve("b.tar");
        Files.write(bundle, buf.toByteArray());

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains(String.valueOf(BundleUnpacker.MAX_ENTRIES)), ex.getMessage());
    }
}
