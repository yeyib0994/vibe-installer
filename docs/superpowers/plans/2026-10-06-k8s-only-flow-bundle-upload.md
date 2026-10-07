# K8s-only 流程与离线包驱动升级 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 退役「原地升级」（`upgrade`）模式，把 `upgrade_k8s` 扩成七阶段（新增必经的「上传软件包」阶段并用 Java 真解包离线 bundle），让升级内容来自上传的包而不是手填 chart。

**Architecture:** 后端 `Workflow` 是唯一阶段目录来源；新执行动作 `k8s.bundle_unpack` 用 `commons-compress` 扫描固定目录约定、解出 chart tgz 与 `values.yaml`，并把结果注入「执行升级」阶段的 `inputs`（chart 作为只读表单字段回显）。上传通路按阶段 key `package_upload` 认，不按 mode 认，因此 K8s 侧加阶段即自动接线，前端上传区零改动。未注册动作的兜底从「跳过并算成功」改成硬失败，这是被删模式旧记录的唯一安全网。

**Tech Stack:** Java 21 + Spring Boot 4.1.1 + Maven（离线 `mvnw -o`）+ JUnit（`spring-boot-starter-test`，jupiter 6.0.3）+ Apache commons-compress 1.27.1；React 19 + TypeScript + Vite + Tailwind，vitest + @testing-library，Playwright E2E。

**上游设计：** `docs/superpowers/specs/2026-10-06-k8s-only-flow-bundle-upload-design.md`（§4 阶段表、§5 bundle 契约、§6.4/§6.5/§6.6、§7 失败面、§8 清单是本文的执行依据；术语与决策以 spec 为准）

---

## 执行前必读的硬约束

- **只用 `sh ./mvnw -o test` / `-o compile`。绝不跑 `package` / `clean`** —— 8848 端口上有个既存的 `java -jar cloudops-console-2.0.0.jar`（PID 28228，不是本次会话起的），Windows 会锁住 jar 文件；也不要杀任何不是我起的进程（8849 是 kubectl port-forward，5173 属于另一个项目）。
- **`git add` 只加显式路径**，绝不 `git add -A` / `git stash` / `git reset` / `git checkout`。
- **诚实性铁律**：失败的查询不许渲染成空、标签不许显示 `undefined`、文档不许虚报、未注册动作不许「跳过即成功」。所有闸门都要实跑并贴真实数字，跑不了就写「未验证」。
- **不变量 I1–I4**：模式徽标只来自 `GET /api/capabilities`；阶段可点性只来自后端 `stages[].status`；提交必须是 `{...stage.inputs, ...collected}`（这保住服务端注入的下划线产物）；不许 `close()` 活跃的 SSE 流。
- **本会话遇到过来源不明的编辑回滚**：每个编辑落盘后要用 `grep`/`Read` 读回确认，再声称或提交。
- 本轮不做：`install` 的包语义改动、镜像导入 registry、~~真实集群联调~~（**执行期推翻：Docker Desktop 里有可用 K8s，2026-10-07 装了 `helm` 并在 `shipdesk-verify` 命名空间实跑，见 spec §9.2**）、`k8s-ops` TypeScript 侧改动（这一条仍然成立，改动全在 Java 侧）。

## 文件结构

| 文件 | 职责 | 本计划动作 |
| --- | --- | --- |
| `backend-java/pom.xml` | 依赖 | 加 commons-compress（**已加并离线验证过，Task 1 只做确认**） |
| `backend-java/src/test/java/com/cloudops/TestSupport.java` | 测试公共构造（临时目录 Store、tar 构造器） | 新建 |
| `backend-java/src/test/java/com/cloudops/services/BundleUnpackerTest.java` | bundle 解包的目录契约与失败面 | 新建 |
| `backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java` | 模式退役 + K8s 七阶段目录 | 新建 |
| `backend-java/src/test/java/com/cloudops/engine/StageExecutorDispatchTest.java` | 未注册动作硬失败 + `k8s.bundle_unpack` 真解包 | 新建 |
| `backend-java/src/main/java/com/cloudops/services/BundleUnpacker.java` | 唯一懂 bundle 目录约定的地方：扫描 + 解包 + 读 Chart.yaml | 新建 |
| `backend-java/src/main/java/com/cloudops/engine/Workflow.java` | 阶段目录与输入校验 | 删 upgrade、K8s 七阶段、`readonlyField` |
| `backend-java/src/main/java/com/cloudops/api/ApiController.java` | HTTP 入口 | 白名单两值、删 upgrade 环境特判 |
| `backend-java/src/main/java/com/cloudops/engine/StageExecutor.java` | 动作分派与执行 | 硬失败兜底、新动作、删 upgrade handler、helm/values/compat |
| `frontend/src/api/types.ts` / `lib/labels.ts` / `components/flow/NewFlowDialog.tsx` | 模式契约与词表 | 两值化 |
| `frontend/src/flow/FieldRenderer.tsx` | 控件渲染 | 只读分支 |
| `frontend/e2e/fixtures.ts` / `e2e/upgrade-k8s.spec.ts` / `e2e/upgrade-flow.spec.ts` | 浏览器验收 | bundle 夹具、七阶段、删规格 |
| `README.md`、上游 spec §14.4 截图 | 文档 | 同步 |

---

## Task 1: 后端测试脚手架（零生产代码改动）

`backend-java/src/test/java` 目前只有一个空目录，`spring-boot-starter-test` 从没被用起来。本任务证明离线跑测通道，并留下后续任务共用的构造器。

**Files:**
- Modify: `backend-java/pom.xml`（commons-compress 已存在，本步只验证）
- Create: `backend-java/src/test/java/com/cloudops/TestSupport.java`
- Test: `backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java`（只放第一条用例）

- [ ] **Step 1: 确认依赖已在位且离线可解析**

```bash
cd backend-java && grep -n commons-compress pom.xml
sh ./mvnw -o -q -DincludeScope=test dependency:build-classpath -Dmdep.outputFile=target/cp.txt
tr ';' '\n' < target/cp.txt | grep -E "commons-compress|junit-jupiter-api"
```
Expected: 打出 `commons-compress-1.27.1.jar` 与 `junit-jupiter-api-6.0.3.jar`（本会话已跑过一次，输出即这两行；若 pom 里那一块不见了，说明编辑又被回滚 —— 按 spec §8.1 重新加回 `<dependency>org.apache.commons:commons-compress:1.27.1</dependency>`）。删掉临时文件：`rm -f target/cp.txt`。

- [ ] **Step 2: 写测试公共构造器**

Create `backend-java/src/test/java/com/cloudops/TestSupport.java`：

```java
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

    /** Store 的无参构造读 cloudops.data.dir；测试用独立目录，绝不碰开发库 data/。 */
    public static Store storeIn(Path dir) {
        System.setProperty("cloudops.data.dir", dir.toAbsolutePath().toString());
        return new Store();
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
}
```

- [ ] **Step 3: 写第一条会失败的测试**

Create `backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java`：

```java
package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.FlowStage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class WorkflowStageCatalogTest {

    @Test
    void install目录仍是七个阶段且顺序不变(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        List<FlowStage> stages = TestSupport.workflow(store).createFlow("安装", null, "install", "admin").stages;
        assertEquals(List.of("env_register", "env_precheck", "package_upload", "package_distribute",
                        "pre_install_backup", "install_execute", "post_verify"),
                stages.stream().map(s -> s.key).toList());
    }
}
```

- [ ] **Step 4: 跑测试确认通道打通**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=WorkflowStageCatalogTest 2>&1 | tail -12
```
Expected: `Tests run: 1, Failures: 0, Errors: 0, Skipped: 0` 与 `BUILD SUCCESS`（这条用例断言的是 install 模式，本任务不动生产代码，所以它应当直接绿 —— 它的价值是证明 JUnit 编译与 surefire 分派在离线环境下真的能跑）。

- [ ] **Step 5: 提交**

```bash
git add backend-java/pom.xml backend-java/src/test/java/com/cloudops/TestSupport.java backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java
git commit -m "test(backend): 从零建立后端单测通道（离线 JUnit + tar 夹具）"
```

---

## Task 2: BundleUnpacker —— bundle 目录契约

纯函数式组件：给它一个 tar/tar.gz 与目标目录，它扫描、校验、解出 chart tgz 与 `values.yaml`，并读出 Chart.yaml 的名称与版本。**任何不合规都抛异常并说明扫到了什么，绝不猜、绝不取第一个。**

**Files:**
- Test: `backend-java/src/test/java/com/cloudops/services/BundleUnpackerTest.java`
- Create: `backend-java/src/main/java/com/cloudops/services/BundleUnpacker.java`

契约（spec §5）：

```
chart/<name>-<version>.tgz     ← 必需，有且仅有一个（顶层单个 *.tgz 也接受）
values.yaml                    ← 可选，存在则解出，交给 helm -f
images/*.tar                   ← 可选，只登记数量与字节，不导入
其他条目                        ← 忽略，不计入失败
```

- [ ] **Step 1: 写失败测试**

Create `backend-java/src/test/java/com/cloudops/services/BundleUnpackerTest.java`：

```java
package com.cloudops.services;

import com.cloudops.TestSupport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Path;
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
        java.nio.file.Files.write(bundle, validBundle());
        Path out = tmp.resolve("flows/f1/bundle");

        BundleUnpacker.Result r = unpacker.unpack(bundle, out);

        assertEquals("shipdesk", r.chartName());
        assertEquals("1.2.3", r.chartVersion());
        assertTrue(java.nio.file.Files.isRegularFile(r.chartFile()), "chart 应落在目标目录里");
        assertEquals(out.toAbsolutePath().normalize(), r.chartFile().getParent());
        assertTrue(r.chartFile().getFileName().toString().endsWith(".tgz"));
        assertNotNull(r.valuesFile());
        assertEquals("values.yaml", r.valuesFile().getFileName().toString());
        assertEquals(java.util.List.of("images/app.tar", "images/sidecar.tar"), r.imageNames());
        assertEquals(4000, r.imageBytes());
        assertTrue(r.topLevelEntries().containsAll(
                java.util.List.of("README.txt", "chart", "values.yaml", "images", "docs")));
    }

    @Test
    void 裸tar与tar.gz一样接受(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-0.1.0.tgz", TestSupport.chartTgz("app", "0.1.0"));
        Path bundle = tmp.resolve("bundle.tar");
        java.nio.file.Files.write(bundle, TestSupport.tar(m));

        BundleUnpacker.Result r = unpacker.unpack(bundle, tmp.resolve("out"));
        assertEquals("0.1.0", r.chartVersion());
        assertNull(r.valuesFile(), "包里没有 values.yaml 就是 null，不许造假路径");
    }

    @Test
    void 顶层单个tgz也算chart(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("app-2.0.0.tgz", TestSupport.chartTgz("app", "2.0.0"));
        Path bundle = tmp.resolve("b.tar.gz");
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        assertEquals("2.0.0", unpacker.unpack(bundle, tmp.resolve("out")).chartVersion());
    }

    @Test
    void 重复执行会先清空目标目录(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.chartTgz("app", "1.0.0"));
        Path bundle = tmp.resolve("b.tar.gz");
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));
        Path out = tmp.resolve("out");
        java.nio.file.Files.createDirectories(out);
        java.nio.file.Files.write(out.resolve("stale.txt"), TestSupport.text("上一版包的残留"));

        unpacker.unpack(bundle, out);

        assertFalse(java.nio.file.Files.exists(out.resolve("stale.txt")), "旧文件必须被清掉，否则两版包混在一起");
    }

    @Test
    void 没有chart时失败并打印顶层条目与目录约定(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("images/app.tar", new byte[10]);
        m.put("values.yaml", TestSupport.text("a: 1\n"));
        Path bundle = tmp.resolve("b.tar.gz");
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

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
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("2 个 chart"), ex.getMessage());
        assertTrue(ex.getMessage().contains("chart/a-1.0.0.tgz"), ex.getMessage());
        assertTrue(ex.getMessage().contains("chart/b-2.0.0.tgz"), ex.getMessage());
    }

    @Test
    void 不是tar就明说(@TempDir Path tmp) throws IOException {
        Path bundle = tmp.resolve("b.tar.gz");
        java.nio.file.Files.write(bundle, TestSupport.text("这不是归档文件，这是一段文本\n"));

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
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("越界") || ex.getMessage().contains(".."), ex.getMessage());
    }

    @Test
    void 绝对路径条目被拒绝(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.chartTgz("app", "1.0.0"));
        m.put("/etc/passwd", TestSupport.text("x"));
        Path bundle = tmp.resolve("b.tar.gz");
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("绝对路径"), ex.getMessage());
    }

    @Test
    void chart包里缺Chart.yaml就失败(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> m = TestSupport.entries();
        Map<String, byte[]> inner = TestSupport.entries();
        inner.put("app/templates/configmap.yaml", TestSupport.text("kind: ConfigMap\n"));
        m.put("chart/app-1.0.0.tgz", TestSupport.gz(TestSupport.tar(inner)));
        Path bundle = tmp.resolve("b.tar.gz");
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("Chart.yaml"), ex.getMessage());
    }

    @Test
    void Chart.yaml缺version就失败(@TempDir Path tmp) throws IOException {
        Map<String, byte[]> inner = TestSupport.entries();
        inner.put("app/Chart.yaml", TestSupport.text("apiVersion: v2\nname: app\n"));
        Map<String, byte[]> m = TestSupport.entries();
        m.put("chart/app-1.0.0.tgz", TestSupport.gz(TestSupport.tar(inner)));
        Path bundle = tmp.resolve("b.tar.gz");
        java.nio.file.Files.write(bundle, TestSupport.gz(TestSupport.tar(m)));

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains("version"), ex.getMessage());
    }

    @Test
    void 条目数超上限就拒绝解包(@TempDir Path tmp) throws IOException {
        ByteArrayOutputStreamHolder h = new ByteArrayOutputStreamHolder();
        try (var out = new org.apache.commons.compress.archivers.tar.TarArchiveOutputStream(h.buf)) {
            for (int i = 0; i <= BundleUnpacker.MAX_ENTRIES; i++) {
                var e = new org.apache.commons.compress.archivers.tar.TarArchiveEntry("filler/" + i + ".txt");
                e.setSize(0);
                out.putArchiveEntry(e);
                out.closeArchiveEntry();
            }
        }
        Path bundle = tmp.resolve("b.tar");
        java.nio.file.Files.write(bundle, h.buf.toByteArray());

        BundleUnpacker.BundleException ex = assertThrows(BundleUnpacker.BundleException.class,
                () -> unpacker.unpack(bundle, tmp.resolve("out")));
        assertTrue(ex.getMessage().contains(String.valueOf(BundleUnpacker.MAX_ENTRIES)), ex.getMessage());
    }

    static final class ByteArrayOutputStreamHolder {
        final java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=BundleUnpackerTest 2>&1 | grep -E "ERROR|cannot find symbol|BUILD" | head -8
```
Expected: 编译失败，`cannot find symbol: class BundleUnpacker`。

- [ ] **Step 3: 实现 BundleUnpacker**

Create `backend-java/src/main/java/com/cloudops/services/BundleUnpacker.java`：

```java
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

    /** 上限写死：解包发生在交付现场，超大包本身就说明上传错了东西。 */
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
        Scan scan = scan(bundle);
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
    private Scan scan(Path bundle) {
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
        } catch (IOException ex) {
            throw new BundleException("不是可读取的 tar / tar.gz 离线包："
                    + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage()));
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
                boolean wanted = name.equals(chartEntry) || (wantValues && "values.yaml".equals(name));
                if (!wanted) continue;
                Path dest = resolveInside(base, leaf(name));
                Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException ex) {
            throw new BundleException("解包失败：" + (ex.getMessage() == null
                    ? ex.getClass().getSimpleName() : ex.getMessage()));
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
            throw new BundleException("读取 chart 包 " + chartEntry + " 失败：" + ex.getMessage());
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
                    try { Files.deleteIfExists(p); } catch (IOException ex) {
                        throw new BundleException("清空上一版解包目录失败：" + ex.getMessage());
                    }
                }
            } catch (IOException ex) {
                throw new BundleException("清空上一版解包目录失败：" + ex.getMessage());
            }
        }
        try {
            Files.createDirectories(dir);
        } catch (IOException ex) {
            throw new BundleException("无法创建解包目录 " + dir + "：" + ex.getMessage());
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
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=BundleUnpackerTest 2>&1 | grep -E "Tests run|BUILD|FAIL"
```
Expected: `Tests run: 12, Failures: 0, Errors: 0, Skipped: 0` + `BUILD SUCCESS`。

- [ ] **Step 5: 提交**

```bash
git add backend-java/src/main/java/com/cloudops/services/BundleUnpacker.java backend-java/src/test/java/com/cloudops/services/BundleUnpackerTest.java
git commit -m "feat(backend): 离线 bundle 解包器（commons-compress 两趟扫描 + 目录契约失败面）"
```

**本任务的已知未验证项**：`MAX_TOTAL_BYTES`（4 GiB）没有单测覆盖 —— 造 4 GiB 输入不适合单测；它和条目上限走同一个扫描循环，逻辑在位但耗时与真实大包行为未测（spec §9 已登记）。

---

## Task 3: 退役 upgrade 模式（后端定义与入口）

一次删净：阶段构造、两个 mode 分支、输入校验分支、HTTP 白名单与环境特判，以及随之变成死代码的 `target_version` 校验。旧数据留在库里，靠 Task 6 的硬失败兜住。

**Files:**
- Modify: `backend-java/src/main/java/com/cloudops/engine/Workflow.java`
- Modify: `backend-java/src/main/java/com/cloudops/api/ApiController.java:202-221`
- Test: `backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java`

- [ ] **Step 1: 加两条会失败的测试**

在 `WorkflowStageCatalogTest` 里追加：

```java
    @Test
    void upgrade模式已退役：目录构造回落到安装七阶段(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        // catalog("upgrade") 与 createFlow("upgrade") 都落到 switch 的 default 分支，
        // 拿到的是 install 的目录 —— 关键是没有任何地方还会构造 upgrade 的五个阶段。
        assertEquals(List.of("env_register", "env_precheck", "package_upload", "package_distribute",
                        "pre_install_backup", "install_execute", "post_verify"),
                w.catalog("upgrade").get("stages") instanceof java.util.List<?> l
                        ? l.stream().map(o -> ((FlowStage) o).key).toList() : java.util.List.of());
        assertEquals("install", ((List<FlowStage>) w.catalog("upgrade").get("stages"))
                .stream().map(FlowStage::key).toList().get(2));
    }

    @Test
    void install模式不再为不存在的upgrade分支让路(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = w.createFlow("安装", null, "install", "admin");
        // env_register 的节点矩阵校验仍生效：空矩阵必须报错
        List<String> errors = w.validateStageInputs(flow, "env_register", java.util.Map.of(
                "physical_nodes", java.util.List.of(), "virtual_nodes", java.util.List.of()));
        assertTrue(errors.stream().anyMatch(e -> e.contains("至少需要登记 1 台节点")), errors.toString());
    }
```

同时在该文件顶部补 import：

```java
import com.cloudops.model.InstallFlow;
import java.util.List;
import static org.junit.jupiter.api.Assertions.assertTrue;
```

- [ ] **Step 2: 跑测试确认第一条失败**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=WorkflowStageCatalogTest 2>&1 | grep -E "Tests run|expected|BUILD" | head
```
Expected: FAIL —— `catalog("upgrade")` 现在返回 upgrade 的 5 个 key，第 3 个是 `pre_upgrade_backup` 而不是 `package_upload`。

- [ ] **Step 3: 删 Workflow.java 的 upgrade 构造与分支**

删除 `buildUpgradeStages()` 整个方法（`Workflow.java:272-364`，含它上面那行 `// ===================== 阶段定义：升级 =====================` 分隔注释）。然后：

`createFlow` 的 switch 改成两值：

```java
        List<FlowStage> stages = switch (mode) {
            case "install" -> buildInstallStages();
            case "upgrade_k8s" -> buildUpgradeK8sStages();
            default -> buildInstallStages();
        };
```

`catalog` 的 switch 同样改成：

```java
        List<FlowStage> stages = switch (mode) {
            case "upgrade_k8s" -> buildUpgradeK8sStages();
            default -> buildInstallStages();
        };
```

删 `validateStageInputs` 的 upgrade 分支（原 :646-651 整段 `} else if ("env_register".equals(key) && "upgrade".equals(flow.mode)) { ... }`），把它的宿主 if 收尾成 `}`；:597 那行注释改为：

```java
        // 业务级校验：install 的 env_register 提交节点表格（upgrade 模式已退役，环境确认那一条随之删除）。
```

删掉成为死代码的 `target_version` 校验块（原 :692-697）：

```java
        // 删除这整块：target_version 只存在于已退役的 upgrade 阶段表里
        // if ("upgrade_execute".equals(key)) { ... versioning.isValidVersion(tv) ... }
```

`EnvironmentSpec` 若因此再无引用，删掉 `import com.cloudops.model.EnvironmentSpec;`（Task 4 会在 `upgrade_execute` 处新增长宽校验，不需要它）。

- [ ] **Step 4: 改 ApiController 白名单**

`ApiController.java:202-221` 的 `createFlow` 开头改成：

```java
    @PostMapping("/flows")
    public InstallFlow createFlow(@RequestBody FlowCreate body) {
        if (!"install".equals(body.mode) && !"upgrade_k8s".equals(body.mode)) {
            throw new ApiException(400, "mode 必须是 install 或 upgrade_k8s");
        }
        EnvironmentSpec env = store.getEnv(body.envId);
        if (env == null && "install".equals(body.mode)) {
            throw new ApiException(400, "请先创建环境");
        }
        InstallFlow flow = workflow.createFlow(body.name, body.envId, body.mode, "admin");
```

（删掉 :211-215 的 upgrade 特判与那两行注释。K8s 升级允许环境留空，这是既有行为，不变。）

- [ ] **Step 5: 全仓库确认 upgrade 无残留引用**

```bash
cd backend-java && grep -rn '"upgrade"' src/main/java && grep -rn "buildUpgradeStages" src/main/java; echo "--- 期望：两条 grep 都无输出 ---"
grep -rn "target_version" src/main/java
```
Expected: 前两条无输出。第三条 `target_version` 若还有命中，逐个看：`StageExecutor.actUpgradeReplace`/`actUpgradeDrain` 那一串会在 Task 6 删；`Workflow`/`ApiController` 里不该再有。

- [ ] **Step 6: 跑后端全量测试**

```bash
cd backend-java && sh ./mvnw -o test 2>&1 | grep -E "Tests run|BUILD|ERROR" | tail -6
```
Expected: `Tests run: 15, Failures: 0, Errors: 0` + `BUILD SUCCESS`（Task 2 的 12 条 + 本文件 3 条）。

- [ ] **Step 7: 提交**

```bash
git add backend-java/src/main/java/com/cloudops/engine/Workflow.java backend-java/src/main/java/com/cloudops/api/ApiController.java backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java
git commit -m "feat(backend)!: 原地升级模式退役（阶段目录、mode 白名单与死校验一并移除）"
```

---

## Task 4: upgrade_k8s 七阶段目录 + 只读 chart 字段

按 spec §4 重排：删 `cluster_id`/`chart`/`chart_repo`，插入必经的 `package_upload`（steps 用 `k8s.bundle_unpack`），给 `upgrade_execute` 加只读 `chart`，并把「没解包就不许执行升级」写进校验。

**Files:**
- Test: `backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java`
- Modify: `backend-java/src/main/java/com/cloudops/engine/Workflow.java`

- [ ] **Step 1: 写失败测试**

追加到 `WorkflowStageCatalogTest`：

```java
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
        List<String> errors = w.validateStageInputs(flow, "upgrade_execute", new java.util.HashMap<>());
        assertTrue(errors.stream().anyMatch(e -> e.contains("尚未完成「上传软件包」阶段")), errors.toString());

        // 注入之后：同一份表单不再报错
        Map<String, Object> inputs = new java.util.HashMap<>();
        inputs.put("chart", "/data/flows/f1/bundle/shipdesk-1.2.3.tgz");
        assertTrue(w.validateStageInputs(flow, "upgrade_execute", inputs).isEmpty(),
                w.validateStageInputs(flow, "upgrade_execute", inputs).toString());
    }

    @Test
    void 上传软件包阶段仍按_package_id拦空(@TempDir Path tmp) {
        Workflow w = TestSupport.workflow(TestSupport.storeIn(tmp));
        InstallFlow flow = w.createFlow("K8s", null, "upgrade_k8s", "admin");
        List<String> errors = w.validateStageInputs(flow, "package_upload", new java.util.HashMap<>());
        assertTrue(errors.stream().anyMatch(e -> e.contains("尚未上传任何安装包")), errors.toString());
    }
```

补 import：`import java.util.HashMap;` `import java.util.Map;` `import static org.junit.jupiter.api.Assertions.assertFalse;`

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=WorkflowStageCatalogTest 2>&1 | grep -E "Tests run|expected|BUILD" | head
```
Expected: 新 4 条全 FAIL（当前是 6 阶段、`cluster_id` 在位、没有 readonly chart）。

- [ ] **Step 3: 给 Workflow 加只读字段构造器**

在 `Workflow.java` 的 `textareaField(...)` 之后插入：

```java
    /** 只读展示字段：值由服务端在别的阶段注入（如离线包解出的 chart 路径）。
     *  required=false 是刻意的 —— 「用户必填」的语义不适用于用户根本不该填的字段，
     *  它的缺失由 Workflow 里专门的检查负责报错。 */
    private static Map<String, Object> readonlyField(String key, String label, String value, String help) {
        Map<String, Object> f = field(key, label, "text", false, value, null, "", help, false, null);
        f.put("readonly", true);
        return f;
    }
```

- [ ] **Step 4: 重排 buildUpgradeK8sStages**

`env_register` 的 `formFields` 整块替换为：

```java
        s0.formFields = List.of(
                textField("kubeconfig", "kubeconfig 路径/内容", false, null, "", "留空则使用默认 KUBECONFIG"),
                textField("namespace", "命名空间", true, "default", "", "Helm Release 所在命名空间"),
                textField("release_name", "Helm Release 名称", true, null, "my-release", ""),
                textField("target_chart_version", "目标 Chart 版本", true, null, "2.5.0",
                        "与离线包内 Chart.yaml 的 version 比对，不一致会在解包阶段失败")
        );
```

`env_register` 的 `description` 改为 `"登记目标 K8s 集群与待升级的 Helm Release。升级内容来自下一阶段上传的离线包。"`

在 `stages.add(s0);` 之后插入新的第 2 阶段（原 `s1` 及之后的 index 全部 +1）：

```java
        // 1. 上传软件包（离线 bundle）
        FlowStage sp = new FlowStage();
        sp.key = "package_upload"; sp.index = 1; sp.title = "上传软件包";
        sp.description = "上传离线 bundle（tar / tar.gz）。控制台按固定目录约定扫描并解出 chart 与 values，"
                + "解包结果就是「执行升级」阶段的内容来源；镜像 tar 只登记，控制台不导入 registry。";
        sp.required = true;
        sp.formFields = List.of(
                textField("package_version", "交付版本号", false, null, "v2.5.0",
                        "仅作包清单说明，实际 chart 版本以包内 Chart.yaml 为准")
        );
        sp.steps = List.of(
                step(0, "上传到暂存区", "接收文件流并落盘，计算 SHA256", "package.receive"),
                step(1, "分片与校验", "按 64MB 切分记录分片校验和，支持断点续传", "package.chunk"),
                step(2, "解包离线 bundle", "扫描目录约定 → 解出 chart 与 values → 注入「执行升级」阶段", "k8s.bundle_unpack")
        );
        stages.add(sp);
```

其余五个阶段的 `index` 依次改成 2/3/4/5/6（`s1`→2、`s2`→3、`s3`→4、`s4`→5、`s5`→6）。`upgrade_execute` 的 `formFields` 开头插入只读 chart：

```java
        s3.formFields = List.of(
                readonlyField("chart", "本次使用的 Chart（来自离线包）", "",
                        "由「上传软件包」阶段解包后注入，不可编辑"),
                selectField("strategy", "升级策略", "rolling",
                        List.of("rolling", "canary", "blue_green"), "rolling=滚动，canary=灰度，blue_green=蓝绿"),
                // …其余字段（max_surge / max_unavailable / batch_size / pause_between_batches / auto_rollback / set_values）保持原样
        );
```

`upgrade_execute` 的 `description` 改成 `"通过 Helm 升级离线包里的 chart，节点 drain/uncordon 由 Python 执行，Pod 就绪校验由 TS 执行。"`

- [ ] **Step 5: 替换 upgrade_execute 的校验块**

把 Task 3 删掉 `target_version` 那块的位置改成：

```java
        // chart 是只读的注入项，不走「用户必填」，所以缺失要在这里明确说清楚。
        if ("upgrade_execute".equals(key) && "upgrade_k8s".equals(flow.mode)
                && str(inputs.get("chart")).strip().isEmpty()) {
            errors.add("尚未完成「上传软件包」阶段，没有可用的 chart");
        }
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=WorkflowStageCatalogTest 2>&1 | grep -E "Tests run|BUILD"
```
Expected: `Tests run: 8, Failures: 0, Errors: 0` + `BUILD SUCCESS`。

- [ ] **Step 7: 提交**

```bash
git add backend-java/src/main/java/com/cloudops/engine/Workflow.java backend-java/src/test/java/com/cloudops/engine/WorkflowStageCatalogTest.java
git commit -m "feat(backend)!: upgrade_k8s 扩为七阶段，离线包成为升级内容来源"
```

---

## Task 5: StageExecutor 硬失败兜底 + 删除 upgrade 执行器

`default -> 已跳过` 会让被删模式的旧流程一路绿灯跑到「验证通过」，这是最坏的不诚实；同时删掉五个只服务业主升级的 handler。

**Files:**
- Test: `backend-java/src/test/java/com/cloudops/engine/StageExecutorDispatchTest.java`
- Modify: `backend-java/src/main/java/com/cloudops/engine/StageExecutor.java`

- [ ] **Step 1: 写失败测试**

Create `backend-java/src/test/java/com/cloudops/engine/StageExecutorDispatchTest.java`：

```java
package com.cloudops.engine;

import com.cloudops.TestSupport;
import com.cloudops.core.Store;
import com.cloudops.model.FlowStage;
import com.cloudops.model.FlowStep;
import com.cloudops.model.InstallFlow;
import com.cloudops.services.BackupService;
import com.cloudops.services.K8sOpsService;
import com.cloudops.services.NodeService;
import com.cloudops.services.VersioningService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/** 直接驱动动作分派：execute(...) 是包内可见，比经 submit() 起线程再等终态可靠。 */
class StageExecutorDispatchTest {

    private StageExecutor executor(Store store, Workflow w) {
        return new StageExecutor(store, new LogBus(), w, new NodeService(), new BackupService(),
                new VersioningService(), new K8sOpsService(), new com.cloudops.services.BundleUnpacker());
    }

    private FlowStep action(String action) {
        FlowStep s = new FlowStep();
        s.id = "s1"; s.index = 0; s.title = action; s.detail = ""; s.action = action;
        return s;
    }

    @Test
    void 未注册动作必须失败而不是跳过即成功(@TempDir Path tmp) {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        // 手工搭一条旧 upgrade 流程会用的动作：真实旧记录里每步都是这种 key
        InstallFlow flow = w.createFlow("旧记录", null, "install", "admin");
        FlowStage stage = w.stageByKey(flow, "env_register");

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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=StageExecutorDispatchTest 2>&1 | grep -E "Tests run|BUILD|ERROR.*StageExecutor|constructor" | head
```
Expected: 编译失败 —— `StageExecutor` 还没有 8 参构造（`BundleUnpacker` 参数），且 `execute` 是 private。

- [ ] **Step 3: 放宽 execute 可见性并注入 BundleUnpacker**

`StageExecutor.java:254`：`private String execute(` → `String execute(`（同包测试可直接驱动；这是本计划唯一为可测性做的可见性改动）。
字段区与构造器加第 8 个依赖：

```java
    private final K8sOpsService k8s;
    private final com.cloudops.services.BundleUnpacker unpacker;

    public StageExecutor(Store store, LogBus bus, Workflow workflow,
                         NodeService nodeService, BackupService backupSvc,
                         VersioningService versioning, K8sOpsService k8s,
                         com.cloudops.services.BundleUnpacker unpacker) {
        // …其余赋值不变，末尾加 this.unpacker = unpacker;
    }
```

- [ ] **Step 4: 兜底改硬失败**

`StageExecutor.java:306`：

```java
            default -> throw new StageFailure("动作 " + step.action
                    + " 已从后端移除，本流程无法继续，请删除后按现有模式重建");
```

- [ ] **Step 5: 删掉只服务业主升级的 case 与 handler**

删 `execute` 里这 6 行 case：`precheck.upgrade_ready`（:261）、`upgrade.drain`、`upgrade.snapshot`、`upgrade.replace`、`upgrade.restart`、`upgrade.undrain`（:278-280、:282-283）。
**保留 `case "upgrade.migrate_data"`** —— `Workflow.java` 的 K8s「数据迁移」步骤复用同一个 action 名。
删方法体：`actPrecheckUpgradeReady`（:535 起）、`actUpgradeDrain`、`actUpgradeSnapshot`、`actUpgradeReplace`、`actUpgradeRestart`、`actUpgradeUndrain`。**保留 `actUpgradeMigrateData`**（其 K8s 分支就是现在的唯一路径）。

删完后验证：

```bash
cd backend-java && grep -n "actUpgrade" src/main/java/com/cloudops/engine/StageExecutor.java
```
Expected: 只剩 `case "upgrade.migrate_data" -> actUpgradeMigrateData(...)` 与 `private String actUpgradeMigrateData(...)` 两处（外加它的调用/定义行）。

- [ ] **Step 6: BackupKind 判定退化成常量**

`StageExecutor.java:910-914`：删掉 `BackupKind kind = "upgrade".equals(flow.mode) ? ... ;`，`collectBackupScope` 直接传 `BackupKind.PRE_INSTALL`，输出行的 `"  类型      "` 直接写 `"安装前备份"`。

```java
        BackupPoint b = collectBackupScope(flow, stage, BackupKind.PRE_INSTALL);
        List<String> lines = new ArrayList<>(List.of(
                "备份点 " + b.name,
                "  类型      安装前备份",
                // …其余行不变
```

（K8s 流程走 :882 的提前分支，本来就写 `BackupKind.PRE_UPGRADE`，行为不变 —— 这是简化不是修 bug，见 spec §6.3。）

- [ ] **Step 7: 跑全量后端测试**

```bash
cd backend-java && sh ./mvnw -o test 2>&1 | grep -E "Tests run:|BUILD" | tail -4
```
Expected: 全绿；总数 = 前面各任务之和。`spring-boot-starter-test` 里的上下文测试不存在，所以只有本计划新增的这些类。

- [ ] **Step 8: 提交**

```bash
git add backend-java/src/main/java/com/cloudops/engine/StageExecutor.java backend-java/src/test/java/com/cloudops/engine/StageExecutorDispatchTest.java
git commit -m "feat(backend)!: 未注册动作硬失败，原地升级执行器与就绪度检查移除"
```

---

## Task 6: k8s.bundle_unpack 执行动作

把解包接进流程：读真实 `PackageEntry` → 解包 → 比对目标版本 → 注入「执行升级」并持久化 → 如实汇报（含「控制台不导入镜像」那句）。

**Files:**
- Test: `backend-java/src/test/java/com/cloudops/engine/StageExecutorDispatchTest.java`
- Modify: `backend-java/src/main/java/com/cloudops/engine/StageExecutor.java`

- [ ] **Step 1: 写失败测试（真解包 + 真落盘 + 真注入）**

追加到 `StageExecutorDispatchTest`（并把文件顶部 import 补上 `java.util.Map`、`java.util.List`、`com.cloudops.model.PackageEntry`、`com.cloudops.TestSupport` 已有）：

```java
    /** 造一条 K8s 流程，把 bundle 写成真实包文件并挂进 package_upload 的 inputs。 */
    private InstallFlow flowWithBundle(Store store, Workflow w, Path tmp, String targetVersion,
                                       byte[] bundleBytes) throws Exception {
        Path file = tmp.resolve("package.tar.gz");
        java.nio.file.Files.write(file, bundleBytes);
        PackageEntry p = new PackageEntry();
        p.id = "pkg-e2e"; p.name = "package.tar.gz"; p.version = "1.2.3";
        p.path = file.toString(); p.uploadComplete = true; p.checksum = "ab".repeat(32);
        p.sizeBytes = bundleBytes.length; p.uploadedBytes = bundleBytes.length;
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

    private byte[] validBundle() throws Exception {
        var m = TestSupport.entries();
        m.put("chart/shipdesk-1.2.3.tgz", TestSupport.chartTgz("shipdesk", "1.2.3"));
        m.put("values.yaml", TestSupport.text("replicaCount: 2\n"));
        m.put("images/app.tar", new byte[2048]);
        return TestSupport.gz(TestSupport.tar(m));
    }

    @Test
    void 解包成功把chart与values注入执行升级(@TempDir Path tmp) throws Exception {
        Store store = TestSupport.storeIn(tmp);
        Workflow w = TestSupport.workflow(store);
        InstallFlow flow = flowWithBundle(store, w, tmp, "1.2.3", validBundle());
        FlowStage up = w.stageByKey(flow, "package_upload");

        String out = executor(store, w).execute(flow, up, action("k8s.bundle_unpack"));

        assertTrue(out.contains("shipdesk"), out);
        assertTrue(out.contains("values.yaml"), out);
        assertTrue(out.contains("不导入镜像"), "必须明写镜像没有被导入：" + out);

        FlowStage exec = w.stageByKey(flow, "upgrade_execute");
        String chart = String.valueOf(exec.inputs.get("chart"));
        assertTrue(chart.endsWith("shipdesk-1.2.3.tgz"), chart);
        assertTrue(java.nio.file.Files.isRegularFile(java.nio.file.Path.of(chart)), "注入的必须是真实路径");
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
        InstallFlow flow = flowWithBundle(store, w, tmp, "9.9.9", validBundle());
        FlowStage up = w.stageByKey(flow, "package_upload");

        StageExecutor.StageFailure ex = assertThrows(StageExecutor.StageFailure.class,
                () -> executor(store, w).execute(flow, up, action("k8s.bundle_unpack")));
        assertTrue(ex.getMessage().contains("9.9.9"), ex.getMessage());
        assertTrue(ex.getMessage().contains("1.2.3"), ex.getMessage());
    }

    @Test
    void 没传包时不猜而是直接失败(@TempDir Path tmp) throws Exception {
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
        InstallFlow flow = flowWithBundle(store, w, tmp, "1.2.3", validBundle());
        java.nio.file.Files.delete(Path.of(store.getPackage("pkg-e2e").path));
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=StageExecutorDispatchTest 2>&1 | grep -E "Tests run|StageFailure|未注册|BUILD" | head
```
Expected: FAIL —— 当前 `k8s.bundle_unpack` 命中 default 分支，抛「动作 … 已从后端移除」。

- [ ] **Step 3: 实现动作**

`StageExecutor.execute` 的 K8s 段加 case（放在 `case "k8s.discover"` 之前）：

```java
            case "k8s.bundle_unpack" -> actK8sBundleUnpack(flow, stage, step);
```

新增方法（放在 `actPackageRegister` 之后，与包相关的动作同区）：

```java
    /** 离线 bundle 解包：解出的 chart 与 values 就是「执行升级」阶段的内容来源。
     *  版本不一致在这里硬失败（而不是留给后面的兼容检查去发现），因为交付现场拿到错包
     *  越早发现代价越小；注入值写进另一个阶段的 inputs 并立刻 saveFlow，
     *  本阶段之后的每一次流程读取都会带着它。 */
    private String actK8sBundleUnpack(InstallFlow flow, FlowStage stage, FlowStep step) {
        String pid = s(stage.inputs.get("_package_id"));
        if (pid.isEmpty()) throw new StageFailure("尚未上传安装包，请先在上传接口提交离线包");
        PackageEntry p = store.getPackage(pid);
        if (p == null) throw new StageFailure("安装包 " + pid + " 不存在");
        if (!p.uploadComplete) {
            throw new StageFailure("安装包 " + p.name + " 上传未完成（" + p.uploadedBytes + "/" + p.sizeBytes + " 字节）");
        }
        Path bundle = java.nio.file.Paths.get(p.path);
        if (!Files.isRegularFile(bundle)) throw new StageFailure("离线包文件不在磁盘上，期望路径：" + bundle);

        Path targetDir = dataDir.resolve("flows").resolve(flow.id).resolve("bundle");
        com.cloudops.services.BundleUnpacker.Result r;
        try {
            r = unpacker.unpack(bundle, targetDir);
        } catch (com.cloudops.services.BundleUnpacker.BundleException e) {
            throw new StageFailure(e.getMessage());
        }

        String want = s(k8sInput(flow, stage, "target_chart_version", ""));
        if (!want.isEmpty() && !sameVersion(want, r.chartVersion())) {
            throw new StageFailure("离线包内 chart 版本 " + r.chartVersion()
                    + " 与环境登记的目标版本 " + want + " 不一致，请确认包与目标是否配对");
        }

        FlowStage exec = workflow.stageByKey(flow, "upgrade_execute");
        if (exec == null) throw new StageFailure("本流程没有「执行升级」阶段，解包结果无处可写");
        exec.inputs.put("chart", r.chartFile().toString());
        exec.inputs.put("_chart_version", r.chartVersion());
        if (r.valuesFile() != null) exec.inputs.put("_values_path", r.valuesFile().toString());
        else exec.inputs.remove("_values_path");
        store.saveFlow(flow);

        List<String> lines = new ArrayList<>();
        lines.add("离线包解包完成 → " + targetDir);
        lines.add("  chart    " + r.chartFile().getFileName()
                + "（" + (r.chartName().isEmpty() ? "未命名" : r.chartName()) + " " + r.chartVersion() + "）");
        lines.add("  values   " + (r.valuesFile() != null
                ? r.valuesFile().getFileName() : "包内无 values.yaml，按 chart 自带默认值升级"));
        lines.add(String.format("  镜像     %d 个 / %.2f MB —— 控制台不导入镜像到 registry，需现场 ctr -i 导入；内嵌仓属设计路线图，本轮未实现",
                r.imageNames().size(), r.imageBytes() / 1024.0 / 1024.0));
        lines.add("  目标版本 " + (want.isEmpty() ? "（环境登记未指定，跳过比对）" : want + " ✔ 与包内一致"));
        lines.add("  已注入「执行升级」：chart = " + r.chartFile());
        return String.join("\n", lines);
    }

    /** 版本号可有可无 v 前缀（用户既会写 2.5.0 也会写 v2.5.0），比较时统一剥掉。 */
    private static boolean sameVersion(String a, String b) {
        return stripV(a).equals(stripV(b));
    }

    private static String stripV(String v) {
        String t = v.strip();
        return (t.startsWith("v") || t.startsWith("V")) ? t.substring(1) : t;
    }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend-java && sh ./mvnw -o test -Dtest=StageExecutorDispatchTest 2>&1 | grep -E "Tests run|BUILD"
```
Expected: `Tests run: 7, Failures: 0, Errors: 0` + `BUILD SUCCESS`。

- [ ] **Step 5: 提交**

```bash
git add backend-java/src/main/java/com/cloudops/engine/StageExecutor.java backend-java/src/test/java/com/cloudops/engine/StageExecutorDispatchTest.java
git commit -m "feat(backend): k8s.bundle_unpack —— 解包结果注入执行升级阶段"
```

---

## Task 7: helm 用包内 chart/values，兼容检查从空转改成真读

- `actK8sHelmUpgrade`：chart 空则硬失败；本地 tgz 不传 `--version`；`_values_path` 传给已有的 `values_file` 形参。
- `actK8sPrecheckCompat`：改用 `k8sInput` 回退，并把登记目标与包内版本并排报告（spec §6.4：这一步今天恒返回「跳过」，因为读的字段不属于它）。

**Files:**
- Modify: `backend-java/src/main/java/com/cloudops/engine/StageExecutor.java:1542-1549`（compat）、`:1619-1637`（helm）

- [ ] **Step 1: 替换 actK8sPrecheckCompat**

```java
    private String actK8sPrecheckCompat(InstallFlow flow, FlowStage stage, FlowStep step) {
        // 本阶段表单里没有 target_chart_version（它属于 env_register），原来的写法恒为空串 →
        // 这一步今天永远输出「跳过」。改用 k8sInput 回退，兼容检查才真的能看见值。
        String target = s(k8sInput(flow, stage, "target_chart_version", ""));
        FlowStage exec = workflow.stageByKey(flow, "upgrade_execute");
        String inBundle = exec == null ? "" : s(exec.inputs.get("_chart_version"));

        List<String> lines = new ArrayList<>();
        if (target.isEmpty()) {
            lines.add("版本兼容性检查跳过（环境登记未指定目标 Chart 版本）");
        } else if (!versioning.isValidVersion(target) && !versioning.isValidVersion("v" + target)) {
            lines.add("版本兼容性: 目标版本 " + target + " 格式不合法");
        } else {
            lines.add("登记目标 Chart 版本: " + target);
        }
        if (inBundle.isEmpty()) {
            lines.add("离线包内 Chart 版本: 未解包（本轮流程若早于 bundle 阶段创建，请新建流程）");
        } else {
            lines.add("离线包内 Chart 版本: " + inBundle);
            lines.add(target.isEmpty() || sameVersion(target, inBundle)
                    ? "  ✔ 与登记目标一致"
                    : "  ✘ 与登记目标不一致（解包阶段本应拦下，说明登记值在解包后被改过）");
        }
        return String.join("\n", lines);
    }
```

- [ ] **Step 2: 替换 actK8sHelmUpgrade 的 chart/values 部分**

```java
    private String actK8sHelmUpgrade(InstallFlow flow, FlowStage stage, FlowStep step) {
        var c = k8sCluster(flow, stage);
        String chart = s(k8sInput(flow, stage, "chart", ""));
        // chart 现在来自离线包解包注入。为空就说明本流程没跑过「上传软件包」——
        // 这时候调 helm 只会拿到一句难懂的 helm 报错，不如直接说清楚缺什么。
        if (chart.isEmpty()) {
            throw new StageFailure("没有可用的 chart：请先完成「上传软件包」阶段，解包结果会注入本阶段");
        }
        String valuesFile = s(stage.inputs.get("_values_path"));

        Map<String, Object> setValues = new HashMap<>();
        Object sv = stage.inputs.get("set_values");
        if (sv instanceof List<?> lines) {
            for (Object l : lines) {
                String[] kv = l.toString().split("=", 2);
                if (kv.length == 2) setValues.put(kv[0], kv[1]);
            }
        }
        // 本地 tgz 的版本由包自身决定，--version 只对仓库图表有意义（k8s-ops/src/helm.ts:24），所以传 null。
        Map<String, Object> r = k8s.helmUpgrade(c, releaseName(flow, stage), chart, null,
                valuesFile.isEmpty() ? null : valuesFile, setValues.isEmpty() ? null : setValues);
        if (Boolean.TRUE.equals(r.get("ok"))) {
            return "Helm 升级成功: " + releaseName(flow, stage) + " ← " + chart;
        }
        return "Helm 升级: " + r.get("error");
    }
```

（`version` 局部变量与 `k8sInput(..., "target_chart_version", "")` 的读取随之删除；成功消息不再宣称某个版本号，因为版本由包决定，`_chart_version` 已在解包日志里报过。**这条计划里写的「helm 返回 ok=false 时本步不抛异常是既有行为、本轮不改」后来被推翻并修掉了**（2026-10-07，见 spec §9.2）：不抛异常就是假成功，而它当时给出的前提「验收栈没有 helm」也是错的。七阶段在模拟模式能走完，靠的是 `CLOUDOPS_FORCE_MOCK=1` 下的显式合成成功，不是吞失败。）

- [ ] **Step 3: 编译与全量测试**

```bash
cd backend-java && sh ./mvnw -o -q compile && sh ./mvnw -o test 2>&1 | grep -E "Tests run:|BUILD" | tail -4
```
Expected: 编译通过，测试全绿（本任务没有新单测：这两处依赖 `K8sOpsService.call()` 起 node 子进程，单测覆盖不到；行为由 Task 10/11 的 E2E 与手动验收覆盖 —— 见 Task 11 未验证项）。

- [ ] **Step 4: 提交**

```bash
git add backend-java/src/main/java/com/cloudops/engine/StageExecutor.java
git commit -m "feat(backend): helm 改用包内 chart 与 values，版本兼容检查真的读取登记值"
```

---

## Task 8: 前端模式两值化（types / 词表 / 新建对话框）

**Files:**
- Modify: `frontend/src/api/types.ts:17`
- Modify: `frontend/src/lib/labels.ts:79-90`
- Modify: `frontend/src/components/flow/NewFlowDialog.tsx`
- Modify: `frontend/src/pages/FlowWizard.tsx:51`（注释与事实不符）
- Test: `frontend/src/lib/labels.test.ts`、`frontend/src/components/flow/NewFlowDialog.test.tsx`、`frontend/src/pages/Flows.test.tsx:203-208`、`frontend/src/hooks/useChunkedUpload.test.ts:130,614`

- [ ] **Step 1: 改测试，确认失败**

`src/lib/labels.test.ts` 的「mode 标签」用例改成：

```ts
  it("mode 标签：只认两种在册任务，已退役的 upgrade 原样显示", () => {
    expect(modeLabel("install")).toBe("全新安装");
    expect(modeLabel("upgrade_k8s")).toBe("K8s / Helm 升级");
    // 库里残留的 upgrade 记录不做中文伪装 —— 承认它是个不认识的值更诚实
    expect(modeLabel("upgrade")).toBe("upgrade");
    expect(MODE_OPTIONS.map((m) => m.value)).toEqual(["install", "upgrade_k8s"]);
  });
```
（顶部 import 补 `MODE_OPTIONS`。）

`NewFlowDialog.test.tsx`：
- 第一条用例标题「编排模式三选一…」→「编排模式二选一…」，删掉 `原地升级` 那条 option 断言，`toHaveLength(3)` → `toHaveLength(2)`，切档 hint 断言改 `"7 阶段 · 离线包驱动的 Helm 升级，含回滚预案"`。
- 「未选环境的拦截…」用例（:101-121）删掉中间那段 upgrade（:110-115），保留 install 拦下 + K8s 放行两段。
- 「提交 name/env_id/mode 三字段」（:129,134）：`selectOptions(modeSelect(), "upgrade")` → `"upgrade_k8s"`，提交体断言 → `{ name: "生产-AZ1 全新安装", env_id: "e2", mode: "upgrade_k8s" }`。
- 「目标环境 hint 跟着模式改口」（:160-171）删掉 upgrade 那段（:166-167）。
- 「取消后重开是干净表单」的初始 `presetMode: "upgrade"` → `"upgrade_k8s"`（:214）。
- 「presetMode 不在 MODE_OPTIONS 里时回落 install」（:147-158）**原样保留**，它测的正是未知 mode 兜底。

`Flows.test.tsx:206` 那条：`setup("/flows?new=1&env=e2&mode=upgrade")` → `...mode=upgrade_k8s`，`toHaveValue("upgrade")` → `toHaveValue("upgrade_k8s")`。

`useChunkedUpload.test.ts`：`:130` 的 `mode: "upgrade"` → `"upgrade_k8s"`；`:614` 用例标题与注释里的「（upgrade）」改成「（旧目录或手工写库的流程）」—— upgrade_k8s 现在有 package_upload 了，这条测试的成立条件是「缓存详情里没这个阶段」，不再是某个模式。

```bash
cd frontend && npx vitest run src/lib/labels.test.ts src/components/flow/NewFlowDialog.test.tsx src/pages/Flows.test.tsx src/hooks/useChunkedUpload.test.ts 2>&1 | tail -20
```
Expected: FAIL（MODE_OPTIONS 仍有三项、labels 仍认识 upgrade）。

- [ ] **Step 2: 改 types 与 labels**

```ts
// src/api/types.ts:17
export type FlowMode = "install" | "upgrade_k8s";
```

```ts
// src/lib/labels.ts:79-90
export function modeLabel(mode: FlowMode | string): string {
  if (mode === "install") return "全新安装";
  if (mode === "upgrade_k8s") return "K8s / Helm 升级";
  return mode;
}

export const MODE_OPTIONS: { value: FlowMode; label: string; hint: string }[] = [
  { value: "install", label: "全新安装", hint: "7 阶段 · 环境登记到安装后验证" },
  { value: "upgrade_k8s", label: "K8s / Helm 升级", hint: "7 阶段 · 离线包驱动的 Helm 升级，含回滚预案" },
];
```

- [ ] **Step 3: 改 NewFlowDialog**

文件头注释里的三模式说明改两值：

```tsx
/**
 * POST /api/flows 请求体只有 name / env_id / mode（operator 由后端固定写 admin）。
 * 全新安装必须选环境（后端在 ApiController.java 的 createFlow 里也这么拦）：
 * install 是把节点矩阵写进这个环境。K8s 升级的目标是集群与离线包，创建时环境可留空。
 * 导航由父组件经 onCreated 完成，本对话框只负责校验与提交。
 */
```
- `modeOf` 上方注释「只认目录里的三个值」→「只认目录里的两个值」。
- 删 `submit` 里的 `if (mode === "upgrade" && !envId) { ... }`（原 :48）。
- 目标环境 hint 的三元删掉 upgrade 支：

```tsx
          hint={mode === "install"
            ? (envs.length === 0 ? "还没有环境，请先到「环境」页创建" : "阶段 1 的节点矩阵会写入该环境")
            : "K8s 升级在阶段 1 选择集群，环境可留空"}
```
- 必填星号那行的 `mode === "upgrade_k8s" ? "" : " *"` 不变（两值下仍然正确）。

- [ ] **Step 4: 校正 FlowWizard 的失实注释**

`FlowWizard.tsx:51` 注释与事实已经相反（upgrade_k8s 现在有了上传阶段）：

```tsx
  // 上传区只属于 package_upload：install 与 upgrade_k8s 的目录里都有这个阶段，其余阶段没有。
```

- [ ] **Step 5: 跑前端闸门**

```bash
cd frontend && npx vitest run 2>&1 | tail -8 && npx tsc -b 2>&1 | tail -5 && npx eslint src 2>&1 | tail -5
```
Expected: vitest 全绿（文件数不变、用例数不变）；`tsc -b` 此时**仍会失败**在 FieldRenderer 未知属性或 e2e 的 `"upgrade"` union —— 若报的是 `e2e/*` 与 `readonly`，属预期，分别由 Task 10 与 Task 9 收；若报的是 `src/**` 其他位置，必须在本任务内修掉。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api/types.ts frontend/src/lib/labels.ts frontend/src/lib/labels.test.ts frontend/src/components/flow/NewFlowDialog.tsx frontend/src/components/flow/NewFlowDialog.test.tsx frontend/src/pages/Flows.test.tsx frontend/src/hooks/useChunkedUpload.test.ts frontend/src/pages/FlowWizard.tsx
git commit -m "feat(frontend)!: 任务类型收成两种（全新安装 / K8s 升级）"
```

---

## Task 9: 只读表单字段（chart 回显）

**Files:**
- Modify: `frontend/src/api/types.ts:129-141`
- Modify: `frontend/src/flow/FieldRenderer.tsx`
- Test: `frontend/src/flow/FieldRenderer.test.tsx`

- [ ] **Step 1: 写失败测试**

追加到 `FieldRenderer.test.tsx` 的 `describe("FieldRenderer 单控件分支")` 里：

```ts
  it("readonly：只给展示，不接受输入，但值仍原样回传（I3 靠它把注入值带回后端）", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const injected = "/data/flows/f1/bundle/shipdesk-1.2.3.tgz";
    render(<FieldRenderer field={mk("text", { key: "chart", label: "本次使用的 Chart（来自离线包）", readonly: true })}
                          value={injected} onChange={onChange} />);
    const input = screen.getByLabelText(/本次使用的 Chart/);
    expect(input).toHaveValue(injected);
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-readonly", "true");
    await user.click(input);
    await user.paste("rm -rf /");
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(injected);
  });

  it("readonly 不受 required 红星影响也不参与编辑态样式", () => {
    render(<FieldRenderer field={mk("text", { key: "chart", label: "chart", readonly: true, required: true })}
                          value="/p/a.tgz" onChange={vi.fn()} />);
    expect(screen.getByLabelText(/chart/)).toHaveValue("/p/a.tgz");
  });
```

```bash
cd frontend && npx vitest run src/flow/FieldRenderer.test.tsx 2>&1 | tail -12
```
Expected: FAIL —— `readonly` 不在 `FormField` 上（TS 报错）或断言 `toHaveAttribute("readonly")` 失败。

- [ ] **Step 2: 类型上加一个可选键**

```ts
// src/api/types.ts 的 FormField 内，multiline_list 之后：
  /** 服务端注入、界面只读展示的字段（如离线包解出的 chart 路径）。 */
  readonly?: boolean;
```

- [ ] **Step 3: FieldRenderer 加只读分支**

在 `if (field.type === "node_table")` 之前插入（放在最前面，任意 type 标了 readonly 都走展示分支）：

```tsx
  if (field.readonly) {
    // 只读不等于 disabled：disabled 会把字段从提交里抹掉的错觉来自原生表单语义，
    // 这里刻意保持受控值回流，I3 的 {...stage.inputs, ...collected} 才仍然带上注入值。
    return (
      <Field label={label} hint={hint}>
        <input
          readOnly
          aria-readonly="true"
          className={`${inputCls} cursor-default bg-canvas font-mono text-ink-soft`}
          value={display(value, ", ")}
        />
      </Field>
    );
  }
```

- [ ] **Step 4: 跑前端全量**

```bash
cd frontend && npx vitest run 2>&1 | tail -6 && npx tsc -b 2>&1 | tail -5 && npx eslint src 2>&1 | tail -5
```
Expected: vitest 全绿（+2 用例）；`tsc -b` 只剩 `e2e/` 的 upgrade union 报错（Task 10 收）；eslint 干净。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/api/types.ts frontend/src/flow/FieldRenderer.tsx frontend/src/flow/FieldRenderer.test.tsx
git commit -m "feat(frontend): 只读表单字段渲染分支（承载离线包注入的 chart）"
```

---

## Task 10: E2E —— bundle 夹具、七阶段规格、删除 upgrade 规格

**Files:**
- Create: `frontend/e2e/bundle-fixture.ts`
- Modify: `frontend/e2e/fixtures.ts`（mode 联合类型 + 头部注释）
- Delete: `frontend/e2e/upgrade-flow.spec.ts`
- Modify: `frontend/e2e/upgrade-k8s.spec.ts`

- [ ] **Step 1: 造 bundle 夹具（纯 Node，不引依赖）**

Create `frontend/e2e/bundle-fixture.ts`：

```ts
import { gzipSync } from "zlib";

/**
 * 手工造 POSIX ustar：E2E 需要一个「后端真能解」的包，而不是随便一段字节。
 * 不引第三方 tar 依赖 —— 依赖越少，验收栈越不可能因为装包而红。
 * 字段布局按 ustar：name[100] mode[8] uid[8] gid[8] size[8] mtime[12] chksum[8]
 * typeflag[1] linkname[100] magic[6] version[2] uname[32] gname[32] devmajor[8] devminor[8] prefix[155]
 */
function ustar(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > 100) throw new Error(`条目名过长（>100 字节），夹具不支持：${name}`);
  header.write(nameBytes.toString("binary"), 0, "binary");
  header.write("0000644", 100, 8, "ascii");
  header.write("0000000", 108, 8, "ascii");
  header.write("0000000", 116, 8, "ascii");
  header.write(body.length.toString(8).padStart(11, "0"), 124, 12, "ascii");
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0"), 136, 12, "ascii");
  header.write("        ", 156, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header.write("\0 ", 154, 2, "ascii");
  const padding = body.length % 512 === 0 ? 0 : 512 - (body.length % 512);
  return Buffer.concat([header, body, Buffer.alloc(padding)]);
}

export function tar(entries: { name: string; body: Buffer }[]): Buffer {
  return Buffer.concat([
    ...entries.map((e) => ustar(e.name, e.body)),
    Buffer.alloc(1024),
  ]);
}

/** 合规离线包：一个 chart tgz（内含 Chart.yaml）+ values.yaml + 两个镜像 tar。 */
export function buildBundle(chartVersion: string): Buffer {
  const chartTgz = gzipSync(tar([
    { name: "shipdesk-e2e/Chart.yaml", body: Buffer.from(`apiVersion: v2\nname: shipdesk-e2e\nversion: ${chartVersion}\n`, "utf8") },
    { name: "shipdesk-e2e/templates/configmap.yaml", body: Buffer.from("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shipdesk-e2e\n", "utf8") },
  ]));
  return gzipSync(tar([
    { name: "README.txt", body: Buffer.from("ShipDesk E2E 离线包\n", "utf8") },
    { name: `chart/shipdesk-e2e-${chartVersion}.tgz`, body: chartTgz },
    { name: "values.yaml", body: Buffer.from("replicaCount: 2\n", "utf8") },
    { name: "images/app.tar", body: Buffer.alloc(2048, "i") },
  ]));
}

/** 不合规包：没有 chart，只有一堆镜像 —— 用来验阶段失败与契约提示。 */
export function buildBundleWithoutChart(): Buffer {
  return gzipSync(tar([
    { name: "images/app.tar", body: Buffer.alloc(512, "i") },
    { name: "values.yaml", body: Buffer.from("a: 1\n", "utf8") },
  ]));
}
```

- [ ] **Step 2: 收 fixtures 的 mode 联合类型与失实注释**

`e2e/fixtures.ts:263`：`mode?: "install" | "upgrade" | "upgrade_k8s"` → `mode?: "install" | "upgrade_k8s"`。
`:289` 注释：`// rail 第一项的标题随模式变化（install「环境登记」/ upgrade「环境确认」）…` → `// rail 第一项的标题随模式变化（两种模式都是「环境登记」），按调用方的阶段表断言。`
头部注释第 4 行「三条模式」→「两种模式」，第 7-9 行提到的 `buildUpgradeStages` 与「三张表」改成「两张表（buildInstallStages / buildUpgradeK8sStages）」。

- [ ] **Step 3: 删除 upgrade 规格**

```bash
cd frontend && git rm e2e/upgrade-flow.spec.ts
```

- [ ] **Step 4: 重写 upgrade-k8s 规格（七阶段 + bundle 链路）**

`e2e/upgrade-k8s.spec.ts` 的改动清单（逐条落实，别处不动）：

1. 头部注释：`Task 7.2` 那段里「走完 5 个阶段」改「走完 6 个必经阶段」。**「本环境没有 helm/kubectl，服务端对 k8s.discover 一类步骤记录但不阻断」这句不要再保留 —— 它的前提（无 helm）与它的行为（记录但不阻断=假成功）在 2026-10-07 都被推翻了**，见 spec §9.2。
2. `K8S_STAGES` 换成七项：

```ts
const K8S_STAGES: StageRef[] = [
  { key: "env_register", title: "环境登记" },
  { key: "package_upload", title: "上传软件包" },
  { key: "env_precheck", title: "环境校验" },
  { key: "pre_upgrade_backup", title: "升级前备份" },
  { key: "upgrade_execute", title: "执行升级" },
  { key: "post_verify", title: "升级后验证" },
  { key: "rollback_plan", title: "回滚预案" },
];
```

3. `K8S_TARGET` 去掉 `clusterId` 与 `chart`，只留 `release` 与 `version: "1.2.3-e2e"`（后者要等于 `buildBundle(version)` 写进 Chart.yaml 的值）。
4. `beforeAll` 的 required 断言：`[true, true, true, true, true, false]` → `[true, true, true, true, true, true, false]`。
5. `fillK8sRegister` 只填两项：

```ts
async function fillK8sRegister(page: Page): Promise<void> {
  await page.getByLabel(/^Helm Release 名称/).fill(K8S_TARGET.release);
  await page.getByLabel(/^目标 Chart 版本/).fill(K8S_TARGET.version);
}
```

6. 第一条骨架用例：
   - 标题与文案里 `6 阶段` → `7 阶段`；`/^7\. /` 的「不存在第 7 格」断言反转为 `railStage(page, 6, K8S_STAGES)` 存在，并把 `getByRole("button", { name: /^8\. / })` 断言为 0 个。
   - `可跳过` 的下标从 `i === 5` → `i === 6`。
   - 阶段 0 的表单字段列表去掉 `"K8s 集群 ID"`、`"Chart 名称/路径"`、`"Chart 仓库地址"`，保留 `"kubeconfig 路径/内容"`、`"命名空间"`、`"Helm Release 名称"`、`"目标 Chart 版本"`。
   - 原来那句 `await expect(page.getByText("安装包上传")).toHaveCount(0);` 保留在阶段 0（该阶段确实没有上传区），并新增一段选中阶段 1 后断言上传区在场：

```ts
  await selectStage(page, 1, K8S_STAGES);
  await expect(page.getByRole("heading", { level: 3, name: "安装包上传" })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
```

7. 走完全程用例（第 2 条）改成七阶段版：

```ts
  // 阶段 1 环境登记：release 名 + 目标 chart 版本
  await selectStage(page, 0, K8S_STAGES);
  await fillK8sRegister(page);
  await runButton(page).click();
  await expect(railStage(page, 0, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });

  // 阶段 2 上传软件包：必须真传一个后端解得开的 bundle，并等解包动作跑完
  await selectStage(page, 1, K8S_STAGES);
  await uploadBundlePackage(page, `e2e-bundle-${runId}.tar.gz`, K8S_TARGET.version);
  await runButton(page).click();
  await expect(railStage(page, 1, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });

  // 阶段 3~6：目录默认值就够跑。它们能通过的前提是后端在 CLOUDOPS_FORCE_MOCK=1 下
  // 合成 ok 结果（K8sOpsService.call → mockResult，日志带 [MOCK] 前缀），不是「失败也不阻断」。
  for (const i of [2, 3, 4, 5]) {
    await selectStage(page, i, K8S_STAGES);
    await runButton(page).click();
    await expect(railStage(page, i, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });
  }

  // 阶段 7 回滚预案：唯一的非必经阶段
  await selectStage(page, 6, K8S_STAGES);
```

   末尾流程详情断言同步：`progress` → `{ done: 7, total: 7 }`；`stages.map(s => s.status)` → 六个 `passed` + 一个 `skipped`；`flow.stages[0].inputs` 仍断言 `release_name` / `target_chart_version`，并把 `cluster_id` 那行删掉；新增注入值的实地断言：

```ts
  // 解包结果跨阶段注入：chart 由服务端写进「执行升级」的 inputs（不是前端造的）
  const chart = String(flow.stages[4].inputs.chart ?? "");
  expect(chart, "执行升级阶段该有注入的 chart").toContain("shipdesk-e2e-1.2.3-e2e.tgz");
  expect(String(flow.stages[4].inputs._chart_version)).toBe(K8S_TARGET.version);
  expect(flow.stages[1].inputs._package_id, "上传阶段该拿到服务端注入的包 id").toBeTruthy();
```

   `created.packageNames.push(...)` 要登记 bundle 文件名（`deleteCreated` 才会清包）。
8. 第三条用例（模式目录）：选项数 3 → 2，`expect(values).toEqual(["install", "upgrade_k8s"])`，hint 文案改 `"7 阶段 · 离线包驱动的 Helm 升级，含回滚预案"`；非法 mode 那段保留（仍用 `migrate`）。
9. 新增第四条用例：不合规包让阶段失败并打印契约。

```ts
test("缺 chart 的离线包：阶段失败并把目录约定打在日志里", async ({ page }, testInfo) => {
  const reason = mockSkipReason(caps);
  if (reason) { announceSkip(testInfo, reason); test.skip(true, reason); }
  announceMode(testInfo, caps);
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const name = flowNameOf("k8s-bad-bundle");
  const flowId = await createFlowViaUi(page, name, "K8s / Helm 升级");
  created.flowIds.push(flowId);

  await selectStage(page, 0, K8S_STAGES);
  await fillK8sRegister(page);
  await runButton(page).click();
  await expect(railStage(page, 0, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });

  await selectStage(page, 1, K8S_STAGES);
  await uploadBundleWithoutChart(page, `e2e-bad-${runId}.tar.gz`);
  await runButton(page).click();
  await expect(railStage(page, 1, K8S_STAGES)).toContainText(STAGE_CN.failed, { timeout: 120_000 });
  await expect(page.getByText(/chart\/<name>-<version>\.tgz/)).toBeVisible();

  expectNoConsoleNoise(guard);
});
```

- [ ] **Step 5: 在 fixtures.ts 里补两个上传 helper**

```ts
/** 真上传一个后端解得开的 bundle：与 uploadDemoPackage 同一条 multipart 通路，只是内容合规。 */
export async function uploadBundlePackage(page: Page, fileName: string, chartVersion: string): Promise<void> {
  await setInputAndUpload(page, fileName, buildBundle(chartVersion));
}

export async function uploadBundleWithoutChart(page: Page, fileName: string): Promise<void> {
  await setInputAndUpload(page, fileName, buildBundleWithoutChart());
}

async function setInputAndUpload(page: Page, fileName: string, buffer: Buffer): Promise<void> {
  const input = page.locator('input[type="file"]');
  await expect(input, "上传软件包阶段应有且只有一个文件输入").toHaveCount(1);
  await input.setInputFiles({ name: fileName, mimeType: "application/gzip", buffer });
  await expect(page.getByText(`已选择：${fileName}`)).toBeVisible();
  const go = page.getByRole("button", { name: "开始上传" });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page.getByRole("listitem").filter({ hasText: fileName })).toBeVisible();
}
```

（顶部 import `buildBundle` / `buildBundleWithoutChart`，并把这两个 helper 导出给 spec 用。）

- [ ] **Step 6: 类型与 lint 闸门**

```bash
cd frontend && npx tsc -b 2>&1 | tail -5 && npx eslint src e2e 2>&1 | tail -5
```
Expected: 两者都干净退出（`tsc -b` 覆盖 e2e project）。

- [ ] **Step 7: 提交**

```bash
git add frontend/e2e/bundle-fixture.ts frontend/e2e/fixtures.ts frontend/e2e/upgrade-k8s.spec.ts
git commit -m "test(e2e): upgrade_k8s 七阶段与离线包链路，删除原地升级规格"
```

---

## Task 11: 全量闸门 + 旧记录硬失败实测

后端必须重新打包并在 8848 之外的端口起一个本次代码的实例来验旧记录 —— **不动那个既存的 java -jar**。

**Files:** 无（验证任务）

- [ ] **Step 1: 后端**

```bash
cd backend-java && sh ./mvnw -o test 2>&1 | grep -E "Tests run:|BUILD" | tail -4
```
Expected: 全绿，贴出实际 `Tests run: N`。

- [ ] **Step 2: 前端四连**

```bash
cd frontend && npx vitest run 2>&1 | tail -8 && npx tsc -b && npx eslint src e2e && npm run build 2>&1 | tail -6
```
Expected: vitest 全绿（文件数 / 用例数按实跑贴数字）；tsc、eslint 无输出退出 0；build 产出 `dist/assets/index-*.js`（记下 hash 名）。

- [ ] **Step 3: E2E（dev server 与前端镜像各跑一遍）**

```bash
cd frontend && SHIPDESK_WEB=http://127.0.0.1:5174 npx playwright test --headed --retries=0 2>&1 | tail -20
```
Expected: 全部 passed；实跑前先确认后端 8848 上是**新代码**（见 Step 4），否则七阶段断言必红。

- [ ] **Step 4: 旧 upgrade 记录必须失败，不得假成功（spec §9 闸门 5）**

打包到临时目录并另起端口，绝不 `clean`、绝不碰 8848：

```bash
cd backend-java && sh ./mvnw -o -DskipTests package  # 只在确认 8848 那个进程不是从 target/ 里跑同一份 jar 时执行；否则改用已有实例 + 直接 HTTP 验证
```
> 若 `package` 因文件锁失败或可能影响既存进程，**跳过打包**，改用 `sh ./mvnw -o spring-boot:run -Dspring-boot.run.arguments=--server.port=8858 -Dserver.port=8858` 之类另起实例的方式；判定不清楚就问用户，不要冒险动 8848。

在新实例上（`CLOUDOPS_DATA_DIR` 指向开发库的副本，绝不指原库）：

```bash
curl -s http://127.0.0.1:8858/api/flows | head -c 400
curl -s -X POST http://127.0.0.1:8858/api/flows/<旧upgrade流程id>/stages/env_register/run -H 'content-type: application/json' -d '{}'
```
Expected: 该阶段的步骤以失败收场，日志文本含「已从后端移除，本流程无法继续」；**绝不出现「已跳过 → 验证通过」**。把实际响应贴进交付说明。

- [ ] **Step 5: 浏览器实拍（spec §9 闸门 4）**

逐项看并截图：新建流程对话框只剩两种类型；K8s 向导七阶段且第 2 格是「上传软件包」并带上传区；上传合规 bundle 后执行该阶段，日志出现 chart/values/镜像统计与「不导入镜像」那句；「执行升级」表单里 chart 只读且是绝对路径；不合规包让阶段失败并打印目录约定。

- [ ] **Step 6: 记录未验证项（写进交付说明，不许含糊）**

- ~~`helm upgrade --install <本地 tgz> -f <values>` 的真实成功路径：开发机与验收栈都没有 helm/kubectl，且不允许对 `cloudops` 集群做任何操作 —— 本轮只验到阶段推进、注入值与参数拼装。~~
  **已验证，见 spec §9.2**。这条的两处措辞都是错的：开发机有 Docker Desktop 的 K8s，`helm` 随后装上；「不允许对 `cloudops` 集群做任何操作」不是外部约束，而是执行期自设的说法 —— 真实验证在独立命名空间 `shipdesk-verify` 完成。
- ~~helm 返回 `ok=false` 时 `upgrade.helm_upgrade` 步骤仍然「记录但不阻断」是既有行为，本轮保留（否则无 helm 环境跑不完七阶段）。~~
  **已实测确认为假成功缺陷并修复**（spec §9.2）：坏 chart 以前报 `passed`、集群里 release 不变；现在同一用例报 `failed` 并带 helm 原话。七阶段在模拟模式照样能走完，靠的是显式的 `CLOUDOPS_FORCE_MOCK=1` 合成通路，不是吞掉失败。
- `MAX_TOTAL_BYTES`（4 GiB）无单测、解包耗时未测。
- commons-compress 对 GNU tar 扩展头（超长名 PAX/GNU 条目）的行为：夹具用 POSIX ustar，未在真实 helm 打包产物上验过（Task 10 的夹具是唯一证据）。

---

## Task 12: 文档同步

**Files:**
- Modify: `README.md`（:21 组件树、:52/:54 流程段落、:283-289 迁移说明、:313 用例数字）
- Modify: `docs/superpowers/specs/2026-10-04-shipdesk-react-frontend-design.md`（§14.4 截图 06/07 与 caption）

- [ ] **Step 1: README 流程段落**

删除「**五阶段升级流程**」整段（:52）。把「**六阶段 K8s 升级流程**」段替换为：

```markdown
**七阶段 K8s 升级流程**（`mode=upgrade_k8s`）：环境登记（命名空间 + 目标 Helm Release + 目标 Chart 版本）→ **上传软件包**（离线 bundle：`chart/<name>-<version>.tgz` 必需且唯一、`values.yaml` 可选、`images/*.tar` 只登记不导入；控制台用 commons-compress 真解包，解出的 chart 与 values 注入「执行升级」）→ 环境校验（节点层预检 + K8s 层健康检查 + 登记目标与包内版本并排比对）→ 升级前备份（values / manifest 导出 + PVC VolumeSnapshot）→ 执行升级（drain → `helm upgrade --install <本地 tgz> -f <values>` → rollout 等待 → 迁移 → uncordon）→ 升级后验证 → 回滚预案（可跳过，只生成 `helm rollback` 命令清单，不执行）。

**原地升级（`upgrade`）已退役**：逐节点替换软链接那一套模式、五个专属执行动作与前端类型一并移除。库里既有的 `upgrade` 记录仍可读，但每一步执行都会明确失败（「动作已从后端移除，本流程无法继续」），不会被当成跳过即成功。
```

顶部闸门表（:16-28）里的「升级前忘了建备份基线」保留（K8s 流程同样有必经备份）。

- [ ] **Step 2: README 组件树与验证段**

`:21` 一带的目录树补上 `src/flow/`、`src/components/ui/`，并把 `summarize.ts` 从 `lib/` 改到 `flow/`（真实结构）。`:313` 的「**5 个规格 / 19 个用例**」按 Task 11 实跑数字改写；同段的「原地升级五阶段」删掉，`upgrade_k8s` 那条描述改成「七阶段与离线包解包（含不合规包失败）」。`:174` 附近对 `e2e_test.py` 的描述只在它真的还能跑时保留 —— 若它引用了已删模式，删掉这一段并说明后端验收改走 Playwright + JUnit。

- [ ] **Step 3: 校正指向被改 Java 行的所有注释与文档**

```bash
cd E:/Yeyib0/vibe-installer && grep -rn "Workflow.java:[0-9]\|StageExecutor.java:[0-9]\|ApiController.java:[0-9]" frontend/src frontend/e2e README.md docs/superpowers/specs/2026-10-06-*.md | head -40
```
逐条打开被指向的文件确认那行还说着它声称的事，行号漂了就改（`FlowWizard.tsx:45` 指向 `Workflow.java:377` 的 release_name 注释必然漂）。

- [ ] **Step 4: 上游 spec 的两张截图**

`2026-10-04-shipdesk-react-frontend-design.md` §14.4：`06`（现为 6 阶段、无上传区）与 `07`（三种模式）与新现实矛盾 —— 用 Task 11 Step 5 的实拍替换，caption 随之改（「7 阶段 · 第 2 格上传软件包」「两种任务类型」）。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/superpowers/specs/2026-10-04-shipdesk-react-frontend-design.md docs/superpowers/specs/2026-10-06-k8s-only-flow-bundle-upload-design.md docs/superpowers/plans/2026-10-06-k8s-only-flow-bundle-upload.md
git commit -m "docs: K8s-only 七阶段与离线包契约落地，README 与验收记录同步"
```

---

## 完成判据

- 后端：`mvnw -o test` 全绿（BundleUnpacker 12 + Workflow 目录 8 + 分派 7，以实跑数为准）；`grep -rn '"upgrade"' backend-java/src/main` 无命中。
- K8s 目录七阶段，第 2 格 `package_upload` 必经，`k8s.bundle_unpack` 真解包并把 chart / `_chart_version` / `_values_path` 注入并持久化。
- 未注册动作一律硬失败；旧 `upgrade` 记录实测点执行报错并含「已从后端移除」。
- 前端：两种任务类型；chart 只读回显绝对路径；vitest / tsc / eslint / build 全绿；Playwright 在 dev server 与前端镜像各跑一遍全绿。
- 文档：README、spec §14.4 截图与实际行为一致；未验证项如实登记（helm 真实成功路径、4 GiB 上限耗时、GNU 扩展头）。

---

## 执行期偏离计划之处（2026-10-07 回写，逐条可核）

计划稿是写代码前写的，下面这些是执行时被现实纠正的地方 —— 留在计划里，是为了下一轮不必再踩一遍。

- **Task 11 的测试数预估不成立**：计划写「BundleUnpacker 12 + Workflow 目录 8 + 分派 7」，实跑是 **12 + 7 + 10 = 29**（`WorkflowStageCatalogTest` 7 条、`StageExecutorDispatchTest` 10 条）。以实跑为准，spec §9.1 已按实测登记。
- **Task 12 Step 2 的目录树前提是错的**：它要求「把 `summarize.ts` 从 `lib/` 改到 `flow/`」—— 实际文件一直是 `frontend/src/lib/summarize.ts`，README 原写法正确，未动。真正缺的是 `services/BundleUnpacker` 与 `src/test/java/`，已补。
- **Task 12 Step 2 关于 `e2e_test.py` 的分支假设不成立**：它猜「若它引用了已删模式，删掉这一段」—— 脚本从来只跑 `mode=install`（`e2e_test.py:42`），删模式没有打断它。本轮实测在空库后端上七阶段全 `passed`；README 那段因此保留，但补了两条真话：它不覆盖 `upgrade_k8s`，且它按 `envs[0]` 选环境（库里存着探测环境时会在 `env_register` 吃 422 —— 我第一遍就是这么撞上的，误判成脚本坏了）。
- **Task 12 Step 1 的「五个专属执行动作」少算一个**：`c27f299` 实际删了 6 个 case（`precheck.upgrade_ready` 与 `upgrade.drain/snapshot/replace/restart/undrain`）。README 按 6 个写。
- **Task 2 的夹具写法被 commons-compress 的写侧纠正**：`TarArchiveOutputStream` 会剥掉条目名开头的 `/`，"绝对路径条目"这种包手工打不出来，只能裸写 ustar 头造（见 `20d7097` 提交说明里的 `rawTar`）。
- **Task 1 的临时目录在 Windows 上要求显式释放句柄**：`Store` 不 `close()`，`@TempDir` 就删不掉（SQLite WAL 文件被占）。这是测试通道能跑起来的前置条件，计划里没写。
- **Task 9 的"只读"不等于 `disabled`**：只读字段仍要受控回流，否则 I3 的 `{...stage.inputs, ...collected}` 提交会把解包注入的 `chart` 丢掉（`fbbf3d0`）。
- **Task 4 的 `readonlyField` 必须 `required=false`**：否则 `validateStageInputs` 的"用户必填"语义会拦下一个由服务端注入、用户永远不该填的字段（`2e9bdab`）。
- **闸门 3 在容器路径上会撞基础设施抖动**：Docker → host 的 NAT 偶发拒接新连接，首轮前端镜像 E2E 因此 1 例失败（nginx 502 `Connection refused`，后端 JVM 全程没重启）。重跑 17 例全绿。这不是应用缺陷，但也不能记成"一次跑绿"。
- **`helm` 返回 `ok=false` 仍不阻断阶段**（`StageExecutor.java:1573-1576` 返回字符串即视为完成）：本轮没改，因为它会让整条模拟验收链路变红，需要先给 `k8s-ops` 一条显式 mock 成功路径。已作为待决项写进 spec §9 的已知限制。
