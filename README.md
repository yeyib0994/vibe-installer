# CloudOps Console

**云化系统的安装 / 升级 流程编排工具**。把一个交付工程师脑子里那套"先填环境、再传包、再分发、备份好再动手"的隐性流程，做成显式的、可审查、可回退的阶段流水线。

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
| 3 | **上传安装包** | ✔ | 接收文件流落盘 → 按 64 MB 分片记录校验和（支持断点续传）→ 计算整包 SHA256 → 登记包清单 |
| 4 | **包分发** | ✔ | 确认目标目录可写 → 按并发度推送（rsync 支持增量/续传，回退 scp）→ 逐节点比对 SHA256，不一致自动重传 |
| 5 | **安装前备份** | 可选 | 确认备份范围 → 逐节点归档目录 → 数据库逻辑备份并回传 → 登记备份点、设置过期时间、生成回滚基线 |
| 6 | **执行安装** | ✔ | 分发前置检查 → 控制面组件 → 数据面组件 → 工作节点组件 → 网关组件（任一节点失败可停或继续汇总） |
| 7 | **安装后验证** | ✔ | 服务状态 → 端口监听 → 版本一致性 → 集群成员 → 接口冒烟 → 生成交付报告 |

**五阶段升级流程**：环境确认 → 环境校验（含版本兼容性、磁盘余量、服务健康度）→ 升级前备份（不建议跳过）→ 执行升级（逐节点 drain → snapshot → 替换 → 迁移数据 → 重启 → undrain）→ 升级后验证。

### 状态机

```
LOCKED ──(前一阶段 PASSED/SKIPPED)──► READY ──► RUNNING ──► PASSED
                                                      └──► FAILED ──(重试)──► READY
                        READY/FAILED ──(仅 required=false)──► SKIPPED
```

闸门逻辑在 `app/engine/workflow.py::refresh_locks`，只有 `PASSED` / `SKIPPED` 算"通过"，`RUNNING` / `FAILED` 都不会解锁下一阶段。

---

## 快速开始

```bash
# 依赖
python -m venv .venv && .venv/bin/pip install -r requirements.txt

# 启动（默认 127.0.0.1:8848）
cd backend && python run_server.py

# 打开控制台
#   http://127.0.0.1:8848/
#   API 文档 http://127.0.0.1:8848/docs
```

### 真实模式 vs 模拟模式

节点操作由 `app/services/nodes.py` 的驱动层执行：

- **真实模式**：节点的 `ssh_key_path` 非空且本机存在 `ssh` 二进制 → 调用**系统 ssh/scp/rsync**。
  刻意没有用 paramiko 之类的纯 Python SSH 库 —— 交付现场机器上通常已经配好了 `~/.ssh/config`、
  跳板机、known_hosts，复用系统 ssh 比在工具里重新实现一套认证方式可靠得多。
- **模拟模式**：其余情况 → `MockDriver`，输出带 `[MOCK]` 前缀，按节点 IP 用 md5 播种生成**确定性**的
  预检问题与备份体积，保证同一环境反复演练结果一致。
- **强制模拟**：设 `CLOUDOPS_FORCE_MOCK=1`。演示机上装了 ssh 二进制但填的是假密钥时，
  不加这个开关就会被判成真实模式、一跑全不可达。

控制台右上角的模式徽标**以后端返回的「本次运行实际生效的模式」为准**（`/api/capabilities`
的 `effective_mode`），而不是单纯看本机有没有 ssh —— 本机有 ssh 但设了强制模拟时，
只看 ssh 会显示成「真实模式」，与实际执行的每一台模拟操作完全相反。强制模拟时徽标显示
「模拟模式（已强制模拟）」，并在加载时弹一条提示说明原因。

---

## 目录结构

```
cloudops/
├── backend/
│   ├── app/
│   │   ├── main.py                 FastAPI 入口、静态资源挂载
│   │   ├── api/routes.py           全部 REST + SSE 端点
│   │   ├── core/
│   │   │   ├── schemas.py          Pydantic v2 领域模型
│   │   │   ├── store.py            SQLite 持久化（WAL + JSON 列）
│   │   │   └── seed.py             演示环境种子数据
│   │   ├── engine/
│   │   │   ├── workflow.py         ★ 阶段定义 + 闸门 + 业务级校验
│   │   │   └── executor.py         ★ 阶段执行器 + 动作实现 + 日志总线
│   │   └── services/
│   │       ├── nodes.py            SSH / Mock 驱动层、系统预检
│   │       └── versioning.py       版本解析、组件兼容矩阵
│   ├── run_server.py
│   └── data/                       SQLite 库、上传的包、备份归档
├── frontend/
│   ├── index.html                  样式与骨架（零构建）
│   ├── app.js                      全部交互逻辑
│   └── verify_ui.js                Puppeteer 端到端验证脚本
└── requirements.txt
```

### 两个核心文件

- **`engine/workflow.py`** — 声明式阶段定义。每个阶段包含 `form_fields`（前端据此动态渲染表单）、
  `steps`（执行动作列表）、`required`（能否跳过）。业务级校验 `validate_stage_inputs` 也在这里，
  它检查的是**语义**而非"必填"：IP 是否重复、控制节点是否偶数、物理机是否缺机房。
- **`engine/executor.py`** — 阶段执行器。每个阶段在独立线程里跑，逐步执行动作并通过
  `LogBus` 把日志和步骤状态推给 SSE 订阅者。所有涉及节点操作的地方都经过驱动层。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/environments` | 环境列表 / 创建（列表带 `summary`，含节点数与物理/虚机配比） |
| GET/DELETE | `/api/environments/{id}` | 环境详情 / 删除 |
| GET/POST | `/api/flows` | 流程列表 / 创建（`mode=install\|upgrade`） |
| GET | `/api/flows/{id}` | 流程详情（含 `env_summary`、`nodes`、`progress`） |
| POST | `/api/flows/{id}/stages/{key}/inputs` | 提交阶段表单（先校验后落盘） |
| POST | `/api/flows/{id}/stages/{key}/validate` | 只校验不落盘，供前端实时提示 |
| POST | `/api/flows/{id}/stages/{key}/run` | 执行阶段（异步，日志走 SSE） |
| POST | `/api/flows/{id}/stages/{key}/cancel` \| `/skip` | 取消 / 跳过 |
| GET | `/api/flows/{id}/stages/{key}/stream` | **SSE** 实时日志与步骤状态 |
| GET/POST | `/api/packages`、`/api/packages/upload` | 包清单 / 多段流式上传 |
| GET | `/api/flows/{id}/distributions` | 分发记录 |
| GET/POST | `/api/backups`、`/api/backups/{id}/verify\|restore\|expire` | 备份点、校验、恢复（需显式确认）、过期 |
| GET | `/api/overview`、`/api/audit`、`/api/capabilities` | 总览 / 审计 / 能力探测（含 `effective_mode`、`force_mock`） |

---

## 设计笔记

**为什么用系统 ssh 而不是 paramiko** — 见上文"真实模式"。

**为什么备份校验和要把体积和节点名也算进去** — 模拟模式下磁盘上只有 manifest 文件，
真实归档体积（每节点几百 MB）并不落盘。若只对实际文件做摘要，任何两个备份点的校验和都会一样，
`verify` 就失去意义。所以 `backup.register` 把 `size_bytes` 和 `nodes_covered` 一起纳入哈希。

**为什么 `env_register` 重跑不能清空节点** — 第一次跑完后用户若未提交节点表单就重跑本阶段，
原来的实现会用空列表覆盖 `env.nodes`，这是很危险的静默数据丢失。现在有幂等保护：
表单为空时沿用已登记的节点。

**为什么环境列表接口也要算 `summary`** — 环境列表页每行都要显示节点数与物理/虚机配比。
早期只有详情接口 `GET /environments/{id}` 会附带 `summary`，列表接口直接返回裸对象，
列表页的「节点数」列就永远是空的。两个接口现在都带这个字段。

**为什么模式徽标不能只看 ssh 是否存在** — `/api/capabilities` 现在返回 `effective_mode`，
由「是否强制模拟 OR 本机是否可用 ssh」共同决定。演示机上 ssh 二进制是存在的，
只看 ssh 会把强制模拟的场景显示成「真实模式 · SSH 可用」，与每个节点都在跑模拟的事实完全相反 ——
这类"提示与实际执行不一致"的问题比没有提示更危险，会让人误以为看到了真实结果。

**为什么迁移场景暂时不在控制台里** — 当前版本聚焦"安装 / 升级"这条主线；跨环境搬迁需要
源端冻结、快照导出、目标端重建等另一套动作集，计划复用同一套阶段引擎，作为第三个 `mode` 接进来。

---

## 验证

```bash
# 后端端到端（跑完 7 个阶段，打印每步结果）
cd backend && python runflow_check.py

# 前端端到端（真浏览器点击全流程，收集 console 报错）
cd frontend && NODE_PATH=<node_modules> node verify_ui.js <输出目录>
```

`verify_ui.js` 用 `puppeteer-core` 驱动本机 Chrome，实际点击"填入示例 → 执行本阶段"走完
全流程并截图，最后汇总 console error / warning 数量。

---

## 技术栈

FastAPI · Pydantic v2 · SQLite（WAL）· SSE · 零构建 Vanilla JS SPA

没有任何前端构建步骤 —— 交付现场改一行代码刷新即生效，这对运维工具比工程化更重要。
