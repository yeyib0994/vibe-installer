# ShipDesk Console — 前端 React/TS 重写设计

状态：待用户复核（v2：补入流程内核演进与定制化设计）
范围：把现有零构建 Vanilla JS SPA（`frontend/app.js` 1328 行 + `index.html`）重写为 React + TypeScript 工程，并补齐后端已有但前端未暴露的能力。产品更名为 **ShipDesk Console**（不再叫 CloudOps Console）。

## 1. 决策摘要（用户已拍板）

| 维度 | 决定 |
|---|---|
| 技术栈 | React 19 + TypeScript(strict) + Vite 6 + Tailwind CSS 3 + React Router 6 + TanStack Query 5 |
| 样式 | 迁移到 Tailwind（现有 `:root` 设计 token 映射为 Tailwind theme），视觉/交互重做 |
| 部署 | 前后端解耦：前端独立静态服务，跨域调 Java `/api`（后端 CORS 已放开） |
| 功能范围 | 全量对齐后端能力（含 `upgrade_k8s` 模式、真分片续传上传、回滚入口）；K8s 集群登记页于 2026-10-06 退役，见 §15 |
| Java 静态挂载 | 清理 `WebConfig` 的 `/static`+`favicon` 与 `IndexController`，Java 变为纯 API 服务 |
| 产品名 | ShipDesk Console（title / logo / 页面标题） |

## 2. 目标与非目标

**目标**
- 行为等价：现有 5 个 tab + 阶段向导的可见功能 1:1 覆盖（后端契约不变）
- 补齐后端已有能力：`upgrade_k8s` 流程、分片续传上传、Helm 回滚入口（K8s 集群登记原本也在列，后按 §15 移除）
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

消费的端点（Java `ApiController`，全部已存在）。逐条按实现核对过，两处如实标注：`GET /api/catalog/{mode}` **只有 E2E 在用**（`e2e/install-flow.spec.ts:29`、`upgrade-k8s.spec.ts:69` 用它对齐阶段表；当时还有 `upgrade-flow.spec.ts` 一处，随原地升级退役删除），运行时的向导并不请求它 —— 模式清单是前端固定的 `MODE_OPTIONS`（`lib/labels.ts:85-88`，含每种模式几阶段的提示文案），阶段与表单 schema 从 `GET /api/flows/{id}` 拿；后端没有任何枚举模式的端点，所以「清单从后端来」这条在设计期就注定做不到，见 §14.7。`GET /api/flows/{id}/distributions` 前端**完全没消费**（分发进度由 `.../logs` 与流程详情里的 stage 状态呈现），列在这里只作后端能力索引。
- 环境：`GET/POST /api/environments`、`GET/DELETE /api/environments/{id}`、节点增删 `POST/DELETE /api/environments/{id}/nodes[/{nodeId}]`
- 流程：`GET/POST /api/flows`（mode ∈ install|upgrade|**upgrade_k8s**）、`GET/DELETE /api/flows/{id}`、`GET /api/catalog/{mode}`
- 阶段：`POST /api/flows/{id}/stages/{key}/inputs|validate|run|cancel|skip`、`GET .../logs`、`GET .../stream`(SSE)
- 包：`GET /api/packages`、单次 `POST /api/packages/upload`、**分片 `POST /api/packages/upload/init` → `POST .../chunk` → `GET .../upload/{id}` → `POST .../upload/{id}/complete`**、`DELETE /api/packages/{id}`
- 分发：`GET /api/flows/{id}/distributions`
- 备份：`GET /api/backups`、`GET /api/backups/{id}`、`POST .../verify|restore|expire`
- 其它：`GET /api/overview`、`GET /api/audit`、`GET /api/capabilities`
- K8s：`POST /api/flows/{id}/rollback`（`/api/k8s/clusters*` 五个集群登记端点已随 §15 删除）

`upgrade_k8s` 六阶段（由 `/api/catalog/upgrade_k8s` 下发字段，前端 schema 驱动渲染，不硬编码）：环境登记(cluster_id/kubeconfig/namespace/release_name/chart/target_chart_version/chart_repo) → 环境校验 → 升级前备份(values/manifest/PVC 快照) → 执行升级(strategy rolling|canary|blue_green、maxSurge/maxUnavailable、set_values) → 升级后验证(冒烟/版本一致) → 回滚预案(可选)。

> **本节以下列出的六阶段目录、`cluster_id`/`chart`/`chart_repo` 表单字段、`upgrade` 原地升级模式，均已被 2026-10-06/07 那一轮推翻**：`upgrade` 退役、`upgrade_k8s` 扩为七阶段（第 2 格「上传软件包」）、`cluster_id`/`chart_repo` 删除、`chart` 变成解包注入的只读字段。现行契约见 `2026-10-06-k8s-only-flow-bundle-upload-design.md`。下文保留原样是为了让验收记录与当时的实测对得上。

## 4. 架构与工程结构

`frontend/` 整体替换为 Vite 工程（旧 `app.js` / `index.html` / `verify_ui.js` 退役）：

```
frontend/
├── index.html
├── vite.config.ts           # base=/、dev server proxy /api → http://127.0.0.1:8848
├── package.json  tsconfig.base/app/test.json + tsconfig.json（solution）  tailwind.config.ts  postcss.config.js
├── playwright.config.ts     vitest.config.ts（或并入 vite）
└── src/
    ├── main.tsx             # createRoot + RouterProvider + QueryClientProvider + ToastProvider
    ├── App.tsx              # 顶部导航 + 模式徽标 + Routes 布局
    ├── api/
    │   ├── client.ts        # fetch 封装；错误对象带 status / fieldErrors（保留校验语义）
    │   └── types.ts         # Environment/Node/Flow/Stage/Step/Package/Backup/Capabilities 等
    ├── hooks/               # 落地后的实际划分（与本草图不同处已按实现校正）
    │   ├── queries.ts              # useCapabilities/useOverview/useEnvironments/useFlows/useFlow
    │   │                           # + 各 mutation；没有独立的 useCatalog —— 模式清单在前端固定，
    │   │                           #   阶段与表单 schema 走 GET /api/flows/{id}
    │   ├── useFlowRunner.ts        # validate/inputs/run/cancel/skip + 草稿与阶段推进
    │   ├── useStageStream.ts       # SSE + 轮询兜底
    │   └── useChunkedUpload.ts     # init/chunk/status/complete + 断点续传
    ├── components/
    │   ├── ui/              # Button Tag Card Modal Toast Table Spin 等原语
    │   └── flow/            # StageRail StagePanel DynamicForm NodeMatrix StepList LogConsole
    ├── pages/               # Overview Envs Flows FlowWizard Packages Backups
    └── lib/                 # fmtBytes fmtTime statusTone 标签中文映射(ROLE_CN/STATUS_CN/…)
```

**路由**（React Router）：`/`(overview) `/envs` `/flows` `/flows/:id`(wizard，含 `?stage=` 定位) `/packages` `/backups`。URL 可分享、支持前进后退，取代原 `S.tab` 单例。（设计期还有第七条 `/k8s`，按 §15 移除。）

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
- 进度条按已完成分片驱动；重进页面续传未传片（前提是后端进程没重启，会话登记在内存 Map，见 §14.6）。上传产物字段按 §3 合并语义写回表单。

### 5.3 schema 驱动表单与节点矩阵
- `DynamicForm` 读 `form_fields`，type ∈ text/number/select/multiselect/boolean/textarea/node_table，逐类型渲染。
- `node_table`：物理机/虚拟机分组表格；后端下发 `groups` 时以后端为准，否则用内置 PHYS_FIELDS/VIRT_FIELDS。支持加行/删行/填示例/逐格编辑，`填入示例` 用确定性演示数据。
- 提交前 `validate`（不落盘，实时提示）→ `inputs`（落盘）→ `run`；`fieldErrors` 渲染到表单错误区。

### 5.4 K8s 回滚入口（集群登记页已退役，见 §15）
- FlowWizard 对 `upgrade_k8s` 流程提供"回滚"动作 → `POST /api/flows/{id}/rollback`（body `revision`），显式勾选确认（沿用备份恢复的确认交互）。
- 升级要用的集群凭证由 `env_register` 阶段的表单输入提供，不依赖任何集群登记表。

## 6. 后端 / 构建配套改动（前端解耦的连带）
- `WebConfig.java`：移除 `addResourceHandlers`（`/static`、`/favicon` 挂载）。CORS 保留。
- `IndexController.java`：移除根路径返回 index.html 的逻辑（前端不再由 Java 提供）。
- `Dockerfile`：删除 `COPY frontend /app/frontend`；前端镜像独立（`node build` → nginx/静态服务）。
- 生产与配置收紧（R1 复核轮）：`frontend/vite.config.ts` 的 `build` 去掉 `sourcemap`（静态站带 `.map` 等于把 TS 源码公开）；
  `frontend/.dockerignore` 补 `.vite` 与宿主 `node_modules`（`COPY . .` 会把 Windows 依赖树盖进镜像里 `npm ci` 刚装好的 Linux 树）；
  `default.conf.template` 给 `/healthz` 加 `proxy_connect_timeout 3s`；后端 `Dockerfile` 的 `HEALTHCHECK` 改 `curl -fsS`
  （运行阶段只装了 curl，原来那条 `wget` 恒失败）、k8s-ops 构建改 `npm ci`；根 `.gitattributes` 把文本钉成一律 LF
  （`core.autocrlf` 会把 Dockerfile / nginx 模板签成 CRLF 再进镜像），`.gitignore` 清掉已删除的 Python 后端残留（`dist/` 那行留着，它管的是前端与 k8s-ops 产物）；
  `@eslint/js` 从 eslint 的传递依赖提为显式 devDependency，`npm run lint` 覆盖 `src` 与 `e2e`；
  `tsconfig` 拆成 app / test 两个 project，应用源码额外吃 `noUncheckedIndexedAccess`（测试按下标取值是刻意的，不套这条）。
- K8s 部署链路补齐（R1 复核轮）：解耦后 `k8s/` 只铺了后端，前端静态站没有落地清单，`k8s/deploy.ps1` 还写着
  「前端地址: http://localhost:30848」—— 那是个没有页面的裸 API。新增 `k8s/web-deployment.yaml`
  （`shipdesk-web`，`replicas: 2`，探针打 `/`：打 `/healthz` 会把后端可用性算进前端 readiness，后端滚动时页面整体不可达，
  而前端本就有如实的「服务不可达」错误态）与 `k8s/web-service.yaml`（NodePort 30880 → 容器 80，浏览器唯一入口，
  页面与 `/api` 同源）；30848 那个 Service 保留不动，以免打断已在用它的调用方。`deploy.ps1` 改为构建两个镜像、
  apply 八份清单、等两个 rollout。同时把两处 `imagePullPolicy: Always` 改成 `IfNotPresent`：本地构建的镜像没有仓库前缀，
  `Always` 会让 kubelet 去 docker.io 拉一个不存在的 `library/…`，Pod 直接卡在 ImagePullBackOff。
  另外 `deploy.ps1` 此前**在 Windows PowerShell 5.1 下根本解析不过**（`Parser::ParseFile` 报「字符串缺少终止符」）：
  脚本是 UTF-8 无 BOM，5.1 对无 BOM 文件按系统 ANSI 码页解码，中文注释/字符串里的字节对会吞掉紧随其后的引号。
  现已写成 UTF-8 **带 BOM**，`Parser::ParseFile` 复核 0 错误；这条理由记在 `.gitattributes` 的 `*.ps1` 注释里，
  免得后人把 BOM 当噪声删掉。
- **一处例外（如实记录）**：本轮原计划不动后端，但 `upgrade` 模式在前端接上后暴露出后端自身的死路 ——
  `env_register` 的校验与节点重建不分 mode，升级流第一步恒 422，放行还会把环境已登记的节点矩阵清空。
  已按 mode 分流修掉（`ApiController.java:273-316` 一带，提交 `db36982`），并补了 `upgrade-flow.spec.ts`
  的双端门禁用例（前端拦下 + `POST /api/flows` 无环境时 400）。除此之外未动业务 API 与状态机。
- 说明：这些是为解耦服务的后端裁剪，不动业务 API 与状态机。

## 7. 测试
- e2e：Playwright（TS）重写 `verify_ui.js`，走完 install 七阶段、upgrade_k8s 流程、分片上传与断点续传，采集 console error。
- 单测：Vitest + @testing-library/react，覆盖 DynamicForm 收集/合并语义、statusTone 映射、分片续传 resume、fmtBytes/fmtTime。

## 8. 本地部署与验证
1. 起 Java 后端于 :8848（`mvnw spring-boot:run` 或 `java -jar target/*.jar`）。注：本机 8848 常被占用，需先释放或改端口 + Vite proxy 同步。
2. `cd frontend && npm install && npm run dev` → Vite :5173，proxy `/api`→:8848。
3. 浏览器走一遍：overview 数据、建 install 流程跑七阶段、建 upgrade_k8s 流程、K8s 集群登记+releases（该页与端点已按 §15 移除）、大文件分片上传与续传、模式徽标（含强制模拟）。
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
4. 分片续传 + upgrade_k8s + K8s 集群页（后按 §15 移除）+ 回滚
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

**做**：React/TS 重写 + 全量对齐后端**现有**能力（含已放行的 `upgrade_k8s`、分片续传、回滚入口；K8s 集群页实现过又按 §15 退役）。
**不做但已预留**：§11 流程内核（验签/内嵌仓/P2P/迁移/扩容实现）与 §12 定制化后端逻辑——本次仅在设计上兼容，不编码实现。

## 14. 验收记录（2026-10-05）

验证环境（真·解耦部署，不是把 dist 塞回 Java）：`frontend/Dockerfile` 在当前提交上构建出 nginx 镜像，`SHIPDESK_API_UPSTREAM` 指到本机新起的后端实例；后端用 `sh ./mvnw spring-boot:run`（跑 `target/classes`，即 T6.1 之后的代码），数据目录用 `CLOUDOPS_DATA_DIR` 隔离，不碰共享库。

| 实例 | 前端 | 后端 | 模式 |
| --- | --- | --- | --- |
| 验收栈 | `127.0.0.1:5181`（容器 `shipdesk-web-acceptance`） | `127.0.0.1:8851` | `CLOUDOPS_FORCE_MOCK=1` |
| 真实模式对照 | `127.0.0.1:5182`（容器 `shipdesk-web-real`） | `127.0.0.1:8852` | 不设 FORCE_MOCK |

### 14.1 六项实盘结果

1. **静态站独立于 8848 + `/api` 代理**：`GET :5181/` 200、SPA 深链接 `GET :5181/flows` 200、`GET :5181/api/capabilities` 经代理 200；容器 `index.html` 引用的产物哈希与当时 `npm run build` 的 `dist/` 一致——首轮为 `index-C3Hq7u88.js` + `index-Cp1mQqdr.css`，末轮（镜像重建后）为 `index-9v_3fWf4.js` + `index-Cp1mQqdr.css`。整轮验证没有用到 8848。
2. **后端不再接管页面**：`GET :8851/` → **404**，`GET :8851/healthz` → 200，`GET :8851/favicon.ico` → 200（T6.1 只删静态挂载与根回落，健康检查与图标按约定保留）。
3. **I1 模式徽标**：8851 `/api/capabilities` = `{"effective_mode":"mock","force_mock":true,"mock_notice":"已设置 CLOUDOPS_FORCE_MOCK=1，节点操作全部以模拟模式执行"}`（**该 `mock_notice` 文本在 2026-10-07 改为「节点与 K8s 操作全部以模拟模式执行」**，因为强制模拟从此也短路 K8s 通路；此处保留当时抓到的原值）→ 5181 徽标「模拟模式（已强制模拟）」；8852 = `{"effective_mode":"real","force_mock":false}` → 5182 徽标「真实模式」。徽标只读 `effective_mode`/`force_mock`，不看环境变量。见 `docs/screenshots/react/04-…`、`15-badge-real-mode.png`。
4. **三模式阶段数**：`GET /api/catalog/{mode}` 实测 install=**7**、upgrade=**5**、upgrade_k8s=**6**；前端 rail/面板阶段标题与后端目录逐值一致（E2E「模式目录与后端一致：对话框只给三种模式，非法 mode 被拒」与「向导骨架：6 阶段与必经/可跳过标注」）。
   **本条是 2026-10-05 的快照，现已被 `2026-10-06-k8s-only-flow-bundle-upload-design.md` 取代**：`upgrade` 模式退役，目录只剩 install=7 / upgrade_k8s=**7**（新增「上传软件包」），两条用例的标题相应改为「只给两种模式」与「7 阶段」。
5. **I2 门禁 + I4 流式日志**：install 全流程 E2E 在验收栈上走通，落库事实 `status=succeeded progress=7/7 stages=passed×7`；upgrade_k8s `progress=6/6 stages=passed×5,skipped`（回滚预案为可跳过）。locked 阶段既不可进入也不可执行（独立回归用例）；阶段日志经 SSE 流式到达，通过后下一阶段自动解锁。控制台守卫**零过滤**，`requestfailed=0`。
6. **I3 `_package_ids` 复跑不丢**（对新后端的一次性运行时探针，探针数据建完即删；计划里字面那条也照做了）：
   - 真上传后服务端回填 `package_upload.inputs._package_id="af1723bff81d"`、`_package_ids=["af1723bff81d"]`；
   - 阶段通过后，按前端的合并语义（`{...stage.inputs, ...collected}`）重提交一次：`_package_ids` **仍是 `["af1723bff81d"]`**，而同一次提交里 `package_version` 已改成新值——保留键与用户编辑互不干扰；
   - **回到「环境登记」重提交并重跑**（后端允许对已 PASSED 的阶段再 run，返回 `{"status":"running","ok":true}`）：`package_upload` 仍为 `passed`，`_package_ids` 一字不变；
   - 下一阶段 `package_distribute` 用这份留存输入跑到 passed 并回填 `_distribution_id="141e01ed9ebc"`。
   - 顺带确认这条契约**失败会响**：后端按提交体校验，提交里丢掉 `_package_id` 直接 422「尚未上传任何安装包」，不会静默放行。
   - 该探针是临时 node 脚本直接走 `/api`（真 multipart 上传 → 提交/校验/执行 → 删除自建数据，验完 8851 只剩种子数据），不在仓库留档；同一份合并语义的常驻断言在 `formValue.test.ts` 与 `StagePanel.test.tsx` 的重提交用例里。

### 14.2 门禁命令与输出

| 命令 | 结果 |
| --- | --- |
| `npx vitest run` | 32 个文件 / **344 个用例全绿**（17.0s）—— 2026-10-05 那轮是 34 文件 / 383 用例，差额来自 §15 删掉的集群页与其工具模块测试 |
| `npx tsc -b` | 无输出（app project 带 `noUncheckedIndexedAccess`，test project 全量 src+e2e） |
| `npx eslint src e2e` | 无输出 |
| `npm run build` | `index.html 0.45 kB`、`index-LDaOFfxr.css 16.79 kB (gzip 4.23)`、`index-Ci4TksmM.js 406.07 kB (gzip 127.22)`；`dist/` 里没有任何 `.map`（§15 之前是 `index-9v_3fWf4.js 414.73 kB / gzip 129.71`） |
| `SHIPDESK_WEB=http://127.0.0.1:5174 npx playwright test --headed --retries=0` | 18 用例 / 5 文件：**18 passed（1.2m）**，走 Vite dev server（活源码，代理到 8851 新 jar） |
| `SHIPDESK_WEB=http://127.0.0.1:5181 npx playwright test --headed --retries=0` | 同一套 18 用例，走**重建后的 `shipdesk-web:acceptance` 镜像**（容器 `index.html` 已确认引用 `index-Ci4TksmM.js`）：**18 passed（1.2m）**，`--retries=0` 零失败；nginx 侧 505×200 / 2×400（用例自己打的门禁）/ 1×499（SSE 被客户端主动断）/ 1×500（伪造的 `…deadbeef` upload id），本轮零 504/502。历史上 2026-10-05 的三连跑（19 用例）= 第 1 轮 18 passed + 1 failed（`upgrade-flow.spec.ts:69`，nginx 日志同一秒两条 504 建连超时正对着它，见 14.3）、第 2/3 轮 19 passed |

### 14.3 未验证与已知限制（不留空）

- **后端测试是空的**：`backend-java/src/test` 不存在，`sh ./mvnw test` 报 "No tests to run" 仍 BUILD SUCCESS。计划里「跑后端测试」这一步实际无内容，本轮前端契约靠 E2E 与运行时探针兜。
- **`mvn package` 没跑**：8848 上的既有 `java -jar cloudops-console-2.0.0.jar`（PID 28228）持有 `backend-java/target/cloudops-console-2.0.0.jar`，Windows 文件锁会让打包失败；后端改动改用 `spring-boot:run` 从 `target/classes` 实测。
- **8848 现在是旧代码**：那个 jar 早于 T6.1，对 `/` 仍返回 200。它是历史遗留实例，不能作为当前交付的验收对象。
- **未知 `upload_id` 给的是 500 而不是 404**：`UploadService.status()`（`:109-113`）对认不出的 id 抛 `RuntimeException`，落到 Spring 默认错误体（`{"timestamp","status":500,"error":"Internal Server Error","path"}`，没有 `detail`）。前端不依赖这个状态码 —— `useChunkedUpload.ts:150-153` 是 `catch { clearSession(key) }`，任何失败都当「会话没了」作废本地记录、重开新会话，所以续传不会因此出错；E2E 也只断言非 2xx。要改的是后端语义（该回 404 + `detail`），属另一轮。实测：本轮 nginx 日志里 3 条 500 全部来自用例自己伪造的 `…deadbeef` id。
- **宿主层抖动（不是代码回归）**：nginx 侧统计本轮 3671 条 `/api` 请求中 18 次 504（`timed out (110: Operation timed out) while connecting to upstream`）、2 次 502（`failed (111: Connection refused) while connecting`），全部落在**建连阶段**；同一 flow id 4 秒后重试即 200，TanStack Query 自动恢复，业务结论不受影响。同一套用例走 Vite 的 Node 代理（5174）以及打**改造前的旧 jar**都能复现，之前还抓到过一次 `uct=35.7s` 的建连耗时——判定为 Docker Desktop 网络 + 3 个 headed Chromium + 2 个 JVM 的争用。已做的缓解：`proxy_connect_timeout 15s`（不再让浏览器空等 60 秒才知道后端不可达）与 `retries: 1`（失败那次的 trace/截图仍留在报告里，flake 本身可见）。
  - 2026-10-05 在重建后的前端镜像上重测三连跑：nginx 侧 1377 条 `/api` 请求 = 1298 × 200、6 × 400（用例自己打的门禁，属预期）、3 × 499（客户端主动断，SSE 接管路径）、3 × 500（见下条）、**2 × 504**（同一秒的两条 `GET /api/flows/{id}` 与 `…/stages/env_register/logs`，正对着首轮失败的那条重用例），后两轮零 504 —— 量级比上一轮小得多，结论一致：建连超时是宿主争用，不是代码回归。
- ~~**K8s 真实回滚未验**：本机没有 helm，`helm rollback` 分支跑不了；E2E 覆盖到「升级流程走通 + 回滚预案被跳过」。~~
  **2026-10-07 已真实验证**（在独立命名空间 `shipdesk-verify`，`cloudops` 全程未被触碰）：
  `POST /api/flows/150c5c1fb4fe/rollback` 空 body → `{"ok":true,"data":{"stdout":"Rollback was a success! Happy Helming!\n"}}`，
  `helm history` 从 `3 deployed` 变成 `3 superseded` + `4 deployed / Rollback to 2`；审计落 `flow.rollback … ok`。
  不存在的 revision（`{"revision":99}`）→ `{"ok":false,"error":"…release has no 99 version…"}`，审计如实落 `failed`。
  `K8S_OPS` 脚本路径依赖进程工作目录（`k8s-ops/dist/index.js` 相对路径），换目录启动会找不到脚本 —— 这条限制仍在。
- **Playwright 需要 `--headed`**：本机没有 headless shell；`playwright.config.ts` 的 baseURL 默认值在这台机器不可用（5173 属于另一个项目 FluxMES，ShipDesk dev 在 5174），验证一律显式传 `SHIPDESK_WEB`。
- **并发是后端的既有约束**：`Store` 只有一条共享 SQLite 连接（`synchronized conn()`，无 `busy_timeout`、无显式事务），所有 DB 访问串行；高并发下会放大上面的建连排队。本轮未改，属后端设计约束记录。
- **退役遗留已清理**：`docs/screenshots/` 根目录那 21 张 2026-09-29 的旧 Jinja/HTMX 界面截图（01~21）经确认后已删除（`git rm`，历史里仍可取回）。该目录现只有 `react/` 的 17 张新图。

### 14.4 截图（`docs/screenshots/react/`）

`01`~`05`、`08`~`15` 在 5181/5182 验收栈上实拍；`06`、`07` 与 `16`~`18` 是 K8s-only 改造后（2026-10-06）在 dev server 5176 → 后端 8858 上重拍/新增的。

| 文件 | 内容 |
| --- | --- |
| `01-packages-upload-inflight-cancellable.png` | 分片进行中：进度、可取消、会话可续传 |
| `02-packages-chunked-9-chunks.png` | 64 MiB 阈值以上 → 1 次 init + 9 片 + complete |
| `03-packages-single-request.png` | 阈值以下 → 单次 multipart，零分片请求 |
| `04-flow-wizard-install-7-of-7-passed.png` | install 向导 7/7 全通过 + 阶段日志 + 「模拟模式（已强制模拟）」徽标 |
| `05-flow-wizard-gate-locked-stage.png` | I2 门禁：locked 阶段置灰不可点 |
| `06-flow-wizard-upgrade-k8s-skeleton.png` | upgrade_k8s 骨架：**7 阶段**、第 2 格就是「上传软件包」（必经）、必经/可跳过标注、K8s 专有表单；除第 1 格外六格全带 🔒 不可点（I2 门禁） |
| `07-new-flow-dialog-mode-catalog.png` | 新建流程对话框：**两种模式**（全新安装 / K8s Helm 升级）与各自的「7 阶段」提示是前端固定词表（`labels.ts:85-88` `MODE_OPTIONS`），**不是**从后端目录拉的 —— 后端没有枚举模式的端点；创建出来的流程其阶段与表单 schema 才来自后端。背景列表里那条 `probe-upgrade` 是退役模式的遗留记录：`modeLabel` 对未知模式原样回显 `upgrade`，不编造中文名 |
| `08-flow-wizard-k8s-rollback-skipped.png` | 回滚预案被跳过的终态 |
| `09-page-overview.png` ~ `13-page-backups.png` | 总览/环境/流程/安装包/备份五页。`09` 已在 §15 之后重拍（导航只剩五个页签），其余仍是 2026-10-05 那一轮的原图；原 `14-page-k8s-clusters.png` 随集群页退役删除 |
| `15-badge-real-mode.png` | 5182 → 8852：`effective_mode=real` 时徽标为「真实模式」 |
| `16-flow-wizard-k8s-bundle-unpack-log.png` | 离线包解包实录（5176 → 8858）：第 3 步「解包离线 bundle」输出解包目录、`chart shipdesk-e2e-1.2.3-e2e.tgz（shipdesk-e2e 1.2.3-e2e）`、`values values.yaml`、镜像 1 个只登记不导入、目标版本与包内一致、已注入「执行升级」的 chart 绝对路径；阶段通过后第 3 格解锁 |
| `17-flow-wizard-k8s-readonly-chart.png` | 「执行升级」表单：`chart` 只读回显解包出的绝对路径，helper 写明「由「上传软件包」阶段解包后注入，不可编辑」（DOM 里 `readonly` 属性在位），其余字段照常可编辑 |
| `18-flow-wizard-k8s-bad-bundle-failed.png` | 不合规包（只有 `images/` 与 `values.yaml`、无 chart）：前两步成功、第三步「解包离线 bundle」失败，阶段结论 `失败 · 必经`，横幅与日志都完整打出目录约定并列出本包顶层条目；按钮变「重试此阶段」，后续阶段仍锁定 |

### 14.5 安全加固（2026-10-05，代码审查后补）

- **`k8s-ops` 不再经 shell 起进程**：`config.ts` 的 `exec(cmd, args[], opts)` 改为 `spawn` + argv 数组，`helm.ts` / `backup.ts` / `pod.ts` 全部按参数数组调用。原因是 `namespace`、`release_name`、`chart`、`workload` 都是用户在阶段表单里填的字符串（当时还有集群登记页也能填），拼成一条命令字符串就等于把命令构造权交给输入值。
- 实测（首轮在 helm 未安装的机器上做的，2026-10-07 装了 helm 后复验，证据见下）：
  - `exec('node', ['-p', 'JSON.stringify(process.argv.slice(1))', '&', 'echo', 'INJECTED', '>', <临时文件>])` → `stdout=["&","echo","INJECTED",">","…"]`，标记文件未生成；
  - `{"action":"helm.list","namespace":"default& echo pwned > <临时文件>"}` → 当时是 `{"ok":false,"error":"helm 启动失败: spawn helm ENOENT"}`（旧版会经 cmd.exe 把命令拆开）。**这条当时是靠 ENOENT 反证的，说服力弱**；
    本机装上 helm 后复跑同一个 payload → `{"ok":false,"error":"Error: list: failed to list: invalid namespace \"default& echo pwned > …\": [may not contain '/']\n"}`，
    标记文件同样没有生成 —— 整串留在**一个** argv 元素里、由 helm 自己拒收，这才是命令构造权没有外移的正面证据；
  - `{"action":"backup.volume_snapshot","namespace":"default\\napiVersion: evil"}` → 拒绝并原样回显该值；`pvc_name="../evil"` 同样被拒；
  - `{"action":"backup.list_pvc","namespace":"default; id"}` → `{"ok":true,"data":{"pvcs":[]}}`，分号之后的内容留在同一个 argv 元素里。
- **清单与落盘文件名**：拼进 VolumeSnapshot YAML 的 `namespace`/`pvc_name`/`snapshot_class` 先过 DNS-1123 标签校验；`backup.export_values`/`export_manifest` 的落盘名把 `release_name` 中字符集外的字符换成 `_`，挡住 `../` 写到 `backup_dir` 之外。
- **上传落盘名**：`POST /api/packages/upload` 与分片上传共用同一套净化规则（`[^a-zA-Z0-9._-]` → `_`）。实测 `../../escaped-_.tar.gz` 落成 `packages/6eb5f20e518f-.._.._escaped-_.tar.gz`，`packages/` 之外没有新文件（探针包已删）。
- **代价（如实记录）**：Windows 上需要真正的 `.exe`，`helm.cmd` / `kubectl.cmd` 这类垫片不经 shell 就起不来；生产镜像是 Linux，不受影响。
- **备份阶段的 shell 拼接已按人工决策加固（2026-10-05）**：`StageExecutor.java:977`（`tar czf …` + 用户填的 `include_paths`）与 `:1029`（`mysqldump`/`pg_dump` 拼 `include_databases` 的库名）原来直接把输入拼进命令串。现在：
  - `Workflow.validateStageInputs` 对备份阶段逐元素设防（`checkBackupPath` / `checkBackupDatabase`，规则与既有的 `remote_dir` 同源 —— 「该值会拼入远程命令」）。任何模式下都拒绝 `; | & $ ( ) < > 反引号 引号 空白 反斜杠`、以 `-` 开头、含 `..`；关通配符时只放行 `[A-Za-z0-9._/-]`，开通配符时额外放行 `* ? [ ] ~`。库名 `[A-Za-z0-9][A-Za-z0-9._-]*`，**只拒不改值**（`ApiController.java:743` 的恢复按 `base.resolve(n.hostname)` 重新配对，静默改名会让恢复对不上）。
  - 新增表单开关 `include_paths_allow_glob`（两个备份阶段都有，默认 `false`），配套 `BackupPoint.includePathsAllowGlob`；执行时默认逐项过 `NodeService.shellQuote`（远端不再展开），显式开启才按原样拼接以保留 `/etc/app/*` 的行为。库名一并加引号。
  - `childOf(base, name)`：主机名也来自用户录入的节点表，`backupDir.resolve(n.hostname)` / `snapDir.resolve(...)` 三处先归一化再断言仍在基目录内，越界直接 `StageFailure`（mock 分支把库名当文件名那条本地路径面一并被覆盖，因为落盘目录与文件名都要过门禁）。
  - 实测（自建 mock 后端 8851，`POST /api/flows/{id}/stages/pre_install_backup/validate`，探针 `probe/backup_validate_probe.py`）：12 条用例全部符合预期 —— `/etc; rm -rf /`、`/etc/$(whoami)`（即使开了 glob）、`/etc | tee /tmp/x`、`/etc /var`、`-rf`、`/etc/../../root`、`appdb|curl evil`、`--no-headers` 全部被拒并给出具体的那一条值；`/etc`、`/var/lib`、`/opt/data` 与 glob 开启下的 `/etc/app/*`、`/var/lib/app?/data`、`app_db`、`app-db.v2` 全部放行。另确认两个备份阶段的 `form_fields` 里真的带上了 `include_paths_allow_glob`（`type=boolean`、`default=false`），前端无需改渲染。
  - **代价（如实记录）**：默认不再展开 glob —— 之前能写 `/var/lib/mysql/*` 的人会突然被告知字符非法，界面上得去勾那个开关；`~` 与带空格的路径（`/opt/my data`）在两种模式下都进不去，这是白名单的既有取舍，与 `remote_dir` 一致。真实 SSH 分支（`tar`/`mysqldump` 实际落命令）本机没有可达节点，未端到端跑过，只验到门禁层。

### 14.6 R2 复核小项（2026-10-05）

- **词表回退不留空单元格**：`Backups.tsx` 原来直接 `BACKUP_KIND_CN[b.kind]`。词表按 `BackupKind.java`（只有 `pre_install` / `pre_upgrade`）建，但页面上拿到的是从库里读回的字符串，溢出时那一格渲染 `undefined` 就是空白。改为 `backupKindLabel(kind)`，口径与 `StatusTag` 的 `MAP[kind][value] ?? value` 一致；安装包页的 `KIND_CN[p.kind] ?? p.kind` 早就是这个写法。
- **空校验和不谎称已复制**：`PackageEntry.java:18` 的 `checksum` 默认 `""`，点「复制校验和」会把空串写进剪贴板再报「校验和已复制」。现在先判空，给「该安装包没有校验和」。
- **改完数据要失效总览**：`/api/overview` 是一份聚合计数（`ApiController.java:837-848`：环境数、流程数与状态分布、安装包数与体积、备份数与体积），而 `queryClient` 的 `staleTime` 是 5s，此前没有任何 mutation 失效 `qk.overview` —— 删完包/建完环境切回总览，最多 5 秒里仍是旧数字。现在 `useCreateEnv` / `useDeleteEnv` / `useCreateFlow` / `useDeleteFlow` / `useDeletePackage` 五个 mutation 走同一个 `refresh(qc, scope)`，除各自列表外一并失效总览。（当时还有一句「K8s 集群不进总览，那两个 mutation 不动」——那两个 mutation 已随 §15 删除。）
  审查建议里还提到「删包要顺带失效流程详情里的 `_package_ids`」，核实后不成立：`store.deletePackage(pid)`（`ApiController.java:643-646`）不碰阶段 `inputs`，重取流程详情拿到的还是同一份 id；而向导页那颗 `PackageChip` 走 `usePackage(id)`，它派生自 `qk.packages`（`queries.ts:78-81`），包列表一失效它就已经刷过了。
- **续传文案带上前提**：会话登记在 `UploadService.java:37` 的内存 `ConcurrentHashMap`，分片字节虽在磁盘 `data/packages/.tmp/{uploadId}/`，但后端重启后 `upload_id` 一律不认（`status()` 抛异常，前端据此作废本地记录、退回全新会话）。所以取消 toast 从「重传同一文件可续传」改成「服务不重启的话重传同一文件可续传」，安装包页 Card sub 补「后端重启过则从头再传」。
- **回归位**：新增 `frontend/src/hooks/queries.test.tsx`（6 用例：五个 mutation 的双失效 + 请求失败时一次都不失效）、`labels.test.ts` 的词表溢出用例、`Backups.test.tsx` 的溢出 kind 行、`Packages.test.tsx` 的空校验和与续传前提用例。单测从 33 文件 / 372 用例涨到 **34 文件 / 382 用例**（这一数字是该批次的快照；其后 §14.8 的自动推进回归与审计加载态 +3、死代码清理 −2，末轮总量为 **383**）；`tsc -b`、`eslint src e2e`、`npm run build` 与 5 规格 / 19 用例 Playwright（`SHIPDESK_WEB=http://127.0.0.1:5174 --headed`）全绿。

### 14.7 审查建议的取舍（逐条交代，不留暗账）

采纳的：`k8s-ops` 去 shell（§14.5）、落盘名净化（§14.5）、列表错误态不再伪装成空/加载中、`upgrade` 模式的后端死路（§6 例外，`db36982`）、§14.6 全部四条。

**未采纳的，连同理由**：

- **加 CI（GitHub Actions / Jenkinsfile）**：本轮没有任何 CI 配置，仓库里也没有，加一份等于替团队决定流水线形态与 runner 镜像，且我无法在本机验证它在 CI 环境里真的绿。门禁改由「显式命令 + 期望输出」写进 §14.2，谁来接 CI 都能照抄。
- **重新生成 `package-lock.json`（含换 registry）**：本机走的是 npmmirror 源，重写 lockfile 会把每个包 `resolved` 的 URL 一起改掉，别人在官方源上反而装不动。现状能装能构建，不在交付轮里动依赖解析。
- **`playwright.config.ts` 里用 `webServer` 自动拉起被测栈**：`webServer` 只能管 Playwright 自己 spawn 的进程，而被测栈是「nginx 容器（`SHIPDESK_API_UPSTREAM` 指后端）+ 一个带 `CLOUDOPS_FORCE_MOCK=1` 的后端实例」，端口（5181/8851）在本机已被既有实例占用，自动化拉起会跟它们抢端口并打死别人的进程。实际执行方式是显式 `SHIPDESK_WEB=… npx playwright test`，nginx 静态站这层**已被真实覆盖**（§14.2 的 5181 三连跑），缺的只是「一条命令从零起栈」的便利，记为已知缺口而非缺陷。
- **删掉 30848 那个裸 API Service / 把前端并进同一个 Service**：30848 已有消费方（`backend-java/e2e_test.py` 的 `BASE` 写死 `http://127.0.0.1:8848`，走的就是这条裸 API 通路；README.md:310 记录了它），删它是破坏性变更；前端另立 30880（§6）是叠加式改法。
- **后端三个探针从 `/healthz` 改成 `/`**：探针要验的是后端自己活着，而 T6.1 之后 `/` 上已经没有页面了（只有 404）。前端镜像的探针才打 `/`，理由记在 `k8s/web-deployment.yaml` 的注释里。
- **让分片续传扛得住后端重启（把 `upload_id` 会话落盘）**：那是 `UploadService` 的存储层改造（内存 `ConcurrentHashMap` → 持久化 + 过期清理），会动到后端业务语义，超出「前端重写 + 对齐现有能力」的边界。本轮做的是**让文案不再夸大**（§14.6 第四条），边界写清楚：防客户端掉线，不防后端重启。
- **未知 `upload_id` 该回 404 + `detail`**：同上，属后端错误语义，已单独记在 §14.3，前端行为不受影响。
- **删包顺带失效流程详情**：核实后不成立，见 §14.6 第三条的引用链。

**两项决策已定（2026-10-05 由用户确认）**：

1. **`StageExecutor.java:936` / `:986-988` 的拼接策略**（§14.5 末条）。已核实：`include_paths` 与 `include_databases` 从 `POST /flows/{id}/stages/{key}/inputs` 进来到拼进远程命令，**中间零元素校验** —— 后端 `Workflow.java:678-685` 只查「整体非空」，`asStringList`（`Workflow.java:730-749`）只 trim 丢空；前端是 `textareaField` + `multiline_list`（`Workflow.java:214-215`、`frontend/src/flow/FieldRenderer.tsx:167-179` 裸 `<textarea>`），没有任何 `pattern`。同一文件里 `remote_dir` 反倒是双重设防（绝对路径 + `[A-Za-z0-9._/-]`，`Workflow.java:666-669`，注释「该值会拼入远程命令」），所以仓库自己的惯例是存在的。三条路：① 照 `remote_dir` 上白名单——最省事，但会**拒掉合法 glob**（`*`、`?`、`[...]`），而这正是「备份 /etc/app/\*」这类输入的自然写法；② 走 `NodeService.shellQuote`（`NodeService.java:48-50`，安装脚本路径已用，`StageExecutor.java:1086-1087`）逐元素加引号——注入面关掉，但 glob 会被引号抑制，远端不再展开，**行为对用户可见地变了**；③ 加一个 `allow_glob` 开关，默认加引号、显式开启时按现有方式裸拼并只禁 `;`、`&&`、`|`、`$`、反引号、换行。**选定：②+③ 的组合** —— 默认逐元素 `shellQuote` 并始终禁控制字符，新增 `include_paths_allow_glob` 开关显式开启时裸拼以保留远端展开；库名走字符白名单（不改值、只拒，因为 `ApiController.java:743` 的恢复按 `base.resolve(n.hostname)` 重新配对，任何「静默净化/改名」都会让恢复对不上）。附带那条同源发现一并处理：mock 分支把库名当文件名用（`StageExecutor.java:979-983` 的 `dumpDir.resolve(db + ".sql.gz")`，零净化），改法是**校验库名 + 落盘后断言路径仍在 `backupDir` 内**，而不是改名。**已实现**，行为与代价见 §14.5。
2. **`docs/screenshots/` 根目录那 21 张 2026-09-29 的旧截图**（01~21，Jinja/HTMX 界面）：已确认全仓库无任何 markdown 引用，被 `docs/screenshots/react/` 的 15 张新图整体取代。**选定：删掉**，已执行（见 §14.3「退役遗留已清理」）。


### 14.8 终审分诊（2026-10-05，逐条给结论，不照单全收）

整枝终审提了 4 条 + 若干文档口径问题。处理结果分三类：

**改了代码的（2 条）**

- **总览页审计表把「还在取数」说成「没有记录」**：`useOverview` 与 `useAudit` 是两个独立查询，总览先落地时那一行渲染 `暂无审计记录`。现在 pending 渲染「加载审计记录…」（`Overview.tsx:118-124`），只有 `!isLoading && !isError && 数组为空` 才说「暂无」（`:125-131`）。回归位 `Overview.test.tsx`「总览先到、审计还在路上」。
- **`stage_done` 的自动推进其实是个空转**：`useFlowRunner.ts` 旧实现同步读 `qc.getQueryData(qk.flow)` 再 `refresh()` —— 那一刻缓存里还是阶段结束前的快照，`next` 取不到，于是 §5.1 承诺的「随后自动把焦点挪到下一个 ready/failed 阶段」多数情况下静默失效。现在推进挪到 `refresh()` 的 promise 之后（`useFlowRunner.ts:151-158`），并再用 `activeKeyRef` 复核用户是否还停在原阶段。两条回归位：一条真实挂载 `useFlow` 让失效触发重取（旧实现在这里必然空转），一条覆盖「等重取期间切了阶段」。

**核实后不成立的（2 条）**

- **「每个 SSE 连接泄漏一个线程」**：`ApiController.streamStage` 每条连接 `Executors.newSingleThreadExecutor()` 是一次性的，落到本地变量后没有强引用；JVM 的 `ThreadPerTaskExecutor` 是 `FinalizableDelegatedExecutorService`，finalize 时真的会 `shutdown()`。实测探针（`probe/PoolLeakProbe.java`）：建 20 个这样的执行器后 `pool-*` 线程数 20，强制 GC + finalize 之后 **0**；验收栈上 `jcmd <pid> Thread.print` 在多条 SSE 连接来回之后也没有任何 `pool-*` 线程（只有 http-nio / container-0 / GC 那几类）。所以不改代码 —— 但这条判断值得留在这里，因为「看得见线程看不见释放」在静态审查里完全合理，是靠实测否掉的。
- **「CORS 通配符 + allowCredentials 要收紧」**：`WebConfig.java:13-20` 这个配置**与 `main` 完全一致**（`git show main:backend-java/src/main/java/com/cloudops/config/WebConfig.java` 逐字相同），不是本轮引入的回归；而且后端整体没有任何鉴权（没有 `SecurityFilterChain`、没有 `HttpSession`、没有 Cookie 语义），通配符在当前形态下不构成越权通路 —— 真正的暴露面是「整个控制台无鉴权」，那是后端另一轮的事。留一句结论给下一轮：等加了鉴权，`allowCredentials(true)` 与 `allowedOriginPatterns("*")` 必须同时收紧，只改 `allowCredentials(false)` 会让带凭据的跨源请求静默失败。

**文档口径纠正（不在代码里，但同样是账）**

- §3 的端点清单原先按「消费的端点」列，实际 `GET /api/catalog/{mode}` 只有 E2E 在用、`GET /api/flows/{id}/distributions` 前端根本没用 —— 已就地标注。
- §4 文件树里的 `useCatalog.ts` / `useCapabilities.ts` / `useFlow.ts` / `useStageRunner.ts` 是设计期草图，落地是 `queries.ts` + `useFlowRunner.ts`；已按实现改写。
- README 说「新 `mode` 落地不需要动前端结构」过头了：模式清单是前端固定的 `MODE_OPTIONS`（`labels.ts:85-88`），后端没有枚举模式的端点；已改成「向导不动，加模式改这个词表」，§14.4 图 07 的说明同步纠正。
- 计划文档契约校正 12 说「锁定的阶段仍可点」，落地按 I2 改成了禁用态（`StageRail.tsx:17` + `:36`）；已就地校正。
- 死代码 `roleBreakdown`（`lib/summarize.ts`）只有自己的测试在消费，已删除，单测从 385 条落到 383 条。

## 15. 需求变更（2026-10-06）：K8s 集群登记页退役

用户判定：「升级这块是直接对接环境，这个 k8s 集群页签不需要」。核实后这条判断成立，且比看上去更彻底 —— 那张登记表**只有那个页面自己在用**：

- `StageExecutor.k8sCluster()`（`StageExecutor.java:1483-1489`）现场 `new K8sCluster()`，字段全部来自阶段 `inputs`（读不到就回退到 `env_register`），从不查库；
- `POST /flows/{id}/rollback`（`ApiController.java:859-876`）同样从 `env_register` 的 `inputs` 现场拼；
- 表单里那个 `cluster_id` 是自由文本，后端没有任何一处拿它去 `store.getCluster()`（§14 之前记在计划文档契约校正 17 ①，本轮据此确认删除是安全的）。

**删掉的**：前端 `pages/K8s.tsx` 与其测试、`components/k8s/NewClusterDialog.tsx`、`lib/k8sRelease.ts` 与其测试、`api/types.ts` 的 `K8sCluster`、`endpoints.ts` 的四个集群方法与 `qk.clusters`/`qk.releases`、`queries.ts` 的三个集群 hook、`TopBar` 的「K8s 集群」页签、`App` 的 `/k8s` 路由、`endpoints.test.ts` 的集群 URL 用例、`e2e/error-states.spec.ts` 的 `/k8s` 一行、`docs/screenshots/react/14-page-k8s-clusters.png`；后端 `POST/GET /api/k8s/clusters`、`GET/DELETE /api/k8s/clusters/{id}`、`GET /api/k8s/clusters/{id}/releases` 五个端点、`Store` 的 `saveCluster`/`getCluster`/`listClusters`/`deleteCluster` 与 `k8s_clusters` 建表 DDL。顺带收掉一个真实风险：那张表会把 **kubeconfig 原文**写进 SQLite，页面一删它就是只有写路径没有消费者的凭据堆放处。

**留下的，连同理由**：`model/K8sCluster` 仍是 helm/kubectl 调用的参数载体（`K8sOpsService` 与上面两处现场构造都要用）；`K8sOpsService.helmList` 仍被 `StageExecutor.java:1446` 的升级阶段调用（现经 `requireOk`，失败即 `StageFailure`），不是死码；`POST /api/flows/{id}/rollback` 与向导里的 `RollbackButton` 原样保留。

**`/k8s` 深链接**：改成 `Navigate to="/"`。不这么做的话旧书签会命中「Shell 渲染、内容区空白」——路由没有通配兜底，任何未匹配路径都是那块空白，而这恰好是本次被删掉的那条路径。

**遗留（已在本轮之后的 K8s-only 改造中清掉）**：当时 `cluster_id` 仍留在 `upgrade_k8s` 的 `env_register` 表单里，帮助文案还写着「已登记的集群 ID」——那个登记表已经不存在了，字段纯粹是流程记录里的一段自由文本。2026-10-06 那一轮把 `cluster_id` 与 `chart_repo` 一并从后端表单与前端类型里删除（见 `2026-10-06-k8s-only-flow-bundle-upload-design.md`）。既有 SQLite 里若已存在 `k8s_clusters` 表，DDL 删除只意味着新库不再建它，老库里的表和行不会被清理（也没有代码再读它们）。

**验证**：`vitest` 32 文件 / 344 用例全绿、`tsc -b` 与 `eslint src e2e` 无输出、`npm run build` 产物 `index-Ci4TksmM.js 406.07 kB (gzip 127.22)`；重建后的 `shipdesk-web:acceptance` 容器（`index.html` 已确认引用该哈希）与新编译的后端上，Playwright **18 passed**（5174 与 5181 各一轮，`--retries=0`）；`GET :8851/api/k8s/clusters` 与 `GET :5181/api/k8s/clusters` 均 **404**；浏览器实拍 `docs/screenshots/react/09-page-overview.png` 导航只剩五个页签。
