package com.cloudops;

import com.cloudops.core.Store;
import com.cloudops.engine.Workflow;
import com.cloudops.services.VersioningService;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** 测试公共构造：临时数据目录里的真实 Store，以及手工造 tar 的小工具。 */
public final class TestSupport {

    private TestSupport() {}

    /**
     * Store 的无参构造读 cloudops.data.dir；测试用独立目录，绝不碰开发库 data/。
     * 但环境变量 CLOUDOPS_DATA_DIR 的优先级高于该属性（Store.java:40-44），
     * 所以拿真实 Store 反查一次落点：不落在临时目录就直接炸，不让测试悄悄写进别人的库。
     */
    public static Store storeIn(Path dir) {
        System.setProperty("cloudops.data.dir", dir.toAbsolutePath().toString());
        Store store = new Store();
        if (!store.dataDir.toAbsolutePath().normalize().startsWith(dir.toAbsolutePath().normalize())) {
            throw new IllegalStateException("测试数据目录没有生效：store.dataDir=" + store.dataDir
                    + " 期望在 " + dir.toAbsolutePath() + " 之下（检查环境变量 CLOUDOPS_DATA_DIR 是否覆盖了 cloudops.data.dir）");
        }
        return store;
    }

    public static Workflow workflow(Store store) {
        return new Workflow(store, new VersioningService());
    }

    /** 顺序敏感的 tar 构造：LinkedHashMap 保证条目次序可预期，失败消息才写得准。 */
    public static byte[] tar(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (TarArchiveOutputStream out = new TarArchiveOutputStream(bos)) {
            out.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX);
            for (Map.Entry<String, byte[]> e : entries.entrySet()) {
                TarArchiveEntry entry = new TarArchiveEntry(e.getKey());
                entry.setSize(e.getValue().length);
                out.putArchiveEntry(entry);
                out.write(e.getValue());
                out.closeArchiveEntry();
            }
        }
        return bos.toByteArray();
    }

    public static byte[] gz(byte[] data) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (GzipCompressorOutputStream out = new GzipCompressorOutputStream(bos)) {
            out.write(data);
        }
        return bos.toByteArray();
    }

    public static Map<String, byte[]> entries() {
        return new LinkedHashMap<>();
    }

    public static byte[] text(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /** 一个结构完整的 chart 压缩包（helm 的惯例：条目都带 <name>/ 前缀）。 */
    public static byte[] chartTgz(String name, String version) throws IOException {
        Map<String, byte[]> m = entries();
        m.put(name + "/Chart.yaml", text(
                "apiVersion: v2\nname: " + name + "\nversion: " + version + "\ndescription: e2e chart\n"));
        m.put(name + "/templates/configmap.yaml",
                text("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: " + name + "\n"));
        return gz(tar(m));
    }

    /** 造一个离线 bundle：chart/ + values/values.yaml + images/，返回 .tar.gz 字节。 */
    public static byte[] bundle(String chartName, String chartVersion) throws IOException {
        Map<String, byte[]> m = entries();
        m.put("chart/" + chartName + "-" + chartVersion + ".tgz", chartTgz(chartName, chartVersion));
        m.put("values/values.yaml", text("replicaCount: 2\nimage:\n  tag: " + chartVersion + "\n"));
        m.put("images/app.tar", new byte[128]);
        m.put("README.md", text("bundle fixture\n"));
        return gz(tar(m));
    }

    /** 把 tar.gz 字节落到临时文件，返回路径（解包器只吃 Path）。 */
    public static Path write(Path dir, String name, byte[] data) throws IOException {
        Files.createDirectories(dir);
        Path file = dir.resolve(name);
        Files.write(file, data);
        return file;
    }
}
