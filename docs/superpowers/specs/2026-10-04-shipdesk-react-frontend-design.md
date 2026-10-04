# ShipDesk Console — 前端 React/TS 重写设计

状态：待用户复核（v2：补入流程内核演进与定制化设计）
范围：把现有零构建 Vanilla JS SPA（`frontend/app.js` 1328 行 + `index.html`）重写为 React + TypeScript 工程，并补齐后端已有但前端未暴露的能力。产品更名为 **ShipDesk Console**（不再叫 CloudOps Console）。

## 1. 决策摘要（用户已拍板）

| 维度 | 决定 |
|---|---|
| 技术栈 | React 19 + TypeScript(strict) + Vite 6 + Tailwind CSS 3 + React Router 6 + TanStack Query 5 |
| 样式 | 迁移到 Tailwind（现有 `:root` 设计 token 映射为 Tailwind theme），视觉/交互重做 |
| 部署 | 前后端解耦：前端独立静态服务，跨域调 Java `/api`（后端 CORS 已放开） |
| 功能范围 | 全量对齐后端能力（含 `upgrade_k8s` 模式、真分片续传上传、K8s 集群页与回滚） |
| Java 静态挂载 | 清理 `WebConfig` 的 `/static`+`favicon` 与 `IndexController`，Java 变为纯 API 服务 |
| 产品名 | ShipDesk Console（title / logo / 页面标题） |

## 2. 目标与非目标

**目标**
- 行为等价：现有 5 个 tab + 阶段向导的可见功能 1:1 覆盖（后端契约不变）
- 补齐后端已有能力：`upgrade_k8s` 流程、分片续传上传、K8s 集群登记/releases/回滚
- 现代化工程：类型安全、组件化、可测试、Vite dev/build

**非目标**
- 不改后端 API 契约、不改阶段状态机/闸门逻辑（后端 `refresh_locks` 是唯一真源）
- 不在 UI 直接编排 helm/pod/冒烟动作——这些是引擎在阶段内部调 TS CLI 执行的，前端只填表单 + 看日志（与 install 流程一致）
- 不引入后端做鉴权/多用户（沿用 `operator: "admin"`）
- **不实现 §11 的流程内核（验签/内嵌镜像仓/P2P/迁移/扩容）与 §12 的流程定制化的后端逻辑**——本次仅前端重写并预留渲染能力；内核作为设计路线图，后续单独迭代实现

## 3. 后端契约（不变，前端只消费）

关键约束（来自后端代码与注释，必须保留）：
- **模式徽标以 `GET /api/capabilities` 的 `effective_mode` / `force_mock` 为唯一真源**，不能只看本机有无 ssh。强制模拟时显示"模拟模式（已强制模拟）"并在加载时提示。
- **闸门状态由后端下发**：前端只渲染 `stages[].status`（LOCKED/READY/RUNNING/PASSED/FAILED/SKIPPED），不自行推断可执行性；只有 PASSED/SKIPPED 解锁下一阶段。
- **表单提交语义**：`package_upload` 阶段服务端会注入 `_package_id` / `_package_ids` 等产物字段。前端收集 DOM 表单值时必须与这些服务端产物**合并**再提交，否则覆盖成空导致校验必挂。
- **SSE 收尾**：收到后端 `{type:"close"}` 帧才 `es.close()`，绝不在 `stage_done` 时提前关闭——服务端 `complete()` 后仍打开的 EventSource 会被浏览器自动重连，每轮重连都重放全量历史（日志翻倍、成功阶段被误标 degraded）。

消费的端点（Java `ApiController`，全部已存在）：
- 环境：`GET/POST /api/environments`、`GET/DELETE /api/environments/{id}`、节点增删
- 流程：`GET/POST /api/flows`（mode ∈ install|upgrade|**upgrade_k8s**）、`GET/DELETE /api/flows/{id}`、`GET /api/catalog/{mode}`
- 阶段：`POST /api/flows/{id}/stages/{key}/inputs|validate|run|cancel|skip`、`GET .../logs`、`GET .../stream`(SSE)
- 包：`GET /api/packages`、单次 `POST /api/packages/upload`、**分片 `POST /api/packages/upload/init` → `POST .../chunk` → `GET .../upload/{id}` → `POST .../upload/{id}/complete`**、`DELETE /api/packages/{id}`
- 分发：`GET /api/flows/{id}/distributions`
- 备份：`GET /api/backups`、`GET /api/backups/{id}`、`POST .../verify|restore|expire`
- 其它：`GET /api/overview`、`GET /api/audit`、`GET /api/capabilities`
- K8s：`GET/POST /api/k8s/clusters`、`GET/DELETE /api/k8s/clusters/{id}`、`GET /api/k8s/clusters/{id}/releases`、`POST /api/flows/{id}/rollback`

`upgrade_k8s` 六阶段（由 `/api/catalog/upgrade_k8s` 下发字段，前端 schema 驱动渲染，不硬编码）：环境登记(cluster_id/kubeconfig/namespace/release_name/chart/target_chart_version/chart_repo) → 环境校验 → 升级前备份(values/manifest/PVC 快照) → 执行升级(strategy rolling|canary|blue_green、maxSurge/maxUnavailable、set_values) → 升级后验证(冒烟/版本一致) → 回滚预案(可选)。

## 4. 架构与工程结构

`frontend/` 整体替换为 Vite 工程（旧 `app.js` / `index.html` / `verify_ui.js` 退役）：

```
frontend/
├── index.html
├── vite.config.ts           # base=/、dev server proxy /api → http://127.0.0.1:8848
├── package.json  tsconfig.json  tailwind.config.ts  postcss.config.js
├── playwright.config.ts     vitest.config.ts（或并入 vite）
└── src/
    ├── main.tsx             # createRoot + RouterProvider + QueryClientProvider + ToastProvider
    ├── App.tsx              # 顶部导航 + 模式徽标 + Routes 布局
    ├── api/
    │   ├── client.ts        # fetch 封装；错误对象带 status / fieldErrors（保留校验语义）
    │   └── types.ts         # Environment/Node/Flow/Stage/Step/Package/Backup/Capabilities/K8sCluster/HelmRelease 等
    ├── hooks/
    │   ├── useCapabilities.ts
    │   ├── useCatalog.ts            # /api/catalog/{mode}
    │   ├── useFlow.ts               # query + mutation
    │   ├── useStageRunner.ts        # run/cancel/skip + 状态机
    │   ├── useStageStream.ts        # SSE + 轮询兜底
    │   └── useChunkedUpload.ts      # init/chunk/status/complete + 断点续传
    ├── components/
    │   ├── ui/              # Button Tag Card Modal Toast Table Spin 等原语
    │   └── flow/            # StageRail StagePanel DynamicForm NodeMatrix StepList LogConsole
    ├── pages/               # Overview Envs Flows FlowWizard Packages Backups K8sClusters
    └── lib/                 # fmtBytes fmtTime statusTone 标签中文映射(ROLE_CN/STATUS_CN/…)
```

**路由**（React Router）：`/`(overview) `/envs` `/flows` `/flows/:id`(wizard，含 `?stage=` 定位) `/packages` `/backups` `/k8s`。URL 可分享、支持前进后退，取代原 `S.tab` 单例。

**服务端数据**：TanStack Query，每个资源独立 queryKey；写操作后按资源 `invalidateQueries`。轮询兜底用 `refetchInterval`。

**Tailwind theme**：把现有 CSS 变量（--brand #2563eb、--ok、--warn、--danger、--purple、radius、shadow、mono 字体）映射为 `tailwind.config` 的 theme.extend.colors / borderRadius / boxShadow / fontFamily，保持视觉基因但组件样式重写。

## 5. 关键子系统

### 5.1 实时日志与执行（useStageStream）
- `EventSource('/api/flows/{id}/stages/{key}/stream')`，解析 `log` / `step` / `stage_done` 三类消息，增量追加到日志缓冲、更新步骤快照。
- `stage_done`：`status==="passed"` 提示完成；失败提示错误；随后自动把焦点挪到下一个 ready/failed 阶段（保留原 UX）。不主动 abort。
- 轮询兜底并行运行，SSE 断开时靠轮询收敛终态（对齐原 `pollStageUntilDone` 的 1200ms）。

### 5.2 上传（useChunkedUpload）
- 小文件（< 阈值，默认 64MB）走单次 `/packages/upload`（保留旧路径）。
- 大文件走分片：`init` 拿 `upload_id/chunk_size/total_chunks` → 逐片 `chunk?upload_id&chunk_index` → `GET upload/{id}` 查 `done_chunks` 支持断点续传 → `complete` 合并算 SHA256 并关联到 `package_upload` 阶段。
- 进度条按已完成分片驱动；重进页面续传未传片。上传产物字段按 §3 合并语义写回表单。

### 5.3 schema 驱动表单与节点矩阵
- `DynamicForm` 读 `form_fields`，type ∈ text/number/select/multiselect/boolean/textarea/node_table，逐类型渲染。
- `node_table`：物理机/虚拟机分组表格；后端下发 `groups` 时以后端为准，否则用内置 PHYS_FIELDS/VIRT_FIELDS。支持加行/删行/填示例/逐格编辑，`填入示例` 用确定性演示数据。
- 提交前 `validate`（不落盘，实时提示）→ `inputs`（落盘）→ `run`；`fieldErrors` 渲染到表单错误区。

### 5.4 K8s 集群页与回滚
- K8sClusters 页：列表 + 新建(name/kubeconfig/namespace/context) + 删除；选中集群 `GET {id}/releases` 展示 helm release。
- FlowWizard 对 `upgrade_k8s` 流程提供"回滚"动作 → `POST /api/flows/{id}/rollback`（body `revision`），显式勾选确认（沿用备份恢复的确认交互）。

## 6. 后端 / 构建配套改动（前端解耦的连带）
- `WebConfig.java`：移除 `addResourceHandlers`（`/static`、`/favicon` 挂载）。CORS 保留。
- `IndexController.java`：移除根路径返回 index.html 的逻辑（前端不再由 Java 提供）。
- `Dockerfile`：删除 `COPY frontend /app/frontend`；前端镜像独立（`node build` → nginx/静态服务）。
- 说明：这些是为解耦服务的后端裁剪，不动业务 API 与状态机。

## 7. 测试
- e2e：Playwright（TS）重写 `verify_ui.js`，走完 install 七阶段、upgrade_k8s 流程、分片上传与断点续传，采集 console error。
- 单测：Vitest + @testing-library/react，覆盖 DynamicForm 收集/合并语义、statusTone 映射、分片续传 resume、fmtBytes/fmtTime。

## 8. 本地部署与验证
1. 起 Java 后端于 :8848（`mvnw spring-boot:run` 或 `java -jar target/*.jar`）。注：本机 8848 常被占用，需先释放或改端口 + Vite proxy 同步。
2. `cd frontend && npm install && npm run dev` → Vite :5173，proxy `/api`→:8848。
3. 浏览器走一遍：overview 数据、建 install 流程跑七阶段、建 upgrade_k8s 流程、K8s 集群登记+releases、大文件分片上传与续传、模式徽标（含强制模拟）。
4. 生产构建 `npm run build` → `frontend/dist/`，独立静态服务提供；验证跨域调后端。

## 9. 风险 / 待议
- 后端 API 响应字段以 Java 版为准；实现首个页面时先抓一次真实响应做类型校准，避免按旧 Python 版 schema 猜。
- `upgrade_k8s` / K8s / 分片端点的响应结构需在编码时对照 `ApiController` 逐一核实（本 spec 基于源码阅读，尚未运行期验证）。
- 彻底重写而非平移，回归风险集中在闸门交互与表单合并语义——靠 Playwright 全链路兜底。
- Tailwind 全量重写视觉，需保留可读性/密度（运维工具信息量大）。

## 10. 交付里程碑
1. 脚手架（Vite+TS+Tailwind+Router+Query 跑通，空壳 + 导航 + 模式徽标 + overview）
2. 环境/流程/包/备份四页等价移植 + FlowWizard（install）
3. DynamicForm + NodeMatrix + SSE/轮询 + 单次上传打通七阶段
4. 分片续传 + upgrade_k8s + K8s 集群页 + 回滚
5. 后端静态裁剪 + Docker 调整
6. Playwright/Vitest + 本地全链路验证

## 11. 流程内核演进路线图（设计，非本次实现）

目标内核主线（用户设想，用于 install / migrate 迁移 / scale 扩容 等流程）：

```
Chart 包上传 → 落到本服务所在节点 → 解压 → 校验签名(Helm provenance) →
推入服务内嵌镜像仓 → 点对点(P2P)分发到目标安装环境各节点 → 执行安装/迁移/扩容
```

**分发机制**：服务**内嵌镜像仓**（如 registry/harbor 容器随服务部署）。包内镜像先进本仓，再向目标环境分发。
**验签体系**：**Helm provenance（.prov / PGP）**——随 chart 提供 `.prov`，`helm verify` 校验签名与摘要；不通过则闸门拦截。

内核能力对应到现有阶段模型的落点（前端无需为它们改结构，因为都由 `steps` 承载）：
- `上传安装包`阶段：新增分片/签名产物（`.prov`）登记；`checksum` 之外记 `signature` 状态。
- `包分发`阶段：从"rsync/scp 推到节点"演进为"推内嵌仓 → P2P 到目标环境"；步骤动作换实现，阶段与表单 schema 不变。
- 迁移/扩容：作为新 `mode` 接进引擎（README 已预告"第三个 mode 复用同一套阶段引擎"），前端通过 `GET /api/catalog/{mode}` 自动渲染新阶段，无需新代码。

本次前端的预留：模式枚举、阶段/步骤渲染、签名相关字段展示位都走通用 schema，内核后端实现后前端零改动即可显示。

## 12. 流程定制化（设计目标，非本次实现）

诉求：install/migrate/scale 之外，未来允许用户按需**增删/排序阶段、自定义步骤与表单字段**。
- 后端：把当前硬编码的 `buildInstallStages()` 等演进为可配置的阶段目录（存储模板 + CRUD 端点），`/api/catalog` 成为唯一下发源。
- 前端：本已 schema 驱动，定制化的阶段/字段/步骤自动可渲染；后续加"流程模板编辑器"页即可，不动向导内核。
- 闸门语义保持：无论怎么定制，仍遵循 LOCKED→READY→RUNNING→PASSED/FAILED/SKIPPED 且按序解锁。

## 13. 本次交付边界复述（避免误解）

**做**：React/TS 重写 + 全量对齐后端**现有**能力（含已放行的 `upgrade_k8s`、分片续传、K8s 集群页/回滚）。
**不做但已预留**：§11 流程内核（验签/内嵌仓/P2P/迁移/扩容实现）与 §12 定制化后端逻辑——本次仅在设计上兼容，不编码实现。
