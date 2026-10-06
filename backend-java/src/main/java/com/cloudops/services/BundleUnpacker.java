package com.cloudops.services;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream;
import org.springframework.stereotype.Component;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PushbackInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/** 离线 bundle（tar / tar.gz）解包。
 *
 * 目录约定见设计 spec §5：chart/<name>-<version>.tgz 必需且唯一，values.yaml 可选，
 * images/*.tar 只登记不导入。两趟读：先扫描判定合规，再解出需要的两个文件。
 * 任何不合规都抛 BundleException，消息里带上实际扫到的东西 —— 猜一个 chart 或静默跳过
 * 都会把错误的软件包送进客户环境，那是最贵的失败方式。
 */
@Component
public class BundleUnpacker {

    /** 上限写死：解包发生在交付现场，条目爆炸的包本身就说明上传错了东西。 */
    static final int MAX_ENTRIES = 20000;
    static final long MAX_TOTAL_BYTES = 4L * 1024 * 1024 * 1024;

    public static class BundleException extends RuntimeException {
        public BundleException(String msg) { super(msg); }
    }

    public record Result(Path chartFile, String chartName, String chartVersion,
                         Path valuesFile, List<String> imageNames, long imageBytes,
                         List<String> topLevelEntries) {}

    private record Scan(List<String> chartEntries, List<String> imageNames, long imageBytes,
                        boolean hasValues, List<String> topLevel) {}

    public Result unpack(Path bundle, Path targetDir) {
        if (!Files.isRegularFile(bundle)) {
            throw new BundleException("离线包文件不存在或不是普通文件：" + bundle);
        }
        Scan scan = scanBundle(bundle);
        if (scan.chartEntries().isEmpty()) {
            throw new BundleException("离线包里没有 chart 压缩包。目录约定：chart/<name>-<version>.tgz"
                    + "（必需，有且仅有一个）、values.yaml（可选）、images/*.tar（可选，只登记不导入）。"
                    + "本包顶层条目：" + describe(scan.topLevel()));
        }
        if (scan.chartEntries().size() > 1) {
            throw new BundleException("离线包里有 " + scan.chartEntries().size()
                    + " 个 chart 压缩包，无法判定用哪个：" + String.join("、", scan.chartEntries()));
        }

        Path base = targetDir.toAbsolutePath().normalize();
        cleanDir(base);
        String chartEntry = scan.chartEntries().get(0);
        extract(bundle, base, chartEntry, scan.hasValues());

        Path chartFile = resolveInside(base, leaf(chartEntry));
        if (!Files.isRegularFile(chartFile)) {
            throw new BundleException("chart 解包后不在目标目录里，期望：" + chartFile);
        }
        String[] meta = readChartMeta(chartFile, chartEntry);
        Path valuesFile = scan.hasValues() ? resolveInside(base, "values.yaml") : null;
        if (scan.hasValues() && !Files.isRegularFile(valuesFile)) {
            throw new BundleException("扫描时见到 values.yaml，但解包后文件不在：" + valuesFile);
        }
        return new Result(chartFile, meta[0], meta[1], valuesFile,
                scan.imageNames(), scan.imageBytes(), scan.topLevel());
    }

    // ============ 第一趟：扫描 ============
    private Scan scanBundle(Path bundle) {
        List<String> charts = new ArrayList<>();
        List<String> images = new ArrayList<>();
        List<String> topLevel = new ArrayList<>();
        long imageBytes = 0;
        long totalBytes = 0;
        int seen = 0;
        boolean hasValues = false;

        try (TarArchiveInputStream in = new TarArchiveInputStream(open(bundle))) {
            TarArchiveEntry e;
            while ((e = in.getNextTarEntry()) != null) {
                if (++seen > MAX_ENTRIES) {
                    throw new BundleException("离线包条目数超过上限 " + MAX_ENTRIES + "，拒绝解包");
                }
                String name = e.getName();
                rejectTraversal(name);
                String top = name.contains("/") ? name.substring(0, name.indexOf('/')) : name;
                if (!topLevel.contains(top)) topLevel.add(top);
                if (e.isDirectory()) continue;

                long size = Math.max(e.getSize(), 0);
                totalBytes += size;
                if (totalBytes > MAX_TOTAL_BYTES) {
                    throw new BundleException("离线包解压后总字节超过上限 4 GiB，拒绝解包");
                }
                if (isChartTgz(name)) charts.add(name);
                else if (name.toLowerCase(Locale.ROOT).endsWith(".tar")) {
                    images.add(name);
                    imageBytes += size;
                } else if ("values.yaml".equals(name)) hasValues = true;
            }
        } catch (BundleException ex) {
            // 契约判定失败（条目上限 / 越界 / 超大）原样抛出，不许被下面的「不是 tar」盖掉
            throw ex;
        } catch (IOException | IllegalArgumentException ex) {
            throw new BundleException("不是可读取的 tar / tar.gz 离线包：" + messageOf(ex));
        }
        return new Scan(charts, images, imageBytes, hasValues, topLevel);
    }

    // ============ 第二趟：只解需要的两个文件 ============
    private void extract(Path bundle, Path base, String chartEntry, boolean wantValues) {
        try (TarArchiveInputStream in = new TarArchiveInputStream(open(bundle))) {
            TarArchiveEntry e;
            while ((e = in.getNextTarEntry()) != null) {
                if (e.isDirectory()) continue;
                String name = e.getName();
                if (!(name.equals(chartEntry) || (wantValues && "values.yaml".equals(name)))) continue;
                Files.copy(in, resolveInside(base, leaf(name)), StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException ex) {
            throw new BundleException("解包失败：" + messageOf(ex));
        }
    }

    /** chart 包自身是 tar.gz：读里面那份 Chart.yaml 拿 name/version，二者共同确认「包到底装的是什么」。 */
    private static String[] readChartMeta(Path chartFile, String chartEntry) {
        try (TarArchiveInputStream in = new TarArchiveInputStream(open(chartFile))) {
            TarArchiveEntry e;
            while ((e = in.getNextTarEntry()) != null) {
                if (e.isDirectory() || !"Chart.yaml".equals(leaf(e.getName()))) continue;
                String yaml = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                String name = yamlValue(yaml, "name");
                String version = yamlValue(yaml, "version");
                if (version.isEmpty()) {
                    throw new BundleException("chart 包 " + chartEntry
                            + " 里的 Chart.yaml 没有 version 字段，包本身不完整");
                }
                return new String[]{name, version};
            }
        } catch (IOException ex) {
            throw new BundleException("读取 chart 包 " + chartEntry + " 失败：" + messageOf(ex));
        }
        throw new BundleException("chart 包 " + chartEntry + " 里没有 Chart.yaml，无法确认 chart 名称与版本");
    }

    // ============ 工具 ============
    /** gzip 与裸 tar 都接受：看头两个字节，不看文件名（上传时文件名常被改）。 */
    private static InputStream open(Path file) throws IOException {
        PushbackInputStream pin = new PushbackInputStream(
                new BufferedInputStream(Files.newInputStream(file), 1 << 16), 2);
        byte[] head = new byte[2];
        int read = pin.read(head);
        if (read > 0) pin.unread(head, 0, read);
        boolean gzip = read == 2 && (head[0] & 0xff) == 0x1f && (head[1] & 0xff) == 0x8b;
        return gzip ? new GzipCompressorInputStream(pin, true) : pin;
    }

    private static boolean isChartTgz(String name) {
        String leaf = leaf(name).toLowerCase(Locale.ROOT);
        return leaf.endsWith(".tgz") || leaf.endsWith(".tar.gz");
    }

    private static String leaf(String name) {
        int i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        return i < 0 ? name : name.substring(i + 1);
    }

    /** zip-slip 的源头在条目名里：绝对路径与 .. 段一律拒，不接受「清洗后继续」。 */
    private static void rejectTraversal(String name) {
        if (name.startsWith("/") || name.startsWith("\\") || name.contains(":\\")) {
            throw new BundleException("离线包含绝对路径条目，拒绝解包：" + name);
        }
        for (String seg : name.split("/|\\\\")) {
            if (seg.equals("..")) throw new BundleException("离线包含越界路径条目（..），拒绝解包：" + name);
        }
    }

    /** 解出来的名字必须还在目标目录内：条目名合法不代表拼出来的路径合法（比如大小写盘符）。 */
    private static Path resolveInside(Path base, String leafName) {
        Path dest = base.resolve(leafName).normalize();
        if (!dest.startsWith(base)) {
            throw new BundleException("解包目标越界：" + leafName + " → " + dest);
        }
        return dest;
    }

    /** 幂等：先清空再解，否则换包重跑本阶段会把上一版包的文件混进本次结果。 */
    private static void cleanDir(Path dir) {
        if (Files.exists(dir)) {
            try (var walk = Files.walk(dir)) {
                for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                    try {
                        Files.deleteIfExists(p);
                    } catch (IOException ex) {
                        throw new BundleException("清空上一版解包目录失败：" + messageOf(ex));
                    }
                }
            } catch (IOException ex) {
                throw new BundleException("清空上一版解包目录失败：" + messageOf(ex));
            }
        }
        try {
            Files.createDirectories(dir);
        } catch (IOException ex) {
            throw new BundleException("无法创建解包目录 " + dir + "：" + messageOf(ex));
        }
    }

    private static String yamlValue(String yaml, String key) {
        for (String raw : yaml.split("\n")) {
            String line = raw.strip();
            if (line.startsWith(key + ":")) {
                String v = line.substring(key.length() + 1).strip();
                if (v.length() >= 2 && (v.charAt(0) == '"' || v.charAt(0) == '\'')
                        && v.charAt(v.length() - 1) == v.charAt(0)) {
                    v = v.substring(1, v.length() - 1);
                }
                return v;
            }
        }
        return "";
    }

    private static String describe(List<String> topLevel) {
        return topLevel.isEmpty() ? "（空包）" : String.join("、", topLevel);
    }

    private static String messageOf(Throwable ex) {
        return ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
    }
}
