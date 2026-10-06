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

    /** storeIn 造出来的、连接还开着的 Store。 */
    private static final java.util.Deque<Store> opened = new java.util.concurrent.ConcurrentLinkedDeque<>();

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
        opened.addFirst(store);
        return store;
    }

    /** @AfterEach 调用：释放连接，否则 WAL 文件被锁住，@TempDir 在 Windows 上删不掉。 */
    public static void closeOpened() {
        Store s;
        while ((s = opened.pollFirst()) != null) s.close();
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

    /** 手工写 ustar 头：条目名一字不改地落进归档。
     *
     * commons-compress 的 TarArchiveOutputStream 会把条目名开头的 "/" 剥掉
     * （实测写入 "/etc/passwd" 回读成 "etc/passwd"），所以「绝对路径条目必须被拒」这条
     * 断言只能靠真 tar 头造出来。
     */
    public static byte[] rawTar(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        for (Map.Entry<String, byte[]> e : entries.entrySet()) {
            byte[] block = new byte[512];
            byte[] name = e.getKey().getBytes(StandardCharsets.UTF_8);
            if (name.length > 99) {
                throw new IllegalArgumentException("夹具不造长名条目（需要 UStar prefix 字段）：" + e.getKey());
            }
            System.arraycopy(name, 0, block, 0, name.length);
            ascii(block, 100, "0000644\0");                          // mode
            ascii(block, 108, "0000000\0");                          // uid
            ascii(block, 116, "0000000\0");                          // gid
            ascii(block, 124, octal(e.getValue().length, 11) + "\0"); // size
            ascii(block, 136, octal(0, 11) + "\0");                  // mtime
            ascii(block, 156, "0");                                  // typeflag：普通文件
            ascii(block, 257, "ustar\0");                            // magic
            ascii(block, 263, "00");                                 // version
            java.util.Arrays.fill(block, 148, 156, (byte) ' ');       // 校验和字段先按空格计入
            long sum = 0;
            for (byte b : block) sum += b & 0xff;
            ascii(block, 148, octal(sum, 6) + "\0");
            bos.write(block);
            byte[] data = e.getValue();
            bos.write(data);
            bos.write(new byte[(512 - data.length % 512) % 512]);
        }
        bos.write(new byte[1024]);                                   // 两个空块结束归档
        return bos.toByteArray();
    }

    private static void ascii(byte[] block, int offset, String value) {
        System.arraycopy(value.getBytes(StandardCharsets.US_ASCII), 0, block, offset, value.length());
    }

    private static String octal(long value, int width) {
        return String.format("%" + width + "o", value);
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

    /** 造一个合规离线 bundle：chart/<name>-<version>.tgz + 顶层 values.yaml + images/*.tar。 */
    public static byte[] bundle(String chartName, String chartVersion) throws IOException {
        Map<String, byte[]> m = entries();
        m.put("chart/" + chartName + "-" + chartVersion + ".tgz", chartTgz(chartName, chartVersion));
        m.put("values.yaml", text("replicaCount: 2\nimage:\n  tag: " + chartVersion + "\n"));
        m.put("images/app.tar", new byte[2048]);
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
