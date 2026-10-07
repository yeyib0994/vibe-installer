# K8s-only 流程与离线包驱动升级 设计

**日期**：2026-10-06
**分支**：`feat/shipdesk-react-frontend`
**上游设计**：`2026-10-04-shipdesk-react-frontend-design.md`（本文是其 §15 之后的第二次需求变更，§15 记录的集群登记页退役结论继续有效）

---

## 1. 变更来源与判据

用户两条判断：

1. **「升级这块是直接对接环境」**（§15 已落）—— 集群登记页与 `/api/k8s/clusters*` 已退役。
2. **「upgrade 这个去掉吧。只考虑 k8s 场景。而且整个流程里面加上上传软件包这一步骤」** —— 本文处理这条。

产品定位随之收窄：**这个控制台只做两类任务 —— 全新安装（`install`）与 K8s / Helm 升级（`upgrade_k8s`）**。「原地升级」（`upgrade`，逐节点替换软链接那一套）整体退役。界面上仍然保留「选择任务类型」这一步（新建流程对话框仍是两种类型并存），不因只剩 K8s 而砍掉类型选择器。

第二条要求里有个现存缺陷被一并修掉：`upgrade_k8s` 的「执行升级」把表单里的 `chart` 字符串原样交给 `helm upgrade --install`（`StageExecutor.java:1621-1632`），而安装包通路（分片上传 → `PackageEntry.path` 落盘 → `package_upload` 阶段登记）**与它互不相识** —— 上传的包从来不是升级的内容来源。新设计把这两条接起来：离线包决定 chart 与 values。

## 2. 范围

**做**：

- 删除 `upgrade` 模式的前后端全部痕迹（模式白名单、阶段目录、五个专属执行动作、前端类型与文案、E2E 规格）。
- `upgrade_k8s` 新增必经阶段 `package_upload`，阶段目录 6 → 7。
- 新执行动作 `k8s.bundle_unpack`：真读盘、真解包、真校验，并把结果注入「执行升级」阶段的表单。
- 离线 bundle 的目录契约与失败面。
- 未注册执行动作的兜底从「跳过并算成功」改成「明确失败」。
- 后端从零建单测（`src/test/java` 目前不存在）。

**不做**（明确排除）：

- `install` 模式的包语义不动。它现在的 `package_upload` 只做接收/分片/登记，分发与安装是另一条链路；本轮不把它改成 bundle 驱动。
- 镜像导入 registry：bundle 里的 `images/*.tar` 只登记数量与总大小，**不执行 `ctr -i`、不推内嵌仓**。内嵌仓与验签是上游设计 §11 的路线图，本轮仍是设计。
- 真实集群联调曾在设计期被列为排除项，理由是「开发机与验收栈都没有 `helm`/`kubectl`」—— **这个理由是错的**：开发机有 Docker Desktop 自带的 K8s，`helm` 随后装到了 `E:\App\helm`。§9.2 记录的是真实集群实跑，全程只在独立命名空间 `shipdesk-verify` 里操作；`cloudops` 命名空间不属于验证范围，不对它下发任何写操作。
- `k8s-ops` TypeScript sidecar 不改：`helm.upgrade` 已支持 `values_file`（`helm.ts:25`）与本地 chart 路径（`helm.ts:23`），Java 侧只是没传。

## 3. 模式表（改后）

| mode | 标签 | 阶段数 | 后端构造 |
| --- | --- | --- | --- |
| `install` | 全新安装 | 7 | `Workflow.buildInstallStages()` |
| `upgrade_k8s` | K8s / Helm 升级 | **7**（原 6） | `Workflow.buildUpgradeK8sStages()` |
| ~~`upgrade`~~ | ~~原地升级~~ | — | `buildUpgradeStages()` 删除 |

`POST /api/flows` 的白名单（`ApiController.java:204`）收成这两个值，错误文案同步为「mode 必须是 install 或 upgrade_k8s」。`Workflow.catalog(mode)` 与 `createFlow(...)` 的 `case "upgrade"` 分支删除，落到 `default -> buildInstallStages()` 的行为不变。

## 4. `upgrade_k8s` 七阶段定义

阶段 key 全部沿用现有语义（`refreshLocks` 与前端 `StageRail` 都按 key/index 线性推进，不需要改状态机）。

| # | key | 标题 | 必经 | 表单字段变化 |
| --- | --- | --- | --- | --- |
| 0 | `env_register` | 环境登记 | 是 | 留 `kubeconfig`、`namespace`、`release_name`、`target_chart_version`；**删** `cluster_id`、`chart`、`chart_repo` |
| 1 | `package_upload` | 上传软件包 | 是 | 新增阶段。字段：`package_version`（可选，交付版本号，仅作登记说明）。steps 改为 `package.receive` → `package.chunk` → **`k8s.bundle_unpack`** |
| 2 | `env_precheck` | 环境校验 | 是 | 字段不变；`precheck.compat` 这一步从空转改成真比对（见 §6.4） |
| 3 | `pre_upgrade_backup` | 升级前备份 | 是 | 字段不变；备份类型今天已是 `PRE_UPGRADE`，本次只是简化判定（见 §6.3） |
| 4 | `upgrade_execute` | 执行升级 | 是 | **新增只读字段 `chart`**（值由阶段 1 注入）；`strategy`/`max_surge`/`max_unavailable`/`batch_size`/`pause_between_batches`/`auto_rollback`/`set_values` 不变 |
| 5 | `post_verify` | 升级后验证 | 是 | 不变 |
| 6 | `rollback_plan` | 回滚预案 | 否 | 不变（只生成 `helm rollback` 命令清单，不执行） |

### 4.1 阶段 0 为什么删这三个字段

- `cluster_id`：全仓库无任何 Java 代码读它（`grep` 只命中 `Workflow.java:376` 的字段定义本身），集群登记表已按 §15 退役，帮助文案「已登记的集群 ID」指的是不存在的表。K8s 连接参数由 `kubeconfig` 与 `namespace` 决定，留一个必填的假参数只会让人以为填错会出事。
- `chart`：升级内容来源改由离线包决定，手填 chart 与包冲突时二者只能存其一。用户裁决「上传包为准，字段改只读」，于是 chart 从输入项变成阶段 4 的只读展示项。
- `chart_repo`：离线包路线里没有仓库拉取，且它同样无人读（只有字段定义）。私有仓凭证那一套属于 §11。

### 4.2 阶段 1 复用 `package_upload` 这个 key 的理由

上传通路按 key 认，不按 mode 认：

- 服务端注入：`ApiController.java:544-552`（分片 complete）与 `:627-631`（单请求）用 `workflow.stageByKey(flow, "package_upload")` 找阶段，写 `_package_id` / `_package_ids`。
- 前端上传区：`FlowWizard.tsx:52` 的 `isUploadStage = stage.key === "package_upload"`。
- 提交校验：`Workflow.java:653-655` 要求 `_package_id` 非空，否则「尚未上传任何安装包」。

三处都不需要改，加阶段即自动生效 —— 这是最小且最不易腐烂的接法。

## 5. bundle 目录契约

上传的整包必须是 tar 或 tar.gz（`PackageEntry.path` 指向 `<dataDir>/packages/<id>-<safeName>`，`UploadService.java:126-129`）。`k8s.bundle_unpack` 按固定布局扫描，不要求用户声明路径：

```
chart/<name>-<version>.tgz     ← 必需，有且仅有一个（也接受 tar 顶层单个 *.tgz）
values.yaml                    ← 可选，存在则作为 -f 传给 helm
images/*.tar                   ← 可选，只登记不导入
其他条目                        ← 忽略，不计入失败
```

解包目标目录：`<dataDir>/flows/<flowId>/bundle/`。解出的 chart tgz 与 values.yaml 落在这里，helm 直接引用绝对路径。

**为什么让 Java 做解包而不是丢给 TS sidecar 或系统 `tar`**（三方案比较，采纳 A）：

| 方案 | 采纳 | 理由 |
| --- | --- | --- |
| A · Java + commons-compress | **是** | `commons-compress 1.27.1` 的 jar 已在本地 `~/.m2`，`mvnw -o` 离线可解析；纯 JVM、无外部二进制、可在单测里直接构造 tar 输入 |
| B · spawn 系统 `tar` | 否 | 运行镜像 `eclipse-temurin:21-jre-jammy` 有 tar，但开发机是 Windows bsdtar，`-t/-x` 行为细节不同，等于验收栈与生产各跑一套；单测得起外部进程 |
| C · k8s-ops 加 `bundle.unpack` | 否 | sidecar 现在除 `@kubernetes/client-node` 零依赖，要再加 tar 库；解包不是 K8s 操作，放进 K8s 工具里边界更浑；多一次进程往返 |

## 6. 数据流与执行器改动

### 6.1 端到端链路

```
浏览器选文件
  → 分片上传 / 单请求上传（>64 MiB 走分片，可续传）
  → complete：合并落盘 + SHA256，注入 package_upload.inputs._package_id
  → 阶段 1「校验并执行」
      package.receive      复用：读 PackageEntry，校验 uploadComplete，打印大小/SHA256/存储路径
      package.chunk        复用：分片校验和齐全性；<64 MiB 时明说「无需分片」
      k8s.bundle_unpack    新增：扫描目录约定 → 解 chart tgz + values.yaml → 读 Chart.yaml 的 version
                           → 与阶段 0 的 target_chart_version 比对 → 注入
                           upgrade_execute.inputs.chart / _values_path / _chart_version
                           → store.saveFlow(flow)
  → 阶段 2 环境校验（precheck.compat 现在能报「登记目标 x，包内实际 y」）
  → 阶段 3 升级前备份
  → 阶段 4 执行升级：chart 只读展示注入值；actK8sHelmUpgrade 用本地路径，
                      不传 --version，把 _values_path 传给已有的 values_file
  → 阶段 5 验证 → 阶段 6 回滚预案
```

执行器写流程并持久化是现成通路（`StageExecutor.java:103/185/228` 都调 `store.saveFlow(flow)`），阶段 1 写阶段 4 的 inputs 不需要新机制。

### 6.2 `_chart_path` 用 `chart` 这个非下划线键承载

现有约定是：下划线前缀 = 服务端产物，不进表单渲染（`DynamicForm.tsx:13-15` 明确说明），靠不变量 I3（提交时 `{...stage.inputs, ...collected}` 合并）保住。

本设计把注入值写成 `upgrade_execute.inputs.chart`，因为「执行升级」的表单里要**看得见**它 —— 只读展示「本次用哪个 chart」比藏在 artifact 里更符合交付现场的需要。`_values_path` 与 `_chart_version` 仍走下划线（不参与填写，只被执行器与兼容检查消费）。

代价是必须保证只读字段不会被人改掉：`FieldRenderer` 的只读分支不给 `onChange` 入口，`Workflow.validateStageInputs` 对 `readonly` 字段跳过「用户必填」语义，改由 §7 的专门错误承担。

### 6.3 备份类型：随 `upgrade` 删除而退化成常量（不是修 bug）

校准过一次的事实：`StageExecutor.java:882` 在 `upgrade_k8s` 分支里已经显式 `b.kind = BackupKind.PRE_UPGRADE;`（:895），走不到 :910。所以今天 K8s 升级的备份类型是**对的**，备份页标签没有失真。

:910 的 `"upgrade".equals(flow.mode) ? PRE_UPGRADE : PRE_INSTALL` 只服务业主流程 `install` 之外的老升级路径。`upgrade` 删除后这条路径没了，:910 可以直接退化成常量 `PRE_INSTALL`。这是**简化**，不改变任何可观察行为，也不需要同阶段 key 判定 —— 我原先把它写成"修 bug"是错的。

### 6.4 版本兼容检查从空转改成真比对

`StageExecutor.java:1543` 读 `stage.inputs.get("target_chart_version")`，但 `env_precheck` 的表单里没有这个字段（它属于 `env_register`），所以这一步今天恒返回「版本兼容性检查跳过（未指定目标版本）」。改成 `k8sInput(flow, stage, "target_chart_version", "")`（与 release_name 等参数同一个回退机制，`StageExecutor.java:1496-1502`），并在包已解出时一并报告 `_chart_version`，让这一步真的能发现「登记 v2.5.0，包里是 v2.4.1」。

### 6.5 `actK8sHelmUpgrade` 的改动

- chart 来源：`k8sInput(flow, stage, "chart", "")` 不变 —— 值现在是注入的绝对路径。
- **不传 `--version`**：chart 是本地 tgz 时版本由包自身决定，`--version` 只对仓库图表有意义（`helm.ts:24`）。改为传 `null`。
- values：`k8s.helmUpgrade(c, release, chart, null, valuesFile, setValues)`，其中 `valuesFile` 取 `_values_path`（缺失传 `null`）。`K8sOpsService.java:60-69` 已有该形参，当前恒为 `null`。
- chart 为空时不再往下调 helm，直接 `StageFailure`（见 §7 最后一行）。

### 6.6 未注册动作必须失败，不能跳过

`StageExecutor.java:306` 现为：

```java
default -> "（" + step.action + " 未注册处理器，已跳过）";
```

删除 upgrade 的五个 handler 后，旧 `mode=upgrade` 流程的每一步都命中这个兜底 —— 会被**当成成功并一路绿灯跑到「验证通过」**。这是最坏的一种不诚实。改成：

```java
default -> throw new StageFailure("动作 " + step.action + " 已从后端移除，本流程无法继续，请删除后按现有模式重建");
```

这条与被删模式本身无关，是任何后续模式退役都必须依赖的安全网。

## 7. `k8s.bundle_unpack` 失败面

| 情况 | 行为（全部是阶段失败，不静默、不猜测） |
| --- | --- |
| 尚未上传任何包 | 「尚未上传任何安装包」（`Workflow.java:654` 现成，阶段 1 提交时就拦） |
| 包文件不在磁盘上 | 失败，打印期望路径 |
| 不是 tar / tar.gz 归档 | 失败，明说「只接受 tar/tgz 离线包」 |
| 找不到 chart tgz | 失败，**打印扫描到的条目列表**与 §5 的目录约定 |
| 顶层多个 chart tgz | 失败，列出候选，不取第一个 |
| chart tgz 内无 `Chart.yaml` 或读不到 `version` | 失败，说明 chart 包本身不完整 |
| `Chart.yaml` 版本 ≠ 阶段 0 的 `target_chart_version` | 失败，两个版本号都打出来 |
| 条目名含 `..` 或以 `/` 开头（zip-slip） | 失败，拒绝解包 |
| 条目数 > 20000 或解压总字节 > 4 GiB | 失败并说明上限（常量，写死在 `BundleUnpacker`） |
| 重复执行本阶段 | 幂等：先清空 `flows/<flowId>/bundle/` 再解，避免残留上一版包 |
| 镜像 tar | 成功路径里登记数量与总大小，日志明写「控制台不导入镜像到 registry，需现场 `ctr -i` 导入；内嵌仓属 §11 设计，本轮未实现」 |
| 「执行升级」的 chart 为空（没跑过阶段 1） | 校验错误：「尚未完成『上传软件包』阶段，无 chart 可用」 |

## 8. 删除与改动清单

### 8.1 后端

- `engine/Workflow.java`：删 `buildUpgradeStages()`（:273-364）；删 `createFlow` :498 与 `catalog` :518 的 `case "upgrade"`；删 `validateStageInputs` :646-651 的 upgrade 分支（:597 的注释随之改成「install 提交节点表格」单分支）；**并删 :692-697 的 `target_version` 校验块** —— `target_version` 只存在于被删的 upgrade 阶段表里，留着就是死分支（落地后要 grep 一遍确认零读者）。`buildUpgradeK8sStages` 按 §4 重排；新增 `readonlyField(...)` 下发 `"readonly": true`。
- `api/ApiController.java`：:204-206 白名单两值；:211-215 的 upgrade 特判删除（install 的「请先创建环境」拦截 :208 保留）。
- `engine/StageExecutor.java`：删 :278-280 与 :282-283 五个 case 及 `actUpgradeDrain/Snapshot/Replace/Restart/Undrain` 方法体；**同样删 `precheck.upgrade_ready`（:261）与 `actPrecheckUpgradeReady`（:535）** —— 那个动作只出现在被删的 upgrade `env_precheck` 里；**保留 `upgrade.migrate_data`（:281）与其 handler** —— `Workflow.java:451` 的 K8s「数据迁移」步骤用的是同一个 action 名，删了会打断 K8s 流程；:306 兜底改成 `StageFailure`；:910 BackupKind 退化成常量 `PRE_INSTALL`（见 §6.3）；:1543 用 `k8sInput`；:1619-1637 按 §6.5；新增 `case "k8s.bundle_unpack"`；`execute(...)` 由 private 放宽到包内可见，供单测直接驱动分派。
- 新增 `services/BundleUnpacker.java`：commons-compress 流式扫描 + 解包 + Chart.yaml 读取，失败以异常抛出，由 `StageExecutor` 转成 `StageFailure`。
- `pom.xml`：加 `org.apache.commons:commons-compress:1.27.1`（本地 `.m2` 已有 jar，离线编译可用）。
- `model/K8sCluster.java`、`services/K8sOpsService.java`、`k8s-ops/**`：不改。

### 8.2 前端

- `api/types.ts:17`：`FlowMode = "install" | "upgrade_k8s"`；`FormField` 加 `readonly?: boolean`。
- `lib/labels.ts`：删 `:81` 的 upgrade 分支与 `:88` 的 MODE_OPTIONS 项；`:89` 的 K8s hint 改成「7 阶段 · 离线包驱动的 Helm 升级，含回滚预案」。
- `components/flow/NewFlowDialog.tsx`：删 `:48` 的 upgrade 必填环境提示、`:84` hint 三元的 upgrade 支。
- `flow/FieldRenderer.tsx`：加只读分支（`readOnly` + `aria-readonly`，灰底，不进 `onChange`；值仍随表单回传，I3 不破）。
- 测试：`lib/labels.test.ts:33`（断言改为不再认识 upgrade）、`components/flow/NewFlowDialog.test.tsx`（`:112`/`:129`/`:166` 三处 `selectOptions(modeSelect(), "upgrade")` 换值，`:134` 的提交体断言随改，`:214` 的 `presetMode` 换值；`:77` 用例标题「编排模式三选一」改二选一。`:147` 那条「presetMode 不在 MODE_OPTIONS 里时回落 install」保持原样，它测的正是未知 mode 的兜底）、`pages/Flows.test.tsx:206`、`hooks/useChunkedUpload.test.ts:130` fixture 的 `mode`。
- E2E：删 `e2e/upgrade-flow.spec.ts`；`e2e/upgrade-k8s.spec.ts:205` 模式列表断言两值、阶段数断言 6 → 7，并补「上传合规 bundle → 阶段 1 执行 → 执行升级表单出现只读 chart」链路；`e2e/fixtures.ts:263` 联合类型收两值，并加一个生成合规 bundle tar 的 helper（chart tgz + `values.yaml` + `images/x.tar`）。

### 8.3 文档

- `README.md`：:52 五阶段升级段落删除；:54 六阶段 K8s 段落改七阶段并写 bundle 契约；:34 起的模式说明、:313 的「5 个规格 / 19 个用例」按实跑数字更新。
- 顺带修两处已发现的漂移：README:21 的组件目录少列了 `flow`/`ui`，且把 `summarize.ts` 归到 `lib/` —— 真实结构里 `summarize.ts` 在 `src/flow/`。
- 上游 spec：§14.4 截图表里 `06`（6 阶段、无上传区）与 `07`（三种模式）两张必须重拍，caption 随之改。

## 9. 验证

**新建后端单测**（`backend-java/src/test/java/`，目录当前不存在；pom 里 `spring-boot-starter-test` 一直没被用起来）：

- `BundleUnpackerTest`：合规 tar → 断言解出路径、`_chart_version`、镜像条目统计；缺 chart / 多 chart / 非 tar / zip-slip / 超条目数 / 版本不匹配 → 断言各自的失败消息含关键值。
- `WorkflowTest`：`upgrade_k8s` 七阶段与 key 顺序、`package_upload` 必经、readonly `chart` 不被「用户必填」拦、`POST /flows` 的 `mode=upgrade` 被拒。

**闸门**（每条都要实跑并贴数字，跑不了就写「未验证」）：

1. `sh ./mvnw -o test` —— 注意 `target/` 可能被 8848 的 `java -jar` 锁；若 test 编译受影响，如实记录并改用隔离 `-Dmaven.repo.local` / 独立 target 目录重跑。
2. `cd frontend && npx vitest run`、`npx tsc -b`、`npx eslint src e2e`、`npm run build`。
3. `SHIPDESK_WEB=http://127.0.0.1:5174 npx playwright test --headed --retries=0`，再在重建的 5181 前端镜像上跑同一套。
4. 浏览器实拍：新建流程对话框只剩两种类型；K8s 向导 7 阶段且第 2 格是「上传软件包」并有上传区；bundle 上传后执行阶段 1，日志出现解包结果；「执行升级」表单里 chart 只读且是绝对路径；缺 chart 的 bundle 让阶段失败并列出条目。
5. 旧数据回归：8848 那条 `mode=upgrade` 草稿（`dde01c60bd94`）在删除后点执行必须失败并给出「动作已从后端移除」，**不得**出现「已跳过 → 验证通过」。

**未验证项与已知限制（要写进交付说明，不许含糊）**：

- ~~`helm upgrade --install <本地 tgz> -f <values>` 的**真实成功路径**~~ → **已验证，见 §9.1 的 Docker Desktop 实跑**（成功 7/7、失败路径同一套夹具）。
- ~~**`helm` 失败不会让阶段失败**（既有行为，本轮未改）：`actK8sHelmUpgrade` 在 `ok != true` 时 `return "Helm 升级: " + r.get("error")` —— 返回字符串就是"这步做完了"，于是步骤显示「已完成」，错误文本躺在步骤输出里。~~ → **已实测确认并修复，见 §9.2**。这不是"演示环境的取舍"而是假成功：一个 helm 必然渲染失败的坏 chart，旧代码报的是「阶段5 执行升级 → passed」、流程 `succeeded`，而集群里 release 一动不动。同类问题在 `StageExecutor` 的 K8s 动作里不止 helm 一处（发现 release、健康检查、备份、PVC 快照、节点排水、rollout、ConfigMap 热更新、Pod 校验、版本校验全部如此），修法是 `requireOk(...)` 把 `ok != true` 变成 `StageFailure`。
- commons-compress 的 4 GiB / 20000 条目上限**在真实大包上的耗时与触发**：分片上传本身已验证（64 MiB 阈值、9 片续传），但解包夹具只有 ~500 B，两个上限从未被真正撞到，只被单测以直接构造的方式覆盖。
- **GNU / PAX 长名扩展头未测**：`BundleUnpackerTest` 与 E2E 夹具（`frontend/e2e/bundle-fixture.ts` 手工拼的 POSIX ustar）都不产出 GNU 长名或 PAX 头。commons-compress 会把这些头当作普通条目元数据处理，但"真实交付的 bundle 是不是 GNU tar 打的"这件事没有证据。
- 旧 `upgrade` 记录的硬失败**从第二步才开始**：它的第一阶段 `env_register` 与 install 共用动作，实测点执行会合法通过；直到 `env_precheck` 找不到 `precheck.upgrade_ready` 才报「动作已从后端移除」。也就是说"每一步执行都会失败"要精确成"每一步执行都不会假成功"。
- **容器路径的基础设施抖动**（不是应用缺陷，但如实记）：Docker → host 的 NAT 到 `host.docker.internal:8858` 偶发拒接新连接，首轮前端镜像 E2E 有 1 例卡在 `POST …/stages/pre_install_backup/validate` 的 nginx 502（`connect() failed (111: Connection refused)`，后端 JVM 全程未重启），清理后重跑同一套 17 例全绿；另有一次流程删除拿到 504。`default.conf.template` 里 15s 的 `proxy_connect_timeout` 让这类抖动表现为快速报错而不是干等。

### 9.1 实跑结果（2026-10-07，闸门逐条对账）

| 闸门 | 结果 |
| --- | --- |
| `sh ./mvnw -o test` | **Tests run: 29, Failures: 0, Errors: 0**，BUILD SUCCESS —— `StageExecutorDispatchTest` 10 + `WorkflowStageCatalogTest` 7 + `BundleUnpackerTest` 12。计划稿预估的「目录 8 + 分派 7」与实际不符，以实跑为准 |
| `npx vitest run` | **32 文件 / 346 用例全绿**（16.5s） |
| `npx tsc -b` / `npx eslint src e2e` | 均无输出 |
| `npm run build` | `index--JSKqfu2.js` 405.99 kB（gzip 127.19）+ `index-DI3z93Zr.css` 16.82 kB（gzip 4.23） |
| Playwright（dev server 5176 → 后端 8858） | **17 passed** |
| Playwright（前端镜像容器 5183 → 8858，`shipdesk-web:task11`） | 首轮 1 例因上述 502 抖动失败，重跑 **17 passed (1.1m)**；日志里 K8s 流程 `7/7 passed,passed,passed,passed,passed,passed,skipped`（末格回滚预案按可跳过被跳） |
| 浏览器实拍 | 见前端 spec `2026-10-04-shipdesk-react-frontend-design.md` §14.4 的 `06`/`07`/`16`/`17`/`18`：两种任务类型、7 阶段第 2 格上传软件包、解包日志、只读 chart 绝对路径、不合规包失败 |
| 旧数据回归 | 8848 库的 `dde01c60bd94`（`mode=upgrade`）：`env_register` 合法通过，`env_precheck` 失败并给出「动作 precheck.upgrade_ready 已从后端移除，本流程无法继续，请删除后按现有模式重建」 |
| `grep -rn '"upgrade"' backend-java/src/main` | 无命中（`upgrade_k8s` 与 `upgrade.*` 动作名不算模式字面量） |
| `python backend-java/e2e_test.py` | 空库后端上 install 七阶段全 `passed`（脚本本身不覆盖 `upgrade_k8s`） |

### 9.2 真实集群实跑与假成功修复（2026-10-07，补记）

上一节的闸门数字属于修复前（Java 29 / vitest 346 / Playwright 17 跑在「K8s 失败也不阻断」的旧执行器上）；
本节末尾给出修复后的重新对账。

**环境**：Docker Desktop 自带的 K8s（context `docker-desktop`，单节点 `desktop-control-plane`），
`helm` 装在 `E:\App\helm`。夹具与业务 release 都放在独立命名空间 `shipdesk-verify`，
`cloudops` 命名空间全程未被下发任何写操作。后端用两个隔离数据目录的实例：
`8860`（真实模式，`/api/capabilities` = `{"effective_mode":"real","force_mock":false}`）
与 `8861`（`CLOUDOPS_FORCE_MOCK=1`，两条 `mock_notice` 原文见下方「改动范围」）。

| 实跑 | 结果 |
| --- | --- |
| 成功路径（合规 bundle，chart 1.0.1） | 7 阶段全 `passed`，流程 `succeeded`。真读集群证据：阶段1 列出 `revision=2 chart=shipdesk-verify-app-1.0.1 status=deployed`；阶段2 解包并注入 `chart=…\bundle\shipdesk-verify-app-1.0.1.tgz`；阶段4 真导出 `shipdesk-verify-values.json` 与 `shipdesk-verify-manifest.yaml (1253 bytes)`；阶段5 真跑 `helm upgrade --install` 产生 revision 3；阶段6 「Pod 状态 全部 Ready（2 个）」；阶段7 回滚预案里的历史 revisions 是 `helm history` 真读回来的 |
| 失败路径（同一套夹具，chart 模板必填值故意留空） | 阶段1~4 同上全 `passed`，**阶段5 `failed`**，步骤输出 helm 原话：`Helm 升级失败: {"ok":false,"error":"Error: UPGRADE FAILED: execution error at (shipdesk-verify-app/templates/bad.yaml:6:12): 夹具故意留空的必填值…"}` |
| 修复前同一失败用例（对照） | 报的是「阶段5 执行升级 → passed」、流程 `succeeded`，而集群里 release 的 `REVISION` 与 chart 版本一动不动 —— 这就是 §9 第二条所指的假成功，现已消除 |
| 真实 Helm 回滚（`POST /api/flows/150c5c1fb4fe/rollback`） | 空 body → `{"ok":true,"data":{"stdout":"Rollback was a success! Happy Helming!\n"}}`，`helm history` 由 `3 deployed` 变 `3 superseded` + `4 deployed / Rollback to 2`，审计 `flow.rollback … ok`；`{"revision":99}` → `{"ok":false,"error":"Error: release has no 99 version"}`，审计 `flow.rollback … failed`。该端点本轮未改（本来就如实透传 `ok`），这是它第一次拿到真实集群证据 |

**改动范围**（全部在 Java 侧，`k8s-ops` sidecar 未改）：

- `StageExecutor`：新增 `requireOk(what, r)`，把每个 K8s 动作的 `ok != true` 变成 `StageFailure`；
  覆盖 `helm.list` 发现、`precheck.node`、`precheck.health`、values/manifest 备份、PVC 列表与逐个快照、
  节点排水与恢复调度、`helm upgrade`、rollout 状态、ConfigMap 热更新、Pod 就绪校验、版本一致性。
  `rollback_plan` 与交付报告不吞错：读不到就明写「回滚目标未经集群确认」「读取失败: …」。
- `K8sOpsService`：`CLOUDOPS_FORCE_MOCK=1` 时 `call()` 直接合成 `{ok:true, mock:true, data:…}`，
  不再 spawn node。这是**显式**开关驱动的模拟 —— 本机缺 `helm`/`kubectl` 不会自动进模拟，
  那必须是一次会被报告的真实失败。执行日志给这类步骤打 `[MOCK] ` 前缀。
- `RollbackButton`：`ok && mock` 时 toast 报「Helm 回滚未执行：后端处于模拟模式」，
  不再冒充「回滚完成」。
- `ApiController.capabilities` 的 `mock_notice` 措辞随之改准，两条原文（`ApiController.java:778-779`）：
  强制模拟 = 「已设置 CLOUDOPS_FORCE_MOCK=1，节点与 K8s 操作全部以模拟模式执行」；
  缺 ssh/scp = 「本机缺少 ssh/scp，节点操作将以模拟模式执行（K8s 操作仍走真实 helm/kubectl）」——
  后半句是这次补的，因为 `effective_mode` 由「强制模拟 OR 缺 ssh」共同决定（`:776`），
  而 K8s 通路只认强制模拟，两者在「有 helm 没 ssh」的机器上确实会分叉，徽标不能再含糊地说「全部操作」。

**与计划稿的偏差（如实记）**：计划里写的是一条「k8s-ops sidecar 的显式模拟通路」，实际做在
`K8sOpsService` 的 Java 侧。原因：JUnit 能直接断言合成结果与 `mock` 标记，TypeScript 侧改动要重建
sidecar 且测不到；两者对上层表现一致（`ok:true` + 可识别为模拟）。

**修复后闸门**：`sh ./mvnw -o test` **Tests run: 45, Failures: 0, Errors: 0**（在原 29 例之上
新增 `StageExecutorK8sHonestyTest` 11 例 + `K8sOpsServiceMockTest` 5 例）；
`npx vitest run` **32 文件 / 347 用例全绿**（新增 mock 回滚用例 1 例）；
`npx tsc -b`、`npx eslint src e2e` 无输出；`npm run build` `index-DHiSpL5t.js` 406.08 kB（gzip 127.26）；
`SHIPDESK_WEB=http://127.0.0.1:5190 npx playwright test`（vite 5190 → mock 后端 8861）**17 passed (56.8s)**，
其中 `upgrade-k8s.spec.ts` 的六必经阶段走完靠的是上面的显式模拟通路，落 `passed×6,skipped`。

> 踩到的坑（记下来免得再犯）：`mvnw -o test` 不带 `clean`（`target/` 被 8848 的 jar 锁着不能 clean），
> `target/surefire-reports/` 里还留着已删除的 `OfflineToolchainProbeTest` 的旧 XML；
> 把这些文件求和会得到 46，而真实数字是 Maven 汇总行里的 45。**计数只认 reactor 汇总行。**

## 10. 旧数据与迁移说明

- `upgrade` 模式的阶段是持久化在 SQLite 里的，删除后端定义不会让记录消失，只会让执行动作找不到处理器 —— §6.6 的硬失败保证这种情况报错而不是假成功。
- 已知残留：8848 的开发库里有 1 条 `mode=upgrade` 草稿（`dde01c60bd94`，早前排查「upgrade 走不出第一步」时建的探针）。用户裁决「不管旧记录」，因此不写迁移脚本、不改库、不删这条数据；它会变成一条点开能看、执行即明确失败的记录。
- 同一库里既有 `upgrade_k8s` 流程（若有）会缺 `package_upload` 阶段，因为阶段在创建时固化。旧 K8s 流程同样落在 §6.6 的失败语义里，需要新建流程才能走 bundle 链路 —— 这一点要在交付说明里讲明白。
- `env_register` 删掉的 `cluster_id`/`chart`/`chart_repo` 只影响新建流程；旧流程 inputs 里残留的这三个键不再被读取。
- 总览与流程列表用 `modeLabel(f.mode)` 渲染类型（`Overview.tsx:92`、`Flows.tsx:59`），该函数对未知值原样返回（`labels.ts:83`）。所以旧 `upgrade` 流程在两处列表里会显示成英文原值 `upgrade` 而不是「原地升级」—— 保留这个行为，它比伪造一个已退役的中文标签更诚实。

## 11. 决策记录

| # | 决策 | 用户裁决 |
| --- | --- | --- |
| 1 | bundle 消费方 | 整包 bundle，拆分登记（chart + values + 镜像三件，chart 驱动 helm） |
| 2 | upgrade 删除深度 | 彻底删，不管旧记录（配 §6.6 安全网） |
| 3 | chart 归属 | 上传包为准，字段改只读 |
| 4 | bundle 布局 | 固定目录约定，自动扫描（不让人声明路径） |
| 5 | 解包实现 | 方案 A：Java + commons-compress |
| 6 | 界面任务类型 | 两种并存，保留类型选择器 |
| 7 | `cluster_id` / `chart_repo` | 一并删（推翻 §15 里「不动后端」那次裁决，因为本轮本来就在改后端阶段定义） |
| 8 | 真实集群验证 | 装 `helm` + 只用独立命名空间 `shipdesk-verify`（§2 那条「没有 helm/kubectl」的排除理由由此作废）。用户当场指出本机有 Docker Desktop K8s，且「不允许碰 cloudops」是我自设的约束而非事实 |
| 9 | `ok=false` 假成功 | 彻底修：三处以上 K8s 动作改抛 `StageFailure`，并给模拟模式一条显式成功通路（§9.2）。推翻 §9 里「已作为待决项交给用户」的搁置 |
