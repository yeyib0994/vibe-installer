# ShipDesk Console

**云化系统的安装 / 升级 流程编排工具**。把一个交付工程师脑子里那套"先填环境、再传包、再分发、备份好再动手"的隐性流程，做成显式的、可审查、可回退的阶段流水线。

产品名是 **ShipDesk Console**（前端标题就是它，`frontend/index.html:6`）。仓库里仍然留着 jar 名
`cloudops-console-2.0.0.jar`、Java 包名 `com.cloudops`、环境变量前缀 `CLOUDOPS_*` —— 那是改名前
留下的构建产物，同一套东西：换名要动 Maven 坐标和整个源码目录树，收益为零，所以保留，别当成两个系统。

核心设计取舍：**流程不是一堆按钮，而是一条有闸门的流水线。**
每个阶段有明确的输入表单、前置条件、执行步骤和产物。前一阶段没通过，后一阶段连"执行"按钮都是灰的 —— 避免"点了不该点的东西"这类最贵的事故。

---

## 为什么是阶段流水线

交付现场最常出的事故不是单个命令敲错，而是**顺序错**：

- 还没确认机器能不能连上就开始装包 → 装到一半发现 3 台机器 SSH 不通
- 升级前忘了建备份基线 → 升级失败，没有回滚点
- 控制节点登记成 2 台 → etcd 选主分裂

所以本工具的每一道闸门都对应一类真实事故：

| 闸门 | 拦的是什么 |
|---|---|
| 环境登记的表单校验 | IP 重复、控制节点偶数台、物理机缺型号/机房、虚机缺规格 |
| 环境校验 | SSH 不可达、SELinux 未关、NTP 不同步、关键端口被占、依赖命令缺失、ulimit 过小 |
| 包分发 | 传输损坏（逐节点比对 SHA256） |
| 备份阶段 | 备份范围为空 |
| 安装后验证 | 服务未起、端口未监听、版本不一致、集群成员缺失 |

---

## 七阶段安装流程

```
1 环境登记 ──► 2 环境校验 ──► 3 上传安装包 ──► 4 包分发
                                                  │
                          7 安装后验证 ◄── 6 执行安装 ◄── 5 安装前备份（可选）
```

| # | 阶段 | 必过 | 关键动作 |
|---|---|---|---|
| 1 | **环境登记** | ✔ | 按硬件类型分组录入节点矩阵 → 校验唯一性与完整性 → 生成节点清单落库 |
| 2 | **环境校验** | ✔ | 逐节点 SSH 探活并采集主机信息 → 系统预检（依赖/端口/磁盘/时间/SELinux/ulimit）→ 生成问题清单与修复建议 |
| 3 | **上传安装包** | ✔ | 接收文件流落盘（<64 MiB 单请求，≥64 MiB 走 8 MiB 分片续传）→ 分段记录校验和 → 计算整包 SHA256 → 登记包清单 |
| 4 | **包分发** | ✔ | 确认目标目录可写 → 按并发度推送（rsync 支持增量/续传，不可用时回落 scp）→ 逐节点比对 SHA256，不一致的节点进「需重传」清单并让任务停在 PARTIAL |
| 5 | **安装前备份** | 可选 | 确认备份范围 → 逐节点归档目录 → 数据库逻辑备份并回传 → 登记备份点、设置过期时间、生成回滚基线 |
| 6 | **执行安装** | ✔ | 分发前置检查 → 控制面组件 → 数据面组件 → 工作节点组件 → 网关组件（任一节点失败可停或继续汇总） |
| 7 | **安装后验证** | ✔ | 服务状态 → 端口监听 → 版本一致性 → 集群成员 → 接口冒烟 → 生成交付报告 |

**五阶段升级流程**：环境确认 → 环境校验（版本兼容性、磁盘余量、服务健康度）→ 升级前备份（必经，`required=true`，不给跳过）→ 执行升级（逐节点 drain → snapshot → 替换 → 迁移数据 → 重启 → undrain）→ 升级后验证。

**六阶段 K8s 升级流程**（`mode=upgrade_k8s`）：环境登记（集群 + 目标 Helm Release）→ 环境校验（节点层 Python 预检 + K8s 层 TS 健康检查）→ 升级前备份（values / manifest 导出 + PVC VolumeSnapshot）→ 执行升级（drain → `helm upgrade --install` → rollout 等待 → 迁移 → uncordon）→ 升级后验证（Pod 就绪、镜像版本、冒烟接口）→ 回滚预案（可跳过，只生成 `helm rollback` 命令清单，不执行）。

### 状态机

```
LOCKED ──(前一阶段 PASSED/SKIPPED)──► READY ──► RUNNING ──► PASSED
                                                      └──► FAILED ──(重新执行)──► RUNNING
                        READY/FAILED ──(仅 required=false)──► SKIPPED
```

闸门逻辑在 `backend-java/src/main/java/com/cloudops/engine/Workflow.java::refreshLocks`（:526-554），只有 `PASSED` / `SKIPPED` 算"通过"（:537），`RUNNING` / `FAILED` 都不会解锁下一阶段；已被锁住的阶段既不能填表也不能执行（`ApiController.java:263-264`、`357-358`）。重跑失败阶段是直接 `FAILED → RUNNING`：`StageExecutor.submit` 一进去就把阶段置为 `RUNNING`（`StageExecutor.java:92-96`），中间不回落 `READY`。跳过只允许 `required=false` 的阶段（`ApiController.java:381`）。

---

## 快速开始

后端是纯 API 服务，页面上任何东西都不再由它提供；控制台页面跑在 `frontend/` 的 Vite dev server 上。
两个进程各起各的：

```bash
# 后端：Java 21 + Maven wrapper，监听 0.0.0.0:8848（PORT 可覆盖）
cd backend-java && ./mvnw package -DskipTests && java -jar target/cloudops-console-2.0.0.jar

# 前端：另开一个终端
cd frontend && npm install && npm run dev
```

然后打开 **http://127.0.0.1:5173/**。`frontend/vite.config.ts:8-12` 定死了 `server.port=5173`、
`server.host=127.0.0.1`，并把 `/api` 代理到 `http://127.0.0.1:8848` —— 后端不在本机时用
`SHIPDESK_API=http://<host>:<port> npm run dev` 覆盖代理目标。

`8848` 上只有 `/api/**`、`/healthz` 和一个内联 SVG 的 `/favicon.ico`（`IndexController.java:12-27`），
**没有 `/docs`，也没有根页面**。首次启动若库为空会灌入示例环境（`CloudOpsApplication.java:24`，
`Seed.seedIfEmpty()`），演示即开即用。

### 真实模式 vs 模拟模式

节点操作由驱动层 `backend-java/src/main/java/com/cloudops/services/NodeService.java` 执行，
`getDriver(node)`（:401-407）逐节点选驱动：

- **真实模式** `SshDriver`（:225）：节点的 `ssh_key_path` 非空 **且** 本机找得到 `ssh` 与 `scp`
  （`sshAvailable()` :409-411）→ 通过 `ProcessBuilder` 调用**系统 ssh / scp / rsync**（:199-214、
  rsync 在 :281，失败回落 scp 在 :289）。刻意没有用 JSch / Apache MINA SSHD 之类的纯 JVM SSH 库 ——
  交付现场机器上通常已经配好了 `~/.ssh/config`、跳板机、known_hosts，复用系统 ssh 比在工具里
  重新实现一套认证方式可靠得多。
- **模拟模式** `MockDriver`（:324）：其余情况 → 输出带 `[MOCK]` 前缀，按节点 IP 的 md5 播种
  （`seed()` :330-340）生成**确定性**的主机信息，保证同一环境反复演练结果一致。
- **强制模拟**：设 `CLOUDOPS_FORCE_MOCK=1`（`forceMock()` :396-399）。演示机上装了 ssh 二进制但填的是
  假密钥时，不加这个开关就会被判成真实模式、一跑全不可达。

系统预检不在 Java 里做：Java 把节点信息拼成 JSON 喂给 `backend-java/scripts/precheck.py`
（`runPrecheckScript` :146-188），模拟模式的问题清单同样由它按 md5(IP) 播种（`precheck.py:111-121`），
检查项因此能独立增删。代价是运行环境里必须有 python3 —— 这几个脚本只依赖标准库，
镜像里装个 `python3` 就够了（`Dockerfile:39-43`）。

控制台右上角的模式徽标**以后端返回的「本次运行实际生效的模式」为准**（`/api/capabilities` 的
`effective_mode`，由「强制模拟 OR 本机缺 ssh/scp」共同决定，`ApiController.java:777-793`），
而不是单纯看本机有没有 ssh —— 本机有 ssh 但设了强制模拟时，只看 ssh 会显示成「真实模式」，
与实际执行的每一台模拟操作完全相反。前端只读 `effective_mode` 与 `force_mock`，明确不回落到
`ssh` 字段（`frontend/src/components/ModeBadge.tsx:17-18`）；强制模拟时徽标显示「模拟模式（已强制模拟）」，
`mock_notice` 作为 tooltip 说明原因。

---

## 前端独立部署

前端和后端是两个镜像，各自部署，浏览器只跟前端 nginx 说话。

- **后端镜像不再打包 UI**：根 `Dockerfile` 里没有 `COPY frontend`，产物只有 jar + python 脚本 +
  k8s-ops + kubectl/helm。根路径没有兜底路由（`IndexController.java:8`），`8848` 上不再有页面。
- **前端镜像**：`frontend/Dockerfile` 两段式 —— `node:22` 里 `npm ci && npm run build`，
  运行阶段 `nginx:1.27-alpine` 只提供 `dist/`。
- **SPA 回落**：`location / { try_files $uri $uri/ /index.html; }`，`/flows`、`/backups` 这类
  React Router 路径直接刷新也能开（`frontend/default.conf.template:51-53`）。
- **`/api` 反代**：`proxy_buffering off` 是必须的，否则阶段日志的 SSE 会被 nginx 攒着不发
  （`default.conf.template:16-30`）。
- **`/healthz` 建连只给 3s**（`default.conf.template:32-36`）：探针是给编排系统看的，
  后端拒接连接时要立刻报失败，而不是让 liveness 等到默认 60s 才判定。
- **请求体上限 128m**：前端 <64 MiB 走单次 multipart、≥64 MiB 才按 8 MiB 分片
  （`useChunkedUpload.ts:9-10`），所以真正的天花板是**单请求**那条路：63–64 MiB 的包加上 MIME 边界
  就超过 64m，会在 nginx 吃 413，故留到 128m（`default.conf.template:7-9`）。后端自己的
  `max-file-size` 是 2048MB（`application.properties:5-6`），远够不到 —— 部署时该看的只有这一行。
- **静态资源**：`/assets/` 带内容哈希，长期 `immutable`；`index.html` 一律 `no-cache`，否则旧壳指向
  新版里已经不存在的哈希产物（`default.conf.template:39-48`）；JS/CSS/JSON/SVG 走 gzip
  （`:11-14`，主包 414 KB、gzip 后约 130 KB —— 取 `npm run build` 的构建输出估算）。
- **生产不吐 sourcemap**：`frontend/vite.config.ts` 的 `build` 里没有 `sourcemap`，`dist/` 只剩
  `index.html` + `assets/`。静态站是被浏览器原样取走的，带上 `.map` 等于把 TS 源码公开。
- **上游可注入**：`proxy_pass http://${SHIPDESK_API_UPSTREAM}`，默认
  `cloudops-console.cloudops.svc.cluster.local:8848`（集群内 Service 全名，`frontend/Dockerfile:16`），
  本机联调时 `-e SHIPDESK_API_UPSTREAM=host.docker.internal:8848` 覆盖。写成字面量域名会让
  容器起不来 —— nginx 在解析配置阶段就做 DNS 解析，解析不到即失败。
- 模板必须叫 `default.conf.template`：官方镜像 envsubst 出的 `/etc/nginx/conf.d/default.conf`
  正好覆盖默认站点，否则两份 server 都 listen 80，反代与 SPA 回落都会被抢掉。
- **集群内落地**：`k8s/web-deployment.yaml`（`shipdesk-web`，`replicas: 2`，无状态静态层，与后端分开扩缩）
  + `k8s/web-service.yaml`（NodePort **30880** → 容器 80）。浏览器一律从这里进，页面与 `/api` 同源，
  不涉及 CORS；原来的 30848 那个 Service 仍在，但上面只有 `/api/**` 和 `/healthz`，**没有页面**。
  探针打 `/` 而不打 `/healthz`：后者会把后端可用性算进前端的 readiness，后端滚动时页面会整体不可达。
- **一键部署**：`k8s/deploy.ps1` 依次构建 `cloudops-console:3.0.0` 与 `shipdesk-web:3.0.0`，apply 八份
  清单，再 `rollout status` 两个 Deployment。本地镜像没有仓库前缀，所以两处 `imagePullPolicy` 都是
  `IfNotPresent` —— `Always` 会让 kubelet 去 docker.io 拉一个不存在的 `library/shipdesk-web`。

---

## 目录结构

```
shipdesk/
├── backend-java/                    唯一后端：Java 21 + Spring Boot（jar 名仍是 cloudops-console）
│   ├── src/main/java/com/cloudops/
│   │   ├── api/ApiController.java       ★ 全部 REST + SSE 端点
│   │   ├── config/                      IndexController（/healthz、内联 favicon）、WebConfig（CORS）
│   │   ├── core/                        Store（SQLite WAL + JSON 列）、Json、Seed（示例数据）
│   │   ├── engine/                      ★ Workflow（阶段定义 + 闸门 + 业务级校验）
│   │   │                                ★ StageExecutor（阶段执行 + 动作实现）、LogBus（SSE 总线）
│   │   ├── model/                       领域模型 + 枚举 + 请求 DTO
│   │   └── services/                    NodeService（SSH/Mock 驱动 + 预检调用）、UploadService（分片续传）、
│   │                                    BackupService、K8sOpsService、VersioningService
│   ├── scripts/                       4 个 Python 脚本，只依赖标准库，由 Java 进程调用
│   │   ├── precheck.py                系统预检（真实 / 模拟两条路都走它）
│   │   └── node_drain.py · node_stop_svc.py · node_uncordon.py
│   ├── e2e_test.py                    后端端到端冒烟（stdlib urllib，跑完 install 七阶段）
│   ├── pom.xml                        com.cloudops:cloudops-console:2.0.0
│   └── data/                          运行时生成：SQLite 库、上传的包、备份归档（已 gitignore）
├── frontend/                        React 19 + TypeScript(strict) + Vite + Tailwind，独立镜像部署
│   ├── tsconfig.base.json           共享 compilerOptions（含 strict）
│   ├── tsconfig.app.json            src + 各 config：额外开 noUncheckedIndexedAccess（下标即 T|undefined）
│   ├── tsconfig.test.json           src + e2e 全量：测试按下标取值是刻意的，不开上一条
│   ├── tsconfig.json                只做 `tsc -b` 的 solution，引用上面两个 project
│   └── src/
│       ├── api/                       client.ts（fetch + 错误）、endpoints.ts（端点表）、types.ts
│       ├── pages/                     Overview / Envs / Flows / FlowWizard / Packages / Backups / K8s
│       ├── components/                ui 基元 + env / flow / k8s / upload 分组 + Shell / TopBar / ModeBadge
│       ├── flow/                      DynamicForm、FieldRenderer、NodeMatrixEditor、StepList、
│       │                              LogConsole、StagePanel、StageRail、formValue
│       ├── hooks/                     queryClient、queries、useCapabilities、useStageStream、
│       │                              useChunkedUpload、useFlowRunner
│       ├── lib/                       format、labels、summarize、k8sRelease
│       └── test/                      vitest setup 与假 EventSource
├── k8s-ops/                         TypeScript CLI：后端 `node k8s-ops/dist/index.js` + stdin JSON
│                                    执行 helm / kubectl（K8sOpsService.java:24-38）
├── k8s/                             部署清单：namespace / configmap / pvc / rbac /
│                                    deployment + service（后端 30848，裸 API）/
│                                    web-deployment + web-service（前端 30880）+ deploy.ps1
├── docs/superpowers/                specs/ 设计文档 + plans/ 实施计划
└── Dockerfile                       后端镜像：maven 构建 → eclipse-temurin:21-jre 运行（不含 UI）
```

### 两个核心文件

- **`engine/Workflow.java`** — 声明式阶段定义（`buildInstallStages` / `buildUpgradeStages` /
  `buildUpgradeK8sStages`）。每个阶段带 `formFields`（前端据此动态渲染表单）、`steps`（动作列表）、
  `required`（能否跳过）。业务级校验 `validateStageInputs`（:573+）也在同一个类里，它检查的是**语义**
  而非"必填"：IP 是否重复、控制节点是否偶数（:629）、物理机是否缺机房。
- **`engine/StageExecutor.java`** — 阶段执行器。每个阶段在独立守护线程里跑（:109-112），逐步执行动作
  并通过 `LogBus` 把日志和步骤状态推给 SSE 订阅者。所有涉及节点操作的地方都经过 `NodeService` 驱动层，
  K8s 操作则下沉给 `k8s-ops` CLI。

---

## API

全部端点都在 `backend-java/src/main/java/com/cloudops/api/ApiController.java`（类级 `@RequestMapping("/api")`，
除 `/healthz` 与 `/favicon.ico` 外没有别的非 `/api` 路由）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/environments` | 环境列表（每项带 `summary`：节点数与物理/虚机配比）/ 创建 |
| GET/DELETE | `/api/environments/{id}` | 环境详情（带 `summary`）/ 删除 |
| POST | `/api/environments/{id}/nodes` | 批量追加节点 |
| DELETE | `/api/environments/{id}/nodes/{nodeId}` | 删除单个节点 |
| GET | `/api/catalog/{mode}` | 该模式的阶段目录（阶段 + 表单字段），前端据此渲染向导 |
| GET/POST | `/api/flows` | 流程列表（带 `progress`）/ 创建，`mode=install\|upgrade\|upgrade_k8s`（非此三者 400） |
| GET/DELETE | `/api/flows/{id}` | 流程详情（`env_summary`、`nodes`、`progress`）/ 删除 |
| POST | `/api/flows/{id}/stages/{key}/inputs` | 提交阶段表单（先校验后落盘） |
| POST | `/api/flows/{id}/stages/{key}/validate` | 只校验不落盘，供前端实时提示 |
| POST | `/api/flows/{id}/stages/{key}/run` | 执行阶段（异步，日志走 SSE） |
| POST | `/api/flows/{id}/stages/{key}/cancel` \| `/skip` | 取消 / 跳过（`required=true` 直接 409） |
| GET | `/api/flows/{id}/stages/{key}/stream` | **SSE** 实时日志与步骤状态；先重放历史（事件带 `replay: true`），终态推 `close` |
| GET | `/api/flows/{id}/stages/{key}/logs` | 历史日志快照（与 SSE 同构，不含 `close`） |
| POST | `/api/flows/{id}/rollback` | Helm 回滚（body `revision`，走 `k8s-ops`） |
| GET/POST | `/api/packages` | 包清单（带 `progress`）/ 手工登记一条包记录 |
| DELETE | `/api/packages/{id}` | 删除包 |
| POST | `/api/packages/upload` | 单请求 multipart 上传，服务端每 64 MB 记一段校验和 |
| POST | `/api/packages/upload/init` | 建续传会话，回 `upload_id` / `chunk_size` / `total_chunks` |
| POST | `/api/packages/upload/chunk` | 上传单个分片（`upload_id` + `chunk_index` + `file`） |
| GET | `/api/packages/upload/{uploadId}` | 续传进度：`done_chunks`、`uploaded_bytes`、`complete` |
| POST | `/api/packages/upload/{uploadId}/complete` | 合并分片、算 SHA256、登记包清单 |
| GET | `/api/flows/{id}/distributions`、`/api/distributions/{id}` | 分发任务列表 / 单条 |
| GET | `/api/backups`（`?envId=`）、`/api/backups/{id}` | 备份点列表 / 详情 |
| POST | `/api/backups/{id}/verify` \| `/restore` \| `/expire` | 校验；恢复（`confirm=false` 直接 428）；标记过期不可恢复 |
| GET | `/api/overview`、`/api/audit`、`/api/capabilities` | 总览 / 审计 / 能力探测（`ssh`、`rsync`、`force_mock`、`effective_mode`、`mock_notice`） |
| GET/POST | `/api/k8s/clusters` | 集群列表 / 登记 |
| GET/DELETE | `/api/k8s/clusters/{id}` | 集群详情 / 删除 |
| GET | `/api/k8s/clusters/{id}/releases` | 该集群的 Helm Releases（`helm list`） |
| GET | `/healthz` | 存活探针：`{"status":"ok"}`。`k8s/deployment.yaml:42-64` 三个探针与 `Dockerfile:66-67` 的 HEALTHCHECK 都只打它 |

错误语义是闸门的一部分，不只是状态码：`409` = 前置阶段未通过 / 阶段正在执行 / 必经阶段要跳过 / 备份目录已不存在，
`422` = 表单语义校验未通过（返回 `errors` 数组），`428` = 危险操作未显式确认。

续传的真实边界要说清楚：分片字节落在磁盘（`data/packages/.tmp/{upload_id}/chunk_{i}`），
但会话表只在进程内存里（`UploadService.java:37`）—— 后端进程一重启，旧 `upload_id` 就认不出来了，
客户端会把本地记录作废、重开一个会话（`frontend/src/hooks/useChunkedUpload.ts:150-153`）。
所以"断点续传"防的是客户端掉线，不防后端重启。

---

## 设计笔记

**为什么用系统 ssh 而不是 JSch / MINA SSHD** — 见上文"真实模式"。后端只做 `ProcessBuilder` +
`ssh` / `scp` / `rsync` 三个二进制（`NodeService.java:199-214`、`281`、`289`）。

**为什么备份校验和要把体积和节点名也算进去** — 模拟模式下磁盘上只有 `manifest.json`，
真实归档体积（每节点几百 MB）并不落盘，`size_bytes` 是按 md5(IP) 估出来的
（`StageExecutor.java:945-952`）。若只对实际文件做摘要，任何两个备份点的校验和都会一样，
`verify` 就失去意义。所以摘要额外吃进 `size_bytes` 与排序后的 `nodes_covered`
（`BackupService.java:41-46`），并且只此一处，登记与校验两边共用同一个算法。

**为什么 `env_register` 重跑不能清空节点** — 提交表单时 `env.nodes` 是按本次提交的物理/虚机列表
整批重建的（`ApiController.java:273-316`），空列表就意味着把节点全删了 —— 这是很危险的静默数据丢失。
现在由业务级校验先把住：一台节点都没提交直接 422「至少需要登记 1 台节点」
（`Workflow.java:600`），空表单根本落不了盘。

**为什么环境列表接口也要算 `summary`** — 环境列表页每行都要显示节点数与物理/虚机配比。
早期只有详情接口 `GET /environments/{id}` 会附带 `summary`，列表接口直接返回裸对象，
列表页的「节点数」列就永远是空的。两个接口现在都带这个字段（`ApiController.java:103`、`129`）。

**为什么模式徽标不能只看 ssh 是否存在** — `/api/capabilities` 返回 `effective_mode`，
由「强制模拟 OR 本机缺 ssh/scp」共同决定（`ApiController.java:777-793`）。演示机上 ssh 二进制是存在的，
只看 ssh 会把强制模拟的场景显示成「真实模式 · SSH 可用」，与每个节点都在跑模拟的事实完全相反 ——
这类"提示与实际执行不一致"的问题比没有提示更危险，会让人误以为看到了真实结果。
前端把这条不变量写死在 `ModeBadge` 里：只读 `effective_mode` / `force_mock`。

**为什么迁移场景暂时不在控制台里** — 当前版本聚焦"安装 / 升级"这条主线；跨环境搬迁需要
源端冻结、快照导出、目标端重建等另一套动作集，计划复用同一套阶段引擎，作为新的 `mode` 接进来。
这条路线已经写成设计（含验签、内嵌镜像仓、P2P 分发、扩容模式，以及流程定制化）：
`docs/superpowers/specs/2026-10-04-shipdesk-react-frontend-design.md` §11–§12。
落地不需要动前端结构：新 `mode` 的阶段与表单都通过 `GET /api/catalog/{mode}` 下发，向导按 schema 渲染即可。

---

## 验证

```bash
# 前端单测（vitest + @testing-library，jsdom）
cd frontend && npm run test:unit

# 前端类型检查 / lint（typecheck 走 tsc -b，两个 project：src 严格下标 + 测试全量）
cd frontend && npm run typecheck && npm run lint

# 浏览器端 E2E（Playwright，需先起后端，再起前端 dev server 或 nginx 静态站）
cd frontend && SHIPDESK_WEB=http://127.0.0.1:5174 npx playwright test --headed

# 后端端到端：对跑着的后端把 install 七个阶段走完一遍，逐步打印结果
python backend-java/e2e_test.py
```

`backend-java/e2e_test.py` 只依赖标准库，`BASE` 写死 `http://127.0.0.1:8848`（:7），
并且取列表里的第一个环境（:37-39）—— 先起后端，空库时 seed 会给出一个示例环境，直接能跑。
它上传一个假包、逐阶段 `inputs → run → 等终态`，任一阶段 `failed` 就打印出错步骤并停。

浏览器端 E2E 在 `frontend/e2e/`：**5 个规格 / 19 个用例**——安装全流程、原地升级五阶段
（含节点矩阵不少一台）、`upgrade_k8s` 向导与跳过回滚预案、分片续传与取消、以及错误态与门禁落地。
`playwright.config.ts` 固定 `workers: 1`、`retries: 1`，baseURL 默认 5173；本机 5173 属于另一个项目，
且没有 headless shell，所以验证一律显式传 `SHIPDESK_WEB` 并加 `--headed`。

---

## 技术栈

**后端**：Java 21 · Spring Boot（`spring-boot-starter-parent` 4.1.1）· SQLite（WAL + JSON 列，
单连接 + `synchronized`）· SSE（`SseEmitter`）· `ProcessBuilder` 调系统 `ssh`/`scp`/`rsync`、
`python3` 预检脚本、`node` 跑 k8s-ops

**前端**：React 19 · TypeScript(strict) · Vite 6 · Tailwind 3 · TanStack Query 5 · React Router 6 ·
Vitest + @testing-library（Playwright 待补）

前端不再是零构建单页 —— 但"交付现场改一行刷新即生效"这条没丢：开发期由 Vite dev server 的 HMR
承担，改完在 `npm run dev` 下直接可见；构建产物只是 `frontend/dist/` 一堆静态文件，托管在哪都行 ——
前提是那里能把 `/api` 反代到后端（默认同源，`client.ts:26` 读 `VITE_API_BASE ?? ""`），
否则就得构建期给 `VITE_API_BASE` 填后端绝对地址（`frontend/Dockerfile:6-8`）。
换来的是编译期就挡住的后端契约错位（`src/api/types.ts` 与 `ApiController` 对齐）和可测的组件。
