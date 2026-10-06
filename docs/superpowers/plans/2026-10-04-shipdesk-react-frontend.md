# ShipDesk Console 前端重写实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把零构建的 Vanilla JS 前端重写为 React 19 + TypeScript 单页应用，全量对齐 Java 后端已有的三种流程（install / upgrade / upgrade_k8s）、分片续传上传、K8s 集群与回滚能力，并把前端从 Java 进程里解耦为独立静态站点。

**Architecture:** 前端为独立 Vite 工程（`frontend/`），生产构建产物为纯静态文件，由独立静态服务器/网关托管，通过 `/api` 反向代理或直连 Java 后端 8848；数据层用 TanStack Query 管理服务端状态，SSE + 轮询兜底驱动阶段执行日志；UI 层是自绘的轻量组件集（Button/Tag/Card/Table/Modal），不引入组件库。后端仅做减法（去掉静态资源挂载），不改 API。

**Tech Stack:** React 19、TypeScript 5（strict）、Vite 6、Tailwind CSS 3.4、React Router 6、TanStack Query 5、Vitest 2 + Testing Library + jsdom、Playwright（E2E）、ESLint 9。

---

## 依据与范围

设计文档：`docs/superpowers/specs/2026-10-04-shipdesk-react-frontend-design.md`

**本次实现**：M0 脚手架 → M1 数据层 → M2 UI 基元与 Shell/总览 → M3 环境页 → M4 流程向导（三种 mode）→ M5 安装包/备份页 → M6 Java 静态挂载与 Dockerfile 清理 → M7 测试与本地验收。

**本次不实现**（spec §11、§12，仅保留 schema 兼容性）：迁移/扩容新 mode、流程定制化编辑、服务内嵌镜像仓、Helm provenance 验签、P2P 分发。前端一律通过「目录驱动渲染 form_fields」的方式工作，后端新增 mode 时前端无需改代码。

**前置事实**：Python 后端已删除，`backend-java/` 是唯一后端；Java CORS 已是 `allowedOriginPatterns("*")` + 全方法全头 + allowCredentials，解耦部署无需后端改动。

---

## 四条关键不变量（每条 M 都要守住）

| # | 不变量 | 错误后果 |
|---|--------|----------|
| I1 | 模式徽章只能由 `/api/capabilities` 的 `effective_mode` 与 `force_mock` 推导，**不可**只看 `ssh` 字段 | 强制模拟时仍显示「真实模式」，误导运维 |
| I2 | 阶段可执行性只信后端 `stages[].status`；仅 `passed`/`skipped` 会解锁下一阶段，前端不得自行推算解锁 | 绕过门禁，请求 409，状态与后端不一致 |
| I3 | 提交表单必须是 `{ ...stage.inputs, ...collected }`，保留服务端写入的 `_package_id` / `_package_ids` 等下划线键 | 上传完的包与流程断链，包分发阶段拿不到包 |
| I4 | 收到终态事件后**不要**主动 `EventSource.close()`（服务端发完 `close` 会自行 complete）；主动 abort 会在控制台留下 `ERR_ABORTED` | E2E 因 console error 失败 |

---

## 后端契约速查（已逐字段核对源码）

所有响应为 snake_case（`@JsonNaming(SnakeCaseStrategy)`）；时间戳格式 `yyyy-MM-dd'T'HH:mm:ss`，**无时区后缀**，前端按本地时间解析。

### 静态映射
> 2026-10-04 校正（T1.1 对照 Java 源码逐条核实）：原表按记忆写的枚举值有多处错误，以下为权威值，后续 Task 的标签表/断言一律以此为准。
- `NodeRole`: `control | worker | database | storage | gateway`（没有 `db`、没有 `middleware`）
- `MachineType`: `physical | virtual`
- `NodeStatus`: `unknown | reachable | unreachable | prepared | installed`（没有 `online/degraded/offline`）
- `StageStatus`: `locked | ready | running | passed | failed | skipped`
- `StepStatus`: `pending | running | done | partial | failed | skipped`（成功是 `done` 不是 `passed`；`partial` 是分发任务的真实中间态）
- `FlowStatus`: `draft | running | paused | succeeded | failed | aborted`（中止是 `aborted` 不是 `cancelled`）
- `BackupKind`: `pre_install | pre_upgrade`（后端不产生 `manual`）
- `BackupStatus`: `pending | running | succeeded | verified | failed | expired | restored`
- `FormField.type` 实际出现值：`text | number | select | multiselect | boolean | textarea | node_table`（后端从不发 `file`）
- SSE 日志 `level` 实际出现值：`info | warn | error | ok`

### `GET /api/environments` → `Environment[]`
`{id,name,description,base_domain,ntp_server,dns_servers[],timezone,nodes[],validated,validation_issues[],created_at,updated_at,summary:{total,by_role,by_type,physical,virtual}}`

`NodeSpec`：`{id,hostname,ip,role,machine_type,ssh_port,ssh_user,ssh_key_path,ssh_password_set,vendor,model,idc,rack,nic_speed,raid_level,host_platform,vcpu,memory_gb,disk_gb,image_template,status,os_release,kernel,cpu_cores,mem_total_gb,disk_free_gb,last_checked_at,precheck_issues[]}`

### `POST /api/environments`（body `EnvironmentSpecInput`）→ `EnvironmentSpec`
body：`{name,description,base_domain,ntp_server,dns_servers,timezone}`
`POST /api/environments/{id}/nodes` body 为 `NodeSpecInput[]`（字段同上但无 id/运行态），返回 `{ok,total}`。

### `GET /api/flows?limit=` → `FlowSummary[]`
= InstallFlow 全字段 + `progress:{done,total}`
`InstallFlow`：`{id,name,env_id,mode,status,stages[],current_stage,operator,created_at,updated_at,finished_at,error,backup_point_id}`

### `GET /api/flows/{id}` → `FlowDetail`
= InstallFlow 全字段 + `env_summary` + `env_name` + `nodes[]` + `progress`

### `FlowStage`
`{key,index,title,description,form_fields[],inputs{},required,status,steps[],started_at,finished_at,error}`

### `FormField`（`Workflow.field()` 产物，可选键按类型出现）
`{key,label,type,required,placeholder,help,hint,default?,options?:[{value,label}],multiline_list?,groups?[{key,title,fields[ColumnDef]}]}`
`type` 取值：`text | number | select | multiselect | boolean | textarea | node_table`（后端从不发 `file`）
`ColumnDef`：`{key,label,width}`，其中 `role` 列带 `type:"role"`，`vcpu/memory_gb/disk_gb` 带 `type:"number"`。

物理机列：`hostname,ip,role,vendor,model,idc,rack,nic_speed,raid_level,ssh_key_path`
虚拟机列：`hostname,ip,role,host_platform,vcpu,memory_gb,disk_gb,image_template,ssh_key_path`

### `POST /api/flows`（body `{name,env_id,mode}`）→ `InstallFlow`；mode 非三值之一返 400
### `GET /api/catalog/{mode}` → `{mode,stages:FlowStage[]}`

### 阶段动作
- `POST .../stages/{key}/inputs` body `{inputs}` → `{ok,stage}`
- `POST .../stages/{key}/validate` body `{inputs}` → `{valid,errors:string[]}`（服务端会与已存 inputs 合并后再校验）
- `POST .../stages/{key}/run` body `{operator,confirm}` → `{ok,stage,status:"running"}`；409=正在执行/前置未通过；**422 body = `{errors:string[],message}`**
- `POST .../stages/{key}/cancel` → `{ok:bool}`
- `POST .../stages/{key}/skip` body `{operator,confirm}` → `{ok,stage}`；必经阶段 409
- `GET .../stages/{key}/logs` → `Event[]`（历史，含 `stage_done`，**不含** `close`）

### SSE `GET .../stages/{key}/stream`（`text/event-stream`，每条 data 是一个 JSON）
- `{type:"log",level:"info|warn|error",message,ts}`
- `{type:"step",stage,step:FlowStep}`
- `{type:"stage_done",stage,status,error}`
- `{type:"close",status}` ← 仅实时流，控制器在轮询到终态后补发并 `complete()`

### 安装包
- `GET /api/packages` → `{id,name,version,kind,size_bytes,pieces[],upload_complete,uploaded_bytes,path,storage,target_env_id,created_at,note,progress}`
- `POST /api/packages/upload`（multipart，字段名 `file`，query/form 附带 `name,version,kind,flow_id`）
- `POST /api/packages/upload/init` body `{name,version,kind,size_bytes,chunk_size?,flow_id}` → `{upload_id,name,size_bytes,chunk_size,total_chunks,flow_id}`
- `POST /api/packages/upload/chunk`（multipart：`upload_id`、`chunk_index`、`file`）→ `{upload_id,chunk_index,received_bytes,checksum,progress}`（幂等，重复片不重复计数）
- `GET /api/packages/upload/{uploadId}` → `{upload_id,name,size_bytes,uploaded_bytes,chunk_size,total_chunks,done_chunks:number[],progress,complete}`
- `POST /api/packages/upload/{uploadId}/complete` → PackageEntry + `pieces_count`，并把 `_package_id`/`_package_ids` 写入该 flow 的 `package_upload` 阶段 inputs
- `DELETE /api/packages/{pid}` → `{ok}`

### 备份
- `GET /api/backups?envId=` → `{id,name,kind,env_id,flow_id,include_paths[],include_databases[],include_config,retention_days,status,size_bytes,checksum,path,nodes_covered[],started_at,finished_at,expire_at,verified_at,restorable,error}`
- `POST /api/backups/{bid}/verify` → `{ok,files,size_bytes,expected,actual,message}`；目录缺失时 409
- `POST /api/backups/{bid}/restore` body `{backup_id,node_ids[],confirm}` → `{ok,restored_nodes[],detail}`；`confirm=false` 返 **428**
- `POST /api/backups/{bid}/expire` → `{ok}`

### K8s
- `POST/GET /api/k8s/clusters`，`GET/DELETE /api/k8s/clusters/{id}` → `{id,name,kubeconfig,namespace,context,created_at}`
- `GET /api/k8s/clusters/{id}/releases` → K8sOpsService `helmList` 结果（`{ok,...}`，mock 下带 `[MOCK]` 语义）
- `POST /api/flows/{flowId}/rollback` body 可空或 `{revision:number}` → `helmRollback` 结果 `{ok,...}`

### 其它
- `GET /api/capabilities` → `{ssh,rsync,force_mock,effective_mode:"real|mock",mock_notice}`
- `GET /api/overview` → `{environments,flows_total,flows_by_status,packages,packages_bytes,backups,backups_bytes,backups_restorable,nodes_total,nodes_physical,nodes_virtual,recent_flows[]（含 progress、env_name）,environments_detail[]（含 summary）}`
- `GET /api/audit?limit=` → `[{id,ts,operator,action,target,result,detail}]`
- 错误体（T1.1 核实 `ApiController.ApiException` 与 handler）：`ApiException(status, String)` → `{detail:"消息"}`；`ApiException(status, Map)` → 直接把该 map 作为响应体，422 校验失败即 `{errors:string[], message:string}`（**顶层**，不包 `detail`），少数 404 传的是自定义 map。客户端必须同时处理「字符串 detail」与「errors/message map」两种形态。

### 流程阶段清单（E2E 断言用）
- install：`env_register` 环境登记 → `env_precheck` 环境校验 → `package_upload` 上传安装包 → `package_distribute` 包分发 → `pre_install_backup` 安装前备份 → `install_execute` 执行安装 → `post_verify` 安装后验证
- upgrade：`env_register` 环境确认 → `env_precheck` → `pre_upgrade_backup` → `upgrade_execute` → `post_verify`
- upgrade_k8s：`env_register` → `env_precheck` → `pre_upgrade_backup` → `upgrade_execute` → `post_verify` → `rollback_plan`（`required=false`，可 skip）

---

## 文件结构

```
frontend/
  index.html                     新（Vite 入口）
  package.json / tsconfig*.json / vite.config.ts / tailwind.config.ts
  postcss.config.js / vitest.config.ts / playwright.config.ts / .eslintrc.cjs
  src/
    main.tsx                     QueryClientProvider + RouterProvider + ToastProvider
    App.tsx                      createBrowserRouter 路由表
    index.css                    @tailwind + 少量 base
    api/
      types.ts                   全部后端契约类型（唯一真源）
      client.ts                  ApiError + api.get/post/del/upload
      endpoints.ts               queryKey 工厂 + 类型化端点函数
    hooks/
      queryClient.ts
      useCapabilities.ts         I1
      useOverview.ts / useEnvironments.ts / useFlows.ts / usePackages.ts / useBackups.ts / useAudit.ts / useClusters.ts
      useStageStream.ts          I4 + 轮询兜底
      useFlowRunner.ts           validate→inputs→run，I3 合并
    flow/
      formValue.ts               coerce + mergeInputs（I3）
      FieldRenderer.tsx
      DynamicForm.tsx
      NodeMatrixEditor.tsx       node_table 编辑（含一键填充演示数据）
      NodeMatrixReadonly.tsx
      StepList.tsx
      LogConsole.tsx
      StageRail.tsx              I2
      StagePanel.tsx
    components/
      ui/{Button,Tag,Card,Table,Empty,Modal}.tsx
      StatusTag.tsx ModeBadge.tsx TopBar.tsx Shell.tsx ConfirmDialog.tsx
      upload/UploadZone.tsx
    pages/
      Overview.tsx Envs.tsx Flows.tsx FlowWizard.tsx Packages.tsx Backups.tsx K8s.tsx
    lib/
      format.ts  labels.ts  summarize.ts
  test/
    setup.ts
    **/*.test.ts(x)
  e2e/
    install-flow.spec.ts  chunked-upload.spec.ts  upgrade-k8s.spec.ts
```

**提交纪律**：每个 Task 结束时 `npm run typecheck && npm run test:unit` 必须全绿再 commit；里程碑末尾必须跑一次 `npm run build`。

**测试工具链坑（T2.2 实测发现）**：本机 React 19.3 + vitest 3.2 + jsdom 25 下，`vi.useFakeTimers()` 与 `await userEvent.click(...)` / `findBy*` 同时使用会**死锁**（React 19 的异步 act flush 与 user-event 的内部 wait 都依赖被冻结的定时器原语）。需要定时器时改用 `userEvent.setup({ delay: null })` + 手动 `vi.advanceTimersByTimeAsync(10)` 逐跳 pump，或直接断言同步渲染结果（`getByText`/`queryByText`）。T4.4 `useStageStream`、T5.1 `useChunkedUpload` 的测试必须遵守这一点。

---

## M0 脚手架与构建链

### Task 0.1：拆除旧前端并初始化 npm 工程

**Files:**
- Delete: `frontend/app.js` `frontend/index.html` `frontend/verify_ui.js`
- Create: `frontend/package.json`

- [ ] **Step 1：确认旧文件已被 git 跟踪，可恢复**

Run: `git ls-files frontend`
Expected: 列出 `frontend/app.js`、`frontend/index.html`、`frontend/verify_ui.js`（删除后可用 `git checkout HEAD -- frontend` 找回）

- [ ] **Step 2：删除旧三件套**

```bash
git rm -f frontend/app.js frontend/index.html frontend/verify_ui.js
```

- [ ] **Step 3：写 `frontend/package.json`**

```json
{
  "name": "shipdesk-console",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --noEmit false --emitDeclarationOnly false",
    "test:unit": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "lint": "eslint src --ext .ts,.tsx"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.16",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "eslint": "^9.15.0",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.15",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.16.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 4：安装**

Run: `cd frontend && npm install`
Expected: 无 error；`node_modules/` 生成

- [ ] **Step 5：写 `.gitignore`（frontend 目录内）**

```
node_modules
dist
playwright-report
test-results
*.tsbuildinfo
```

- [ ] **Step 6：Commit**

```bash
git add frontend/.gitignore frontend/package.json frontend/package-lock.json
git commit -m "chore(frontend): 移除零构建旧前端，初始化 React/TS 工程"
```

### Task 0.2：TS / Vite / Tailwind / 测试配置

**Files:**
- Create: `frontend/tsconfig.json` `frontend/tsconfig.node.json` `frontend/vite.config.ts` `frontend/postcss.config.js` `frontend/tailwind.config.ts` `frontend/vitest.config.ts` `frontend/playwright.config.ts` `frontend/.eslintrc.cjs`

- [ ] **Step 1：`tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": false,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "types": ["vitest/globals", "@testing-library/jest-dom"],
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo"
  },
  "include": ["src", "e2e", "vite.config.ts", "vitest.config.ts", "playwright.config.ts", "tailwind.config.ts"]
}
```

- [ ] **Step 2：`tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts", "vitest.config.ts", "playwright.config.ts", "tailwind.config.ts"]
}
```

> `tsc -b` 需要 `typescript` 之外无额外依赖；若报缺 `@types/node`，执行 `npm i -D @types/node@^22` 并把它加进 package.json。

- [ ] **Step 3：`vite.config.ts`（dev 代理到 8848；生产走相对路径）**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.SHIPDESK_API ?? "http://127.0.0.1:8848";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/api": { target: API_TARGET, changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
```

- [ ] **Step 4：`postcss.config.js`**

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 5：`tailwind.config.ts`（把旧 index.html 的 :root token 映射为设计令牌）**

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f5f6f8",
        panel: "#ffffff",
        line: "#e3e6ea",
        ink: { DEFAULT: "#1a1d21", soft: "#5a6470", mute: "#8b95a1" },
        brand: { DEFAULT: "#2563eb", dark: "#1d4ed8", soft: "#eff4ff" },
        ok: "#0f9d58",
        warn: "#b7791f",
        danger: "#d93025",
        purple: "#7c3aed",
      },
      borderRadius: { card: "10px", btn: "7px" },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)",
        pop: "0 16px 40px rgba(16,24,40,.16)",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 6：`vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
```

- [ ] **Step 7：`playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SHIPDESK_WEB ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

- [ ] **Step 8：`.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "plugin:react-hooks/recommended"],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "react-hooks"],
  ignorePatterns: ["dist", "node_modules"],
  rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
};
```

- [ ] **Step 9：Commit**

```bash
git add frontend/*.json frontend/*.ts frontend/*.js frontend/.eslintrc.cjs
git commit -m "chore(frontend): 配置 TS/Vite/Tailwind/Vitest/Playwright 构建链"
```

### Task 0.3：入口、根组件与首构建

**Files:**
- Create: `frontend/index.html` `frontend/src/main.tsx` `frontend/src/App.tsx` `frontend/src/index.css` `frontend/src/test/setup.ts`

- [ ] **Step 1：`index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ShipDesk Console · 云化系统安装 / 升级 流程编排</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2：`src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html, body, #root { height: 100%; }
  body {
    @apply bg-canvas font-sans text-ink antialiased;
    font-size: 14px;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { @apply bg-line rounded-full; }
}
```

- [ ] **Step 3：`src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4：临时 `App.tsx`（M2 会被路由版替换）**

```tsx
export default function App() {
  return <div className="p-6 text-ink">ShipDesk Console</div>;
}
```

- [ ] **Step 5：`src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 6：构建冒烟**

Run: `cd frontend && npm run build`
Expected: `dist/index.html` 生成，退出码 0

- [ ] **Step 7：Commit**

```bash
git add frontend/index.html frontend/src
git commit -m "feat(frontend): Vite 入口与 ShipDesk Console 根组件"
```

---

## M1 数据层（类型、客户端、查询）

### Task 1.1：`api/types.ts` —— 后端契约唯一真源

**Files:**
- Create: `frontend/src/api/types.ts`

- [ ] **Step 1：写完整类型（无测试，纯类型；由 typecheck 保证）**

```ts
export type NodeRole = "control" | "worker" | "gateway" | "db" | "middleware" | "storage";
export type MachineType = "physical" | "virtual";
export type NodeStatus = "unknown" | "online" | "degraded" | "offline";
export type StageStatus = "locked" | "ready" | "running" | "passed" | "failed" | "skipped";
export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";
export type FlowStatus = "draft" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
export type FlowMode = "install" | "upgrade" | "upgrade_k8s";
export type BackupKind = "pre_install" | "pre_upgrade" | "manual";
export type BackupStatus =
  | "pending" | "running" | "completed" | "verified" | "failed" | "expired" | "restored";
export type FieldType = "text" | "number" | "select" | "boolean" | "textarea" | "node_table" | "file";
export type LogLevel = "info" | "warn" | "error";

export interface NodeSpec {
  id: string;
  hostname: string;
  ip: string;
  role: NodeRole;
  machine_type: MachineType;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path?: string | null;
  ssh_password_set?: boolean;
  vendor?: string | null;
  model?: string | null;
  idc?: string | null;
  rack?: string | null;
  nic_speed?: string | null;
  raid_level?: string | null;
  host_platform?: string | null;
  vcpu?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
  image_template?: string | null;
  status: NodeStatus;
  os_release?: string | null;
  kernel?: string | null;
  cpu_cores?: number | null;
  mem_total_gb?: number | null;
  disk_free_gb?: number | null;
  last_checked_at?: string | null;
  precheck_issues: string[];
}

export interface NodeSpecInput {
  hostname: string;
  ip: string;
  role: NodeRole;
  machine_type: MachineType;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path?: string | null;
  vendor?: string | null;
  model?: string | null;
  idc?: string | null;
  rack?: string | null;
  nic_speed?: string | null;
  raid_level?: string | null;
  host_platform?: string | null;
  vcpu?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
  image_template?: string | null;
}

export interface EnvSummary {
  total: number;
  by_role: Partial<Record<NodeRole, number>>;
  by_type: Partial<Record<MachineType, number>>;
  physical: number;
  virtual: number;
}

export interface Environment {
  id: string;
  name: string;
  description: string;
  base_domain: string;
  ntp_server: string;
  dns_servers: string[];
  timezone: string;
  nodes: NodeSpec[];
  validated: boolean;
  validation_issues: string[];
  created_at: string;
  updated_at: string;
  summary?: EnvSummary;
}

export interface EnvironmentInput {
  name: string;
  description?: string;
  base_domain?: string;
  ntp_server?: string;
  dns_servers?: string[];
  timezone?: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  width?: number;
  type?: "role" | "number" | "text";
}

export interface FieldGroup {
  key: string;
  title: string;
  fields: ColumnDef[];
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder: string;
  help: string;
  hint: string;
  default?: unknown;
  options?: FieldOption[];
  multiline_list?: boolean;
  groups?: FieldGroup[];
}

export interface StepState {
  id: string;
  index: number;
  title: string;
  detail: string;
  action: string;
  args: Record<string, unknown>;
  status: StepStatus;
  output: string;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms: number;
}

export interface FlowStage {
  key: string;
  index: number;
  title: string;
  description: string;
  form_fields: FormField[];
  inputs: Record<string, unknown>;
  required: boolean;
  status: StageStatus;
  steps: StepState[];
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
}

export interface Flow {
  id: string;
  name: string;
  env_id: string;
  mode: FlowMode;
  status: FlowStatus;
  stages: FlowStage[];
  current_stage: number;
  operator: string;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
  error?: string | null;
  backup_point_id?: string | null;
}

export interface FlowProgress { done: number; total: number }
export interface FlowSummary extends Flow { progress: FlowProgress }
export interface FlowDetail extends FlowSummary {
  env_name: string;
  env_summary: EnvSummary;
  nodes: NodeSpec[];
}

export interface PackagePiece { index: number; size_bytes: number; checksum: string }

export interface PackageEntry {
  id: string;
  name: string;
  version: string;
  kind: string;
  size_bytes: number;
  checksum: string;
  pieces: PackagePiece[];
  upload_complete: boolean;
  uploaded_bytes: number;
  path: string;
  storage: string;
  target_env_id?: string | null;
  created_at: string;
  note: string;
  progress: number;
}

export interface BackupPoint {
  id: string;
  name: string;
  kind: BackupKind;
  env_id: string;
  flow_id?: string | null;
  include_paths: string[];
  include_databases: string[];
  include_config: boolean;
  retention_days: number;
  status: BackupStatus;
  size_bytes: number;
  checksum: string;
  path: string;
  nodes_covered: string[];
  started_at?: string | null;
  finished_at?: string | null;
  expire_at?: string | null;
  verified_at?: string | null;
  restorable: boolean;
  error?: string | null;
}

export interface Capabilities {
  ssh: boolean;
  rsync: boolean;
  force_mock: boolean;
  effective_mode: "real" | "mock";
  mock_notice: string;
}

export interface Overview {
  environments: number;
  flows_total: number;
  flows_by_status: Record<string, number>;
  packages: number;
  packages_bytes: number;
  backups: number;
  backups_bytes: number;
  backups_restorable: number;
  nodes_total: number;
  nodes_physical: number;
  nodes_virtual: number;
  recent_flows: (FlowSummary & { env_name: string })[];
  environments_detail: (Environment & { summary: EnvSummary })[];
}

export interface AuditRecord {
  id: number;
  ts: string;
  operator: string;
  action: string;
  target: string;
  result: string;
  detail: string;
}

export interface K8sCluster {
  id: string;
  name: string;
  kubeconfig: string;
  namespace: string;
  context: string;
  created_at: string;
}

export interface VerifyResult {
  ok: boolean;
  files: number;
  size_bytes: number;
  expected: string;
  actual: string;
  message: string;
}

export interface RestoreResult { ok: boolean; restored_nodes: string[]; detail: string }

export interface UploadInit {
  upload_id: string;
  name: string;
  size_bytes: number;
  chunk_size: number;
  total_chunks: number;
  flow_id: string;
}

export interface UploadStatus {
  upload_id: string;
  name: string;
  size_bytes: number;
  uploaded_bytes: number;
  chunk_size: number;
  total_chunks: number;
  done_chunks: number[];
  progress: number;
  complete: boolean;
}

export interface UploadChunkResult {
  upload_id: string;
  chunk_index: number;
  received_bytes: number;
  checksum: string;
  progress: number;
}

export type StreamEvent =
  | { type: "log"; level: LogLevel; message: string; ts: string }
  | { type: "step"; stage: string; step: StepState; ts?: string }
  | { type: "stage_done"; stage: string; status: StageStatus; error?: string | null; ts?: string }
  | { type: "close"; status: StageStatus };

export interface ValidateResult { valid: boolean; errors: string[] }
export interface OkResult { ok: boolean }
```

- [ ] **Step 2：类型检查**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 3：Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(frontend): 后端契约类型定义"
```

### Task 1.2：`api/client.ts` —— 带字段错误的请求层（TDD）

**Files:**
- Create: `frontend/src/api/client.ts`
- Test: `frontend/src/api/client.test.ts`

- [ ] **Step 1：写失败测试**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "./client";

describe("api client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("JSON 请求带 content-type 且序列化 body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    await api.post("/api/flows", { name: "t", mode: "install" });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/api/flows");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init!.body).toBe(JSON.stringify({ name: "t", mode: "install" }));
  });

  it("FormData 请求不设置 content-type", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    const fd = new FormData();
    fd.append("file", new Blob(["x"]), "x.bin");
    await api.post("/api/packages/upload", fd);
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.headers ?? {}).not.toHaveProperty("content-type");
  });

  it("422 解析顶层 errors 到 fieldErrors", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ errors: ["「IP」必填"], message: "表单校验未通过" }), { status: 422 })
    );
    const err = await api.post("/api/x", {}).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.fieldErrors).toEqual(["「IP」必填"]);
    expect(err.message).toBe("表单校验未通过");
  });

  it("普通 detail 字符串作为 message", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ detail: "流程不存在" }), { status: 404 }));
    const err = await api.get("/api/flows/nope").catch((e) => e as ApiError);
    expect(err.message).toBe("流程不存在");
    expect(err.fieldErrors).toEqual([]);
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: FAIL，`Failed to resolve import "./client"`

- [ ] **Step 3：实现 `client.ts`**

```ts
export class ApiError extends Error {
  status: number;
  fieldErrors: string[];
  data: unknown;

  constructor(status: number, message: string, fieldErrors: string[], data: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.data = data;
  }
}

const BASE = import.meta.env.VITE_API_BASE ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const body = parsed as { detail?: unknown; errors?: unknown; message?: unknown } | undefined;
    const detail = body?.detail;
    if (typeof detail === "string") throw new ApiError(res.status, detail, [], parsed);
    if (detail && typeof detail === "object") {
      const d = detail as { errors?: string[]; message?: string; detail?: string };
      throw new ApiError(res.status, d.message ?? d.detail ?? "请求失败", d.errors ?? [], parsed);
    }
    // 422 校验失败：ApiController 把 {errors, message} 直接作为响应体（顶层，不包 detail）
    if (Array.isArray(body?.errors)) {
      throw new ApiError(res.status, String(body?.message ?? "请求失败"), body.errors as string[], parsed);
    }
    throw new ApiError(res.status, res.statusText || "请求失败", [], parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    body instanceof FormData
      ? request<T>(path, { method: "POST", body })
      : request<T>(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
```

- [ ] **Step 4：跑测试确认通过**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: 4 passed

- [ ] **Step 5：Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(frontend): API 客户端与 422 字段错误解析"
```

### Task 1.3：`lib/format.ts` 与 `lib/labels.ts`（TDD）

**Files:**
- Create: `frontend/src/lib/format.ts` `frontend/src/lib/labels.ts`
- Test: `frontend/src/lib/format.test.ts` `frontend/src/lib/labels.test.ts`

- [ ] **Step 1：失败测试 `format.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { fmtBytes, fmtTime, fmtDate, fmtDuration } from "./format";

describe("format", () => {
  it("字节：180KB 用例与旧版一致", () => {
    expect(fmtBytes(180 * 1024)).toBe("180 KB");
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
  it("后端无时区时间戳按本地时间解析", () => {
    expect(fmtTime("2026-10-04T09:05:00")).toMatch(/^2026-10-04 09:05$/);
    expect(fmtTime(null)).toBe("—");
  });
  it("耗时", () => {
    expect(fmtDuration(900)).toBe("0.9s");
    expect(fmtDuration(65_000)).toBe("1m5s");
  });
});
```

- [ ] **Step 2：失败测试 `labels.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ROLE_CN, STATUS_CN, STEP_CN, FLOW_STATUS_CN, BACKUP_STATUS_CN, statusTone, modeLabel, KIND_CN } from "./labels";

describe("labels", () => {
  it("角色与状态都有中文映射", () => {
    expect(ROLE_CN.control).toBe("控制节点");
    expect(STATUS_CN.reachable).toBe("可达");
    expect(FLOW_STATUS_CN.succeeded).toBe("成功");
    expect(FLOW_STATUS_CN.aborted).toBe("已中止");
    expect(BACKUP_STATUS_CN.verified).toBe("已校验");
    expect(STEP_CN.done).toBe("已完成");
    expect(KIND_CN.bundle).toBe("安装包");
  });
  it("状态色调", () => {
    expect(statusTone("passed")).toBe("ok");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("running")).toBe("brand");
    expect(statusTone("locked")).toBe("mute");
  });
  it("mode 标签", () => {
    expect(modeLabel("install")).toBe("全新安装");
    expect(modeLabel("upgrade")).toBe("原地升级");
    expect(modeLabel("upgrade_k8s")).toBe("K8s / Helm 升级");
  });
});
```

- [ ] **Step 3：跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib`
Expected: FAIL，找不到模块

- [ ] **Step 4：实现 `format.ts`**

```ts
const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
  return `${s.replace(/\.0$/, "")} ${UNITS[i]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 后端 LocalDateTime 无时区后缀，补 Z 会错 8 小时，故按本地时间解析。 */
function parse(ts: string): Date {
  const [d, t] = ts.split("T");
  const [y, mo, day] = (d ?? "").split("-").map(Number);
  const [h, mi, s] = (t ?? "0").split(":").map(Number);
  return new Date(y ?? 1970, (mo ?? 1) - 1, day ?? 1, h ?? 0, mi ?? 0, s ?? 0);
}

export function fmtTime(ts?: string | null): string {
  if (!ts) return "—";
  const dt = parse(ts);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function fmtDate(ts?: string | null): string {
  if (!ts) return "—";
  const dt = parse(ts);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function fmtDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}
```

- [ ] **Step 5：实现 `labels.ts`**

```ts
import type {
  BackupKind, BackupStatus, FlowMode, FlowStatus, MachineType, NodeRole, NodeStatus, StageStatus, StepStatus,
} from "../api/types";

export const ROLE_CN: Record<NodeRole, string> = {
  control: "控制节点", worker: "工作节点", database: "数据库节点", storage: "存储节点", gateway: "网关节点",
};

export const TYPE_CN: Record<MachineType, string> = { physical: "物理机", virtual: "虚拟机" };

export const STATUS_CN: Record<NodeStatus, string> = {
  unknown: "未检测", reachable: "可达", unreachable: "不可达", prepared: "已就绪", installed: "已安装",
};

export const STAGE_CN: Record<StageStatus, string> = {
  locked: "未解锁", ready: "待执行", running: "执行中", passed: "已通过", failed: "失败", skipped: "已跳过",
};

export const STEP_CN: Record<StepStatus, string> = {
  pending: "待执行", running: "执行中", done: "已完成", partial: "部分完成", failed: "失败", skipped: "已跳过",
};

export const FLOW_STATUS_CN: Record<FlowStatus, string> = {
  draft: "草稿", running: "进行中", paused: "已暂停", succeeded: "成功", failed: "失败", aborted: "已中止",
};

export const BACKUP_STATUS_CN: Record<BackupStatus, string> = {
  pending: "待执行", running: "进行中", succeeded: "已完成", verified: "已校验",
  failed: "失败", expired: "已过期", restored: "已恢复",
};

export const BACKUP_KIND_CN: Record<BackupKind, string> = {
  pre_install: "安装前", pre_upgrade: "升级前",
};

export const KIND_CN: Record<string, string> = {
  bundle: "安装包", chart: "Helm Chart", image: "镜像", config: "配置",
};

export type Tone = "ok" | "warn" | "danger" | "brand" | "mute" | "purple";

const TONE: Record<string, Tone> = {
  passed: "ok", done: "ok", completed: "ok", succeeded: "ok", verified: "ok", restored: "ok",
  reachable: "ok", installed: "ok",
  ready: "brand", running: "brand", prepared: "brand",
  failed: "danger", unreachable: "danger", aborted: "danger",
  degraded: "warn", paused: "warn", partial: "warn",
  locked: "mute", skipped: "mute", pending: "mute", unknown: "mute", draft: "mute", expired: "mute",
};

export const statusTone = (s: string): Tone => TONE[s] ?? "mute";

export function modeLabel(mode: FlowMode | string): string {
  if (mode === "install") return "全新安装";
  if (mode === "upgrade") return "原地升级";
  if (mode === "upgrade_k8s") return "K8s / Helm 升级";
  return mode;
}

export const MODE_OPTIONS: { value: FlowMode; label: string; hint: string }[] = [
  { value: "install", label: "全新安装", hint: "7 阶段 · 环境登记到安装后验证" },
  { value: "upgrade", label: "原地升级", hint: "5 阶段 · 备份基线到升级后验证" },
  { value: "upgrade_k8s", label: "K8s / Helm 升级", hint: "6 阶段 · Helm release 升级，含回滚预案" },
];
```

- [ ] **Step 6：跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib`
Expected: 全部 passed

- [ ] **Step 7：Commit**

```bash
git add frontend/src/lib frontend/src/api/types.ts
git commit -m "feat(frontend): 格式化与中文标签工具"
```

### Task 1.4：`queryClient` + 类型化端点 + hooks

**Files:**
- Create: `frontend/src/hooks/queryClient.ts` `frontend/src/api/endpoints.ts` `frontend/src/hooks/queries.ts`
- Test: `frontend/src/api/endpoints.test.ts`

- [ ] **Step 1：`queryClient.ts`**

```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5_000 },
    mutations: { retry: 0 },
  },
});
```

- [ ] **Step 2：失败测试 `endpoints.test.ts`（锁住 URL，防止与后端漂移）**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { endpoints, qk } from "./endpoints";

const stub = (data: unknown) =>
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));

describe("endpoints URLs", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const urlOf = (i: number) => vi.mocked(fetch).mock.calls[i]![0] as string;
  const initOf = (i: number) => vi.mocked(fetch).mock.calls[i]![1]!;

  it("阶段动作路径", async () => {
    stub({ ok: true });
    await endpoints.runStage("f1", "env_precheck", { operator: "admin", confirm: false });
    expect(urlOf(0)).toBe("/api/flows/f1/stages/env_precheck/run");
    expect(initOf(0).method).toBe("POST");

    await endpoints.cancelStage("f1", "env_precheck");
    expect(urlOf(1)).toBe("/api/flows/f1/stages/env_precheck/cancel");

    await endpoints.validateStage("f1", "env_register", { a: 1 });
    expect(urlOf(2)).toBe("/api/flows/f1/stages/env_register/validate");
    expect(JSON.parse(initOf(2).body as string)).toEqual({ inputs: { a: 1 } });
  });

  it("K8s 与回滚路径", async () => {
    stub({});
    await endpoints.listClusters();
    await endpoints.rollback("f9", 3);
    expect(urlOf(0)).toBe("/api/k8s/clusters");
    expect(urlOf(1)).toBe("/api/flows/f9/rollback");
    expect(JSON.parse(initOf(1).body as string)).toEqual({ revision: 3 });
  });

  it("分片上传用 FormData 且字段名与后端一致", async () => {
    stub({});
    await endpoints.uploadChunk("u1", 7, new Blob(["x"]), "part");
    const fd = vi.mocked(fetch).mock.calls.at(-1)![1]!.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get("upload_id")).toBe("u1");
    expect(fd.get("chunk_index")).toBe("7");
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toBe("/api/packages/upload/chunk");
  });
});
```

- [ ] **Step 3：跑测试确认失败**

Run: `cd frontend && npx vitest run src/api/endpoints.test.ts`
Expected: FAIL，找不到 `./endpoints`

- [ ] **Step 4：`endpoints.ts`**

```ts
import { api } from "./client";
import type {
  AuditRecord, BackupPoint, Capabilities, Environment, EnvironmentInput, Flow, FlowCreate,
  FlowDetail, FlowSummary, K8sCluster, NodeSpecInput, OkResult, Overview, PackageEntry,
  RestoreResult, UploadChunkResult, UploadInit, UploadStatus, ValidateResult, VerifyResult,
  FlowMode, FlowStage,
} from "./types";

export const qk = {
  caps: ["capabilities"] as const,
  overview: ["overview"] as const,
  envs: ["environments"] as const,
  env: (id: string) => ["environments", id] as const,
  flows: (limit = 100) => ["flows", limit] as const,
  flow: (id: string) => ["flows", "detail", id] as const,
  catalog: (mode: string) => ["catalog", mode] as const,
  packages: ["packages"] as const,
  backups: (envId?: string) => ["backups", envId ?? "all"] as const,
  audit: (limit = 200) => ["audit", limit] as const,
  clusters: ["k8s", "clusters"] as const,
  releases: (id: string) => ["k8s", "clusters", id, "releases"] as const,
  stageLogs: (flowId: string, key: string) => ["flows", flowId, "stages", key, "logs"] as const,
};

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const endpoints = {
  capabilities: () => api.get<Capabilities>("/api/capabilities"),
  overview: () => api.get<Overview>("/api/overview"),
  audit: (limit = 200) => api.get<AuditRecord[]>(`/api/audit${qs({ limit })}`),

  listEnvs: () => api.get<Environment[]>("/api/environments"),
  getEnv: (id: string) => api.get<Environment>(`/api/environments/${id}`),
  createEnv: (body: EnvironmentInput) => api.post<Environment>("/api/environments", body),
  deleteEnv: (id: string) => api.del<OkResult>(`/api/environments/${id}`),
  addNodes: (id: string, nodes: NodeSpecInput[]) =>
    api.post<{ ok: boolean; total: number }>(`/api/environments/${id}/nodes`, nodes),
  deleteNode: (envId: string, nodeId: string) =>
    api.del<OkResult>(`/api/environments/${envId}/nodes/${nodeId}`),

  catalog: (mode: FlowMode) => api.get<{ mode: string; stages: FlowStage[] }>(`/api/catalog/${mode}`),
  listFlows: (limit = 100) => api.get<FlowSummary[]>(`/api/flows${qs({ limit })}`),
  getFlow: (id: string) => api.get<FlowDetail>(`/api/flows/${id}`),
  createFlow: (body: FlowCreate) => api.post<Flow>("/api/flows", body),
  deleteFlow: (id: string) => api.del<OkResult>(`/api/flows/${id}`),

  submitStageInputs: (flowId: string, key: string, inputs: Record<string, unknown>) =>
    api.post<{ ok: boolean; stage: FlowStage }>(`/api/flows/${flowId}/stages/${key}/inputs`, { inputs }),
  validateStage: (flowId: string, key: string, inputs: Record<string, unknown>) =>
    api.post<ValidateResult>(`/api/flows/${flowId}/stages/${key}/validate`, { inputs }),
  runStage: (flowId: string, key: string, body: { operator?: string; confirm?: boolean }) =>
    api.post<OkResult & { stage: string; status: string }>(`/api/flows/${flowId}/stages/${key}/run`, body),
  cancelStage: (flowId: string, key: string) =>
    api.post<OkResult>(`/api/flows/${flowId}/stages/${key}/cancel`),
  skipStage: (flowId: string, key: string, operator = "admin") =>
    api.post<{ ok: boolean; stage: FlowStage }>(`/api/flows/${flowId}/stages/${key}/skip`, { operator }),
  stageLogs: (flowId: string, key: string) =>
    api.get<Record<string, unknown>[]>(`/api/flows/${flowId}/stages/${key}/logs`),
  rollback: (flowId: string, revision?: number) =>
    api.post<Record<string, unknown>>(`/api/flows/${flowId}/rollback`, revision == null ? {} : { revision }),

  listPackages: () => api.get<PackageEntry[]>("/api/packages"),
  deletePackage: (id: string) => api.del<OkResult>(`/api/packages/${id}`),
  uploadPackage: (fd: FormData) => api.post<PackageEntry & { pieces_count: number }>("/api/packages/upload", fd),
  initUpload: (body: { name: string; version?: string; kind?: string; size_bytes: number; chunk_size?: number; flow_id?: string }) =>
    api.post<UploadInit>("/api/packages/upload/init", body),
  uploadChunk: (uploadId: string, index: number, blob: Blob, filename: string) => {
    const fd = new FormData();
    fd.append("upload_id", uploadId);
    fd.append("chunk_index", String(index));
    fd.append("file", blob, filename);
    return api.post<UploadChunkResult>("/api/packages/upload/chunk", fd);
  },
  uploadStatus: (uploadId: string) => api.get<UploadStatus>(`/api/packages/upload/${uploadId}`),
  completeUpload: (uploadId: string) =>
    api.post<PackageEntry & { pieces_count: number }>(`/api/packages/upload/${uploadId}/complete`),

  listBackups: (envId?: string) => api.get<BackupPoint[]>(`/api/backups${qs({ envId })}`),
  verifyBackup: (id: string) => api.post<VerifyResult>(`/api/backups/${id}/verify`),
  restoreBackup: (id: string, body: { backup_id?: string; node_ids: string[]; confirm: boolean }) =>
    api.post<RestoreResult>(`/api/backups/${id}/restore`, body),
  expireBackup: (id: string) => api.post<OkResult>(`/api/backups/${id}/expire`),

  listClusters: () => api.get<K8sCluster[]>("/api/k8s/clusters"),
  createCluster: (body: { name: string; kubeconfig: string; namespace?: string; context?: string }) =>
    api.post<K8sCluster>("/api/k8s/clusters", body),
  deleteCluster: (id: string) => api.del<OkResult>(`/api/k8s/clusters/${id}`),
  clusterReleases: (id: string) => api.get<Record<string, unknown>>(`/api/k8s/clusters/${id}/releases`),
};
```

- [ ] **Step 5：给 `types.ts` 补 `FlowCreate`**

```ts
export interface FlowCreate { name: string; env_id: string; mode: FlowMode; operator?: string }
```

- [ ] **Step 6：跑测试确认通过**

Run: `cd frontend && npx vitest run src/api/endpoints.test.ts`
Expected: 3 passed

- [ ] **Step 7：`hooks/queries.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints, qk } from "../api/endpoints";
import type { EnvironmentInput, FlowCreate, FlowMode } from "../api/types";

export const useCapabilities = () =>
  useQuery({ queryKey: qk.caps, queryFn: endpoints.capabilities, staleTime: Infinity });

export const useOverview = () => useQuery({ queryKey: qk.overview, queryFn: endpoints.overview });

export const useAudit = (limit = 200) =>
  useQuery({ queryKey: qk.audit(limit), queryFn: () => endpoints.audit(limit) });

export const useEnvironments = () =>
  useQuery({ queryKey: qk.envs, queryFn: endpoints.listEnvs });

export const useEnvironment = (id: string) =>
  useQuery({ queryKey: qk.env(id), queryFn: () => endpoints.getEnv(id), enabled: Boolean(id) });

export const useCreateEnv = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EnvironmentInput) => endpoints.createEnv(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.envs }),
  });
};

export const useDeleteEnv = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deleteEnv(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.envs }),
  });
};

export const useAddNodes = (envId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodes: Parameters<typeof endpoints.addNodes>[1]) => endpoints.addNodes(envId, nodes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.env(envId) });
      qc.invalidateQueries({ queryKey: qk.envs });
    },
  });
};

export const useCatalog = (mode: FlowMode) =>
  useQuery({ queryKey: qk.catalog(mode), queryFn: () => endpoints.catalog(mode), staleTime: Infinity });

export const useFlows = (limit = 100) =>
  useQuery({ queryKey: qk.flows(limit), queryFn: () => endpoints.listFlows(limit) });

export const useFlow = (id: string) =>
  useQuery({
    queryKey: qk.flow(id),
    queryFn: () => endpoints.getFlow(id),
    // 有阶段在跑时提速轮询，否则只靠失效刷新
    refetchInterval: (q) =>
      q.state.data?.stages.some((s) => s.status === "running") ? 1_200 : false,
  });

export const useCreateFlow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FlowCreate) => endpoints.createFlow(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flows"] }),
  });
};

export const useDeleteFlow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deleteFlow(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flows"] }),
  });
};

export const usePackages = () => useQuery({ queryKey: qk.packages, queryFn: endpoints.listPackages });

/** 单个包：后端没有 GET /packages/{id}，从列表查询派生，上传完成后自动刷新。 */
export const usePackage = (id: string) => {
  const { data, isLoading } = usePackages();
  return { data: data?.find((p) => p.id === id) ?? null, isLoading };
};

export const useDeletePackage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deletePackage(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.packages }),
  });
};

export const useBackups = (envId?: string) =>
  useQuery({ queryKey: qk.backups(envId), queryFn: () => endpoints.listBackups(envId) });

export const useClusters = () => useQuery({ queryKey: qk.clusters, queryFn: endpoints.listClusters });

export const useCreateCluster = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof endpoints.createCluster>[0]) => endpoints.createCluster(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.clusters }),
  });
};

export const useDeleteCluster = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.deleteCluster(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.clusters }),
  });
};
```

- [ ] **Step 8：类型检查 + Commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

```bash
git add frontend/src/hooks frontend/src/api/endpoints.ts frontend/src/api/endpoints.test.ts frontend/src/api/types.ts
git commit -m "feat(frontend): TanStack Query 端点与 hooks"
```

> **T1.4 实施校正（提交 `dfaacc9`，以 `ApiController.java` 为准）：**
> 1. `submitStageInputs` 返回 `{ok, inputs, nodes}`，**没有** `stage`；UI 保存 inputs 后必须失效 `qk.flow(id)` 重新同步，不能读变更结果。
> 2. `DELETE /api/k8s/clusters/{id}` 返回 `{ok, id}` → 类型 `OkResult & { id: string }`。
> 3. `endpoints.stageLogs` 类型为 `StageLogEvent[]`（endpoints.ts 导出的 `Exclude<StreamEvent, {type:"close"}>`）：历史里永远没有 `close` 事件。
> 4. `FlowCreate` 不含 `operator`（DTO 只有 name/env_id/mode，控制器写死 `"admin"`）。
> 5. 测试的 `stub()` 必须每次 **新建 Response**（用 `mockImplementation`），复用同一实例在第二个请求会抛 `Body is unusable`；`qk` 在该测试里没被用到，别 import（`noUnusedLocals`）。

---

## M2 UI 基元、Toast、模式徽章与 Shell/总览

### Task 2.1：UI 基元组件

**Files:**
- Create: `frontend/src/components/ui/Button.tsx` `Tag.tsx` `Card.tsx` `Table.tsx` `Empty.tsx` `Modal.tsx`

- [ ] **Step 1：`Button.tsx`**

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger" | "quiet";

const V: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-dark disabled:bg-ink-mute",
  ghost: "bg-panel text-ink border border-line hover:border-brand hover:text-brand",
  danger: "bg-panel text-danger border border-line hover:border-danger",
  quiet: "bg-transparent text-ink-soft hover:text-ink",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  children: ReactNode;
}

export function Button({ variant = "primary", size = "md", className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={[
        "inline-flex items-center gap-1.5 rounded-btn font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        V[variant],
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2：`Tag.tsx`**

```tsx
import type { ReactNode } from "react";
import type { Tone } from "../../lib/labels";

const T: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  brand: "bg-brand/10 text-brand",
  purple: "bg-purple/10 text-purple",
  mute: "bg-line/70 text-ink-mute",
};

export function Tag({ tone = "mute", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${T[tone]}`}>
      {children}
    </span>
  );
}
```

- [ ] **Step 3：`Card.tsx`**

```tsx
import type { ReactNode } from "react";

export interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  tight?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Card({ title, sub, actions, tight, children, className = "" }: CardProps) {
  return (
    <section className={`rounded-card border border-line bg-panel shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>}
            {sub && <p className="mt-0.5 text-xs text-ink-mute">{sub}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={tight ? "" : "p-4"}>{children}</div>
    </section>
  );
}
```

- [ ] **Step 4：`Table.tsx`**

```tsx
import type { ReactNode } from "react";

export function Table({ head, children, className = "" }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-canvas text-left text-xs font-semibold text-ink-mute">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 first:pl-4 last:pr-4">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, w }: { children?: ReactNode; w?: number }) {
  return <th style={{ width: w }}>{children}</th>;
}

export function Tr({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={`border-t border-line hover:bg-brand-soft/60 ${onClick ? "cursor-pointer" : ""}`}
    >
      {children}
    </tr>
  );
}

export function Td({ children, colSpan, className = "" }: { children: ReactNode; colSpan?: number; className?: string }) {
  return (
    <td colSpan={colSpan} className={`px-3 py-2.5 align-middle first:pl-4 last:pr-4 ${className}`}>
      {children}
    </td>
  );
}
```

> `Th` 仅用于给 `head` 数组传宽度。

- [ ] **Step 5：`Empty.tsx`**

```tsx
import type { ReactNode } from "react";

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-mute">{children}</div>;
}
```

- [ ] **Step 6：`Modal.tsx`（Escape + 遮罩关闭）**

```tsx
import { useEffect, type ReactNode } from "react";
import { Button } from "./Button";

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  sub?: ReactNode;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

export function Modal({ open, title, sub, width = 640, onClose, footer, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="mt-8 w-full rounded-card bg-panel shadow-pop"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-ink">{title}</h3>
            {sub && <p className="mt-1 text-xs text-ink-mute">{sub}</p>}
          </div>
          <Button variant="quiet" size="sm" onClick={onClose} aria-label="关闭">✕</Button>
        </header>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}
```

- [ ] **Step 7：类型检查 + Commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

```bash
git add frontend/src/components/ui
git commit -m "feat(frontend): UI 基元组件"
```

### Task 2.2：Toast Provider（TDD）

**Files:**
- Create: `frontend/src/components/ToastProvider.tsx`
- Test: `frontend/src/components/ToastProvider.test.tsx`

- [ ] **Step 1：失败测试**

```tsx
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";

function Probe() {
  const toast = useToast();
  return <button onClick={() => toast("保存成功", "ok")}>触发</button>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ToastProvider", () => {
  it("渲染并在 3.2s 后自动消失", async () => {
    render(<ToastProvider><Probe /></ToastProvider>);
    await userEvent.click(screen.getByText("触发"));
    expect(await screen.findByText("保存成功")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3_200); });
    expect(screen.queryByText("保存成功")).toBeNull();
  });

  it("error 级别可手动关闭", async () => {
    render(<ToastProvider><Probe /></ToastProvider>);
    await userEvent.click(screen.getByText("触发"));
    await userEvent.click(screen.getByLabelText("关闭提示"));
    expect(screen.queryByText("保存成功")).toBeNull();
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/ToastProvider.test.tsx`
Expected: FAIL，找不到模块

- [ ] **Step 3：实现**

```tsx
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type Kind = "ok" | "warn" | "error";

interface Item { id: number; text: string; kind: Kind }
interface Ctx { push: (text: string, kind?: Kind) => void }

const ToastCtx = createContext<Ctx>({ push: () => {} });

const KIND_CLS: Record<Kind, string> = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  error: "border-danger/40 bg-danger/10 text-danger",
};

const GLYPH: Record<Kind, string> = { ok: "✔", warn: "▲", error: "✕" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), []);

  const push = useCallback((text: string, kind: Kind = "ok") => {
    const id = ++seq.current;
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => remove(id), 3_200);
  }, [remove]);

  const ctx = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div data-toast-root className="fixed bottom-5 right-5 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`flex items-start gap-2 rounded-card border px-3 py-2.5 text-xs shadow-pop ${KIND_CLS[t.kind]}`}
          >
            <span className="font-mono">{GLYPH[t.kind]}</span>
            <span className="flex-1 break-words">{t.text}</span>
            <button aria-label="关闭提示" className="opacity-60 hover:opacity-100" onClick={() => remove(t.id)}>✕</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx).push;
```

- [ ] **Step 4：跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/ToastProvider.test.tsx`
Expected: passed

- [ ] **Step 5：Commit**

```bash
git add frontend/src/components/ToastProvider.tsx frontend/src/components/ToastProvider.test.tsx
git commit -m "feat(frontend): Toast Provider"
```

### Task 2.3：ModeBadge —— 不变量 I1（TDD）

**Files:**
- Create: `frontend/src/components/ModeBadge.tsx` `frontend/src/hooks/useCapabilities.ts`
- Test: `frontend/src/components/ModeBadge.test.tsx`

- [ ] **Step 1：失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ModeBadge } from "./ModeBadge";
import type { Capabilities } from "../api/types";

function setup(caps: Capabilities) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  qc.setQueryData(["capabilities"], caps);
  return render(<QueryClientProvider client={qc}><ModeBadge /></QueryClientProvider>);
}

describe("ModeBadge (I1)", () => {
  it("effective_mode=real 显示真实模式", () => {
    setup({ ssh: true, rsync: true, force_mock: false, effective_mode: "real", mock_notice: "" });
    expect(screen.getByText("真实模式")).toBeInTheDocument();
  });

  it("ssh=true 但 force_mock=true 必须显示模拟（旧版 bug 回归点）", () => {
    setup({
      ssh: true, rsync: true, force_mock: true, effective_mode: "mock",
      mock_notice: "已设置 CLOUDOPS_FORCE_MOCK=1，节点操作全部以模拟模式执行",
    });
    expect(screen.getByText(/模拟模式/)).toBeInTheDocument();
    expect(screen.getByText(/已强制模拟/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/ModeBadge.test.tsx`
Expected: FAIL，找不到 `./ModeBadge`

- [ ] **Step 3：`hooks/useCapabilities.ts`**

```ts
export { useCapabilities } from "./queries";
```

- [ ] **Step 4：`ModeBadge.tsx`**

```tsx
import { useCapabilities } from "../hooks/useCapabilities";

/** I1：只依据 effective_mode / force_mock，绝不回落到 ssh 字段。 */
export function ModeBadge() {
  const { data: caps } = useCapabilities();
  if (!caps) {
    return <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink-mute">检测中…</span>;
  }
  const real = caps.effective_mode === "real";
  const why = caps.force_mock ? "（已强制模拟）" : "";
  const title = real
    ? "节点操作调用系统 ssh/scp/rsync"
    : caps.mock_notice || "节点操作以模拟模式执行";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        real ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${real ? "bg-ok" : "bg-warn"}`} />
      {real ? "真实模式" : `模拟模式${why}`}
    </span>
  );
}
```

- [ ] **Step 5：跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/ModeBadge.test.tsx`
Expected: 2 passed

- [ ] **Step 6：Commit**

```bash
git add frontend/src/components/ModeBadge.tsx frontend/src/components/ModeBadge.test.tsx frontend/src/hooks/useCapabilities.ts
git commit -m "feat(frontend): 模式徽章严格取自 effective_mode"
```

### Task 2.4：StatusTag、TopBar、Shell、路由与总览页

**Files:**
- Create: `frontend/src/components/StatusTag.tsx` `TopBar.tsx` `Shell.tsx` `ConfirmDialog.tsx`
- Create: `frontend/src/pages/Overview.tsx` `Envs.tsx` `Flows.tsx` `FlowWizard.tsx` `Packages.tsx` `Backups.tsx` `K8s.tsx`（页面 stub）
- Modify: `frontend/src/App.tsx` `frontend/src/main.tsx`
- Test: `frontend/src/components/StatusTag.test.tsx`

- [ ] **Step 1：失败测试 `StatusTag.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusTag } from "./StatusTag";

describe("StatusTag", () => {
  it("阶段状态用中文标签与色调", () => {
    render(<StatusTag kind="stage" value="passed" />);
    expect(screen.getByText("已通过")).toBeInTheDocument();
  });
  it("流程状态", () => {
    render(<StatusTag kind="flow" value="succeeded" />);
    expect(screen.getByText("成功")).toBeInTheDocument();
  });
  it("未知值原样显示，不崩溃", () => {
    render(<StatusTag kind="flow" value="archived" />);
    expect(screen.getByText("archived")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2：确认失败**

Run: `cd frontend && npx vitest run src/components/StatusTag.test.tsx`
Expected: FAIL，找不到 `./StatusTag`

- [ ] **Step 3：`StatusTag.tsx`**

```tsx
import { Tag } from "./ui/Tag";
import {
  BACKUP_STATUS_CN, FLOW_STATUS_CN, STAGE_CN, STATUS_CN, statusTone, type Tone,
} from "../lib/labels";

const MAP = {
  stage: STAGE_CN as Record<string, string>,
  flow: FLOW_STATUS_CN as Record<string, string>,
  node: STATUS_CN as Record<string, string>,
  backup: BACKUP_STATUS_CN as Record<string, string>,
};

export function StatusTag({ kind, value }: { kind: keyof typeof MAP; value: string }) {
  return <Tag tone={statusTone(value) as Tone}>{MAP[kind][value] ?? value}</Tag>;
}
```

- [ ] **Step 4：`TopBar.tsx`（6 个 tab，含 K8s 集群）**

```tsx
import { NavLink } from "react-router-dom";
import { ModeBadge } from "./ModeBadge";

const TABS = [
  { to: "/", label: "总览", end: true },
  { to: "/envs", label: "环境" },
  { to: "/flows", label: "流程" },
  { to: "/packages", label: "安装包" },
  { to: "/backups", label: "备份" },
  { to: "/k8s", label: "K8s 集群" },
];

export function TopBar() {
  return (
    <header className="sticky top-0 z-40 flex items-center gap-6 border-b border-line bg-panel px-6 py-3">
      <div className="flex items-center gap-2.5">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
          <rect x="1" y="1" width="24" height="24" rx="6" fill="#2563eb" />
          <path d="M7 16.5l4-7 4 7" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="18.5" cy="8.5" r="1.8" fill="#fff" />
        </svg>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink">ShipDesk Console</div>
          <div className="text-[11px] text-ink-mute">安装 / 升级 流程编排</div>
        </div>
      </div>
      <nav className="flex flex-1 items-center gap-1">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `rounded-btn px-3 py-1.5 text-sm transition-colors ${
                isActive ? "bg-brand-soft font-semibold text-brand" : "text-ink-soft hover:text-ink"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <ModeBadge />
    </header>
  );
}
```

- [ ] **Step 5：`Shell.tsx`**

```tsx
import { Outlet } from "react-router-dom";
import { TopBar } from "./TopBar";

export function Shell() {
  return (
    <div className="min-h-full">
      <TopBar />
      <main className="mx-auto w-full max-w-[1400px] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 6：`ConfirmDialog.tsx`**

```tsx
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  danger?: boolean;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open, title, body, danger, confirmLabel = "确认", busy, onCancel, onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      width={460}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-soft whitespace-pre-line">{body}</p>
    </Modal>
  );
}
```

- [ ] **Step 7：`pages/Overview.tsx`**

```tsx
import { Link } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { StatusTag } from "../components/StatusTag";
import { useAudit, useOverview } from "../hooks/queries";
import { fmtBytes, fmtTime } from "../lib/format";
import { modeLabel } from "../lib/labels";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-line bg-panel px-4 py-3.5 shadow-card">
      <div className="text-xs text-ink-mute">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-mute">{sub}</div>}
    </div>
  );
}

export default function Overview() {
  const { data: ov } = useOverview();
  const { data: audit } = useAudit(12);

  if (!ov) return <div className="text-sm text-ink-mute">加载总览…</div>;

  const running = ov.flows_by_status["running"] ?? 0;
  const failed = ov.flows_by_status["failed"] ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="安装环境" value={String(ov.environments)} sub={`${ov.nodes_total} 台节点 · 物理 ${ov.nodes_physical} / 虚拟 ${ov.nodes_virtual}`} />
        <Stat label="流程总数" value={String(ov.flows_total)} sub={`进行中 ${running} · 失败 ${failed}`} />
        <Stat label="安装包" value={String(ov.packages)} sub={fmtBytes(ov.packages_bytes)} />
        <Stat label="备份点" value={String(ov.backups)} sub={`可恢复 ${ov.backups_restorable} · ${fmtBytes(ov.backups_bytes)}`} />
      </div>

      <Card title="最近流程" actions={<Link to="/flows?new=1" className="text-xs font-medium text-brand hover:underline">新建流程</Link>}>
        <Table head={["流程", "模式", "环境", "进度", "状态", "更新时间"]}>
          {ov.recent_flows.length === 0 && (
            <tr><Td colSpan={6}><Empty>还没有流程，点击右上角「新建流程」</Empty></Td></tr>
          )}
          {ov.recent_flows.map((f) => (
            <Tr key={f.id}>
              <Td>
                <Link to={`/flows/${f.id}`} className="font-medium text-brand hover:underline">{f.name}</Link>
              </Td>
              <Td className="text-ink-soft">{modeLabel(f.mode)}</Td>
              <Td className="text-ink-soft">{f.env_name || "—"}</Td>
              <Td className="font-mono text-xs">{f.progress.done}/{f.progress.total}</Td>
              <Td><StatusTag kind="flow" value={f.status} /></Td>
              <Td className="text-xs text-ink-mute">{fmtTime(f.updated_at)}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Card title="操作审计" sub="最近 12 条">
        <Table head={["时间", "操作者", "动作", "对象", "结果"]}>
          {(audit ?? []).length === 0 && <tr><Td colSpan={5}><Empty>暂无审计记录</Empty></Td></tr>}
          {(audit ?? []).map((a) => (
            <Tr key={a.id}>
              <Td className="whitespace-nowrap text-xs text-ink-mute">{fmtTime(a.ts)}</Td>
              <Td className="text-ink-soft">{a.operator}</Td>
              <Td className="font-mono text-xs">{a.action}</Td>
              <Td className="font-mono text-xs text-ink-mute">{a.target}</Td>
              <Td><StatusTag kind="flow" value={a.result === "ok" ? "succeeded" : "failed"} /></Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 8：页面 stub（M3–M5 会替换）**

`frontend/src/pages/Envs.tsx`：

```tsx
export default function Envs() {
  return <div className="text-sm text-ink-mute">环境页占位</div>;
}
```

`frontend/src/pages/Flows.tsx` / `FlowWizard.tsx` / `Packages.tsx` / `Backups.tsx` / `K8s.tsx` 同构，各自导出默认组件返回 `<div className="text-sm text-ink-mute">XXX 页占位</div>`，文案分别写「流程列表占位」「流程向导占位」「安装包占位」「备份点占位」「K8s 集群占位」。

`FlowWizard.tsx` 需从路由参数取 id 以便后续替换：

```tsx
import { useParams } from "react-router-dom";

export default function FlowWizard() {
  const { id } = useParams();
  return <div className="text-sm text-ink-mute">流程向导占位 {id}</div>;
}
```

- [ ] **Step 9：`App.tsx` 路由表**

```tsx
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Shell } from "./components/Shell";
import Overview from "./pages/Overview";
import Envs from "./pages/Envs";
import Flows from "./pages/Flows";
import FlowWizard from "./pages/FlowWizard";
import Packages from "./pages/Packages";
import Backups from "./pages/Backups";
import K8s from "./pages/K8s";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Overview /> },
      { path: "envs", element: <Envs /> },
      { path: "flows", element: <Flows /> },
      { path: "flows/:id", element: <FlowWizard /> },
      { path: "packages", element: <Packages /> },
      { path: "backups", element: <Backups /> },
      { path: "k8s", element: <K8s /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 10：`main.tsx` 接 Provider**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ToastProvider } from "./components/ToastProvider";
import { queryClient } from "./hooks/queryClient";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>
);
```

- [ ] **Step 11：跑测试 + 构建**

Run: `cd frontend && npx vitest run && npm run build`
Expected: 全绿，构建成功

- [ ] **Step 12：浏览器实盘验证**

后端已在 8848（若端口被占用，先按项目记忆确认占用者身份再处理，勿盲杀）：

```bash
cd backend-java && java -jar target/cloudops-console-2.0.0.jar
cd frontend && npm run dev
```

Run: 打开 `http://127.0.0.1:5173/`
Expected: 顶栏出现 6 个 tab 与 ShipDesk 标识；模式徽章显示「模拟模式（已强制模拟）」或「真实模式」（取决于本机 ssh）；总览 4 张卡片有数字；控制台无 error。

- [ ] **Step 13：Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): 路由 Shell、顶栏与总览页"
```

---

## M3 环境页

### Task 3.1：`lib/summarize.ts` 与只读节点矩阵

**Files:**
- Create: `frontend/src/lib/summarize.ts` `frontend/src/components/env/NodeMatrixReadonly.tsx`
- Test: `frontend/src/lib/summarize.test.ts`

- [ ] **Step 1：失败测试**

```ts
import { describe, it, expect } from "vitest";
import { groupNodes, roleBreakdown } from "./summarize";
import type { NodeSpec } from "../api/types";

const n = (over: Partial<NodeSpec>): NodeSpec => ({
  id: "x", hostname: "h", ip: "1.1.1.1", role: "worker", machine_type: "virtual",
  ssh_port: 22, ssh_user: "root", status: "unknown", precheck_issues: [], ...over,
});

describe("summarize", () => {
  it("按机器形态分组", () => {
    const g = groupNodes([n({ machine_type: "physical", id: "p" }), n({ id: "v" })]);
    expect(g.physical).toHaveLength(1);
    expect(g.virtual).toHaveLength(1);
  });
  it("角色分布按数量降序", () => {
    const r = roleBreakdown([n({ role: "worker" }), n({ role: "worker" }), n({ role: "control" })]);
    expect(r).toEqual([{ role: "worker", label: "工作节点", count: 2 }, { role: "control", label: "控制节点", count: 1 }]);
  });
});
```

- [ ] **Step 2：确认失败**

Run: `cd frontend && npx vitest run src/lib/summarize.test.ts`
Expected: FAIL，找不到模块

- [ ] **Step 3：实现 `summarize.ts`**

```ts
import type { MachineType, NodeRole, NodeSpec } from "../api/types";
import { ROLE_CN } from "./labels";

export const groupNodes = (nodes: NodeSpec[]): Record<MachineType, NodeSpec[]> => ({
  physical: nodes.filter((x) => x.machine_type === "physical"),
  virtual: nodes.filter((x) => x.machine_type === "virtual"),
});

export function roleBreakdown(nodes: NodeSpec[]) {
  const m = new Map<NodeRole, number>();
  for (const x of nodes) m.set(x.role, (m.get(x.role) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => ({ role, label: ROLE_CN[role], count }));
}
```

- [ ] **Step 4：确认通过**

Run: `cd frontend && npx vitest run src/lib/summarize.test.ts`
Expected: 2 passed

- [ ] **Step 5：`components/env/NodeMatrixReadonly.tsx`**

```tsx
import { Table, Td, Tr } from "../ui/Table";
import { Tag } from "../ui/Tag";
import { StatusTag } from "../StatusTag";
import { Empty } from "../ui/Empty";
import { groupNodes } from "../../lib/summarize";
import { fmtTime } from "../../lib/format";
import type { NodeSpec } from "../../api/types";

const PHYS_HEAD = ["主机名", "IP", "角色", "厂商", "型号", "机房", "机柜", "网卡", "RAID", "状态", "检测时间"];
const VIRT_HEAD = ["主机名", "IP", "角色", "平台", "vCPU", "内存", "磁盘", "模板", "状态", "检测时间"];

function spec(n: NodeSpec): string[] {
  return n.machine_type === "physical"
    ? [n.hostname, n.ip, n.role, n.vendor ?? "—", n.model ?? "—", n.idc ?? "—", n.rack ?? "—",
       n.nic_speed ?? "—", n.raid_level ?? "—", n.status, fmtTime(n.last_checked_at)]
    : [n.hostname, n.ip, n.role, n.host_platform ?? "—", String(n.vcpu ?? "—"), String(n.memory_gb ?? "—"),
       String(n.disk_gb ?? "—"), n.image_template ?? "—", n.status, fmtTime(n.last_checked_at)];
}

export function NodeMatrixReadonly({ nodes }: { nodes: NodeSpec[] }) {
  const { physical, virtual } = groupNodes(nodes);
  if (nodes.length === 0) return <Empty>该环境暂未登记节点</Empty>;

  const cell = (v: string, i: number) =>
    i === 2 ? <Tag tone="brand">{v}</Tag>
      : i === 8 || i === 9 ? <StatusTag kind="node" value={v} />
      : <span className={i >= 3 && i <= 7 ? "text-ink-soft" : "font-mono text-xs"}>{v}</span>;

  const rows = (list: NodeSpec[]) =>
    list.map((n) => (
      <Tr key={n.id}>
        {spec(n).map((v, i) => <Td key={i}>{cell(v, i)}</Td>)}
      </Tr>
    ));

  return (
    <div className="flex flex-col gap-5">
      {physical.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold text-ink-soft">物理机节点 · {physical.length} 台</h4>
          <Table head={PHYS_HEAD}>{rows(physical)}</Table>
        </div>
      )}
      {virtual.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold text-ink-soft">虚拟机节点 · {virtual.length} 台</h4>
          <Table head={VIRT_HEAD}>{rows(virtual)}</Table>
        </div>
      )}
    </div>
  );
}
```

> `StatusTag kind="node"` 的索引在物理/虚拟两种列序下分别是 9 与 8，所以判断用 `i === 8 || i === 9`；角色固定在索引 2。

- [ ] **Step 6：Commit**

```bash
git add frontend/src/lib/summarize.ts frontend/src/lib/summarize.test.ts frontend/src/components/env
git commit -m "feat(frontend): 节点矩阵只读视图"
```

### Task 3.2：新建环境对话框 + 环境列表页

**Files:**
- Create: `frontend/src/components/env/NewEnvDialog.tsx`
- Modify: `frontend/src/pages/Envs.tsx`（替换 stub）

- [ ] **Step 1：`NewEnvDialog.tsx`**

```tsx
import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useCreateEnv } from "../../hooks/queries";
import { useToast } from "../ToastProvider";
import { ApiError } from "../../api/client";
import { inputCls, labelCls, Field } from "../ui/Field";

const EMPTY = { name: "", description: "", base_domain: "", ntp_server: "", timezone: "Asia/Shanghai", dns_servers: "" };

export function NewEnvDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [v, setV] = useState(EMPTY);
  const create = useCreateEnv();
  const toast = useToast();
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));

  const submit = () => {
    if (!v.name.trim()) { toast("环境名称必填", "warn"); return; }
    create.mutate(
      {
        name: v.name.trim(),
        description: v.description,
        base_domain: v.base_domain,
        ntp_server: v.ntp_server,
        timezone: v.timezone,
        dns_servers: v.dns_servers.split("\n").map((s) => s.trim()).filter(Boolean),
      },
      {
        onSuccess: (env) => { toast(`环境「${env.name}」已创建`); setV(EMPTY); onCreated(env.id); },
        onError: (e) => toast(e instanceof ApiError ? e.message : "创建失败", "error"),
      }
    );
  };

  return (
    <Modal
      open={open}
      title="新建环境"
      sub="先登记环境全局参数，节点矩阵在流程的「环境登记」阶段逐台填写"
      width={560}
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button onClick={submit} disabled={create.isPending}>创建</Button></>}
    >
      <div className="flex flex-col gap-3.5">
        <Field label={<span className={labelCls}>环境名称 *</span>}>
          <input className={inputCls} value={v.name} onChange={set("name")} placeholder="生产-AZ1" />
        </Field>
        <Field label={<span className={labelCls}>描述</span>}>
          <input className={inputCls} value={v.description} onChange={set("description")} />
        </Field>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label={<span className={labelCls}>基础域名</span>}>
            <input className={inputCls} value={v.base_domain} onChange={set("base_domain")} placeholder="saas.internal.com" />
          </Field>
          <Field label={<span className={labelCls}>NTP 服务器</span>}>
            <input className={inputCls} value={v.ntp_server} onChange={set("ntp_server")} placeholder="ntp.internal.com" />
          </Field>
        </div>
        <Field label={<span className={labelCls}>DNS（每行一个）</span>}>
          <textarea className={`${inputCls} h-20 font-mono`} value={v.dns_servers} onChange={set("dns_servers")} placeholder={"10.0.0.10\n10.0.0.11"} />
        </Field>
        <Field label={<span className={labelCls}>时区</span>}>
          <input className={inputCls} value={v.timezone} onChange={set("timezone")} />
        </Field>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2：`components/ui/Field.tsx`（表单小工具，M4 复用）**

```tsx
import type { ReactNode } from "react";

export const inputCls =
  "w-full rounded-btn border border-line bg-panel px-2.5 py-1.5 text-sm text-ink outline-none " +
  "placeholder:text-ink-mute focus:border-brand focus:ring-2 focus:ring-brand/20";

export const labelCls = "text-xs font-medium text-ink-soft";

export function Field({ label, hint, children, className = "" }: {
  label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-4 text-ink-mute">{hint}</span>}
    </label>
  );
}
```

- [ ] **Step 3：`pages/Envs.tsx`**

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { Tag } from "../components/ui/Tag";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NodeMatrixReadonly } from "../components/env/NodeMatrixReadonly";
import { NewEnvDialog } from "../components/env/NewEnvDialog";
import { useToast } from "../components/ToastProvider";
import { useDeleteEnv, useEnvironments } from "../hooks/queries";
import { endpoints, qk } from "../api/endpoints";
import { fmtDate } from "../lib/format";
import type { Environment } from "../api/types";

export default function Envs() {
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState<Environment | null>(null);
  const [toDelete, setToDelete] = useState<Environment | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: envs = [] } = useEnvironments();
  const delEnv = useDeleteEnv();
  const addNodes = useMutation({
    mutationFn: (envId: string) => endpoints.addNodes(envId, demoNodes()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.envs }); toast("已追加演示节点"); },
  );

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="安装环境"
        sub={`${envs.length} 套 · 节点矩阵决定组件分派`}
        actions={<Button size="sm" onClick={() => setShowNew(true)}>新建环境</Button>}
      >
        <Table head={["名称", "描述", "域名", "节点", "物理/虚拟", "创建时间", "操作"]}>
          {envs.length === 0 && <tr><Td colSpan={7}><Empty>暂无环境，先创建一套再新建流程</Empty></Td></tr>}
          {envs.map((e) => (
            <Tr key={e.id}>
              <Td className="font-medium">{e.name}</Td>
              <Td className="text-ink-soft">{e.description || "—"}</Td>
              <Td className="font-mono text-xs text-ink-soft">{e.base_domain || "—"}</Td>
              <Td className="font-mono">{e.summary?.total ?? e.nodes.length}</Td>
              <Td className="font-mono text-xs">{e.summary?.physical ?? 0} / {e.summary?.virtual ?? 0}</Td>
              <Td className="text-xs text-ink-mute">{fmtDate(e.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setDetail(e)}>节点</Button>
                  <Button size="sm" variant="ghost" onClick={() => addNodes.mutate(e.id)}>+演示节点</Button>
                  <Button size="sm" variant="ghost" onClick={() => nav(`/flows?new=1&env=${e.id}`)}>建流程</Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(e)}>删除</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <NewEnvDialog open={showNew} onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); nav(`/flows?new=1&env=${id}`); }} />

      <Modal open={!!detail} title={detail?.name ?? ""} width={1080} onClose={() => setDetail(null)}
        sub={detail ? `${detail.nodes.length} 台节点 · ${detail.timezone}` : ""}>
        {detail && <NodeMatrixReadonly nodes={detail.nodes} />}
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title="删除环境"
        body={toDelete ? `将删除环境「${toDelete.name}」及其 ${toDelete.nodes.length} 台节点登记。已创建的流程不受影响。` : ""}
        danger
        busy={delEnv.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          delEnv.mutate(toDelete.id, {
            onSuccess: () => { toast("环境已删除"); setToDelete(null); },
            onError: () => { toast("删除失败", "error"); setToDelete(null); },
          });
        }}
      />

      {envs.some((e) => e.validation_issues.length > 0) && (
        <Card title="校验提示">
          {envs.map((e) => e.validation_issues.map((x, i) => (
            <div key={`${e.id}-${i}`} className="flex items-center gap-2 py-1 text-xs text-warn">
              <Tag tone="warn">{e.name}</Tag>{x}
            </div>
          )))}
        </Card>
      )}
    </div>
  );
}

function demoNodes() {
  const base = { ssh_port: 22, ssh_user: "root", ssh_key_path: "" };
  return [
    ...[1, 2, 3].map((i) => ({
      ...base, hostname: `ctrl-phy-0${i}`, ip: `10.10.0.1${i}`, role: "control" as const,
      machine_type: "physical" as const, vendor: "Dell", model: "PowerEdge R750",
      idc: "AZ1-A", rack: `R0${i}`, nic_speed: "25GbE", raid_level: "RAID10",
      host_platform: null, vcpu: null, memory_gb: null, disk_gb: null, image_template: null,
    })),
    ...[1, 2].map((i) => ({
      ...base, hostname: `db-phy-0${i}`, ip: `10.10.0.2${i}`, role: "db" as const,
      machine_type: "physical" as const, vendor: "Huawei", model: "2288H V6",
      idc: "AZ1-A", rack: `R0${i + 3}`, nic_speed: "25GbE", raid_level: "RAID10",
      host_platform: null, vcpu: null, memory_gb: null, disk_gb: null, image_template: null,
    })),
    ...[1, 2, 3, 4].map((i) => ({
      ...base, hostname: `worker-vm-0${i}`, ip: `10.10.1.${20 + i}`, role: "worker" as const,
      machine_type: "virtual" as const, host_platform: "VMware vSphere 8", vcpu: 16,
      memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "",
      vendor: null, model: null, idc: null, rack: null, nic_speed: null, raid_level: null,
    })),
  ];
}
```

- [ ] **Step 4：验证**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npx vitest run && npm run build`
Expected: 全绿

浏览器：`/envs` 可新建环境、查看节点矩阵、追加演示节点、删除；顶栏 tab 高亮在「环境」。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/Envs.tsx frontend/src/components/env frontend/src/components/ui/Field.tsx
git commit -m "feat(frontend): 环境列表页与节点矩阵"
```

---

## M4 流程向导（三种 mode 通用，目录驱动）

> **契约校正（实施 M4 时逐个对 Java 源码核实，后续任务以此为准）**
>
> 1. `FieldType` 实际拼写为 `text | number | select | multiselect | boolean | textarea | node_table`；`multiline_list` 只由 `Workflow.textareaField` 置位（`Workflow.java:72,92-93`），不存在既是列表又是其他类型的字段。
> 2. 计划里的 `FieldRenderer` **漏了 `multiselect`**（`target_roles`，`Workflow.java:196-198`，默认值是 List），必须渲染复选框组并回传 `string[]`；`select` 后端按字符串读取（`StageExecutor.java:668`），保持字符串。
> 3. `node_table` 字段**不能套 `components/ui/Field.tsx`**：`Field` 是 `<label>` 包装，契约是「一个 Field 一个控件」；复合控件用 `<div role="group" aria-labelledby>`。
> 4. 演示数据里的角色 `"db"` 不存在，真值是 `"database"`。`POST /environments/{id}/nodes` 走 Jackson 枚举绑定会 400 拒绝未知值，而阶段路径 `NodeRole.fromValue` 会把未知值**静默降级为 worker**（`NodeRole.java:24`），所以前端必须严格。
> 5. `Workflow.asStringList` 按逗号（含全角，）切分字符串，**不按换行切**；`coerce` 对 `multiline_list` 字段总是先切好再提交，因此 `dns_servers` 之类的字段必须走数组载荷。
> 6. 后端缺陷已修（`4060b85`）：`ApiController` 原先把 `inputs.dns_servers` 直接强转 `List<String>`，前端提交字符串即 500；目录里 `dns_servers` 声明为 `text` 却写「每行一个」，已改为 `textareaField`（真 `multiline_list`）。E2E 走 `env_register` 时**控制节点至少 2 台**，否则业务校验回 422「仅 1 台控制节点，不具备高可用能力」。
> 7. `number` 字段的新行留空串 `""`：`Workflow.validateStageInputs` 先执行，会回 422「虚拟机 xxx 缺少「vCPU」」这类可读字段错误，不会走到 `Integer.parseInt("")` 抛 500。
> 8. 顶层 `number` 字段留空必须由 `coerce` 产出 **`null` 而不是 `""`**（`e1d538e`）：后端每个数字位点都是 `x.get(k) != null ? Integer.parseInt(s(x.get(k))) : 默认值`（`StageExecutor.java:675,851`、`ApiController.java:288,306,310-312`），键存在且为 `""` 会在阶段**执行期**抛 NumberFormatException；显式 `null` 才回落到服务端默认值，必填项仍被 `isEmpty(null)` 拦成 422。`initialValues` 相应把已存的 `null` 当缺省回显 `default`。T4.6/T4.7 的表单回显与提交都必须沿用这条。
> 9. **SSE 生命周期（`fdc158b`/`fc2085d`/`edb81c7`，Chrome 真机 7 阶段全流程验过）**：
>    - 建连时服务端先重放 LogBus 历史，**每一帧带 `replay: true`**，实时帧无标记（`ApiController.java` `streamStage`）。`stage_done` 只在 `!replay` 时推进向导，否则刷新页面会把已完成阶段再往前推一格。
>    - 阶段进入终态后，服务端轮询线程下发 `{type:"close", status}`（**不进历史**）再 `complete()`。客户端收到 close **必须主动 `es.close()`**：不关闭则浏览器自动重连，每轮重连重放全量历史，日志与步骤被反复打回。
>    - 重跑同一阶段前 `LogBus.clear(key)`（`StageExecutor.submit`），否则上一轮的 `stage_done` 会被新连接重放。
>    - 日志**不按内容去重**：`StageExecutor` 按行发事件（`:169-170`）、逐节点预检输出同文案（`:519-521`），而 LogBus 的 `ts` 只到秒，按 `ts|level|message` 去重会真丢行。改为「每代连接（`onopen`）重建缓冲区」。
>    - 面板在终态把数据源从流切成 `GET /logs`，**必须同时失效 `qk.stageLogs`**：历史停在运行开始前的快照，末步输出与「阶段通过」横幅会在 UI 上凭空消失（`running` 期间的 step 帧不重取，避免请求风暴）。
> 10. **后端加固（`fdc158b`）后续任务需沿用**：预检脚本按候选路径定位、解释器**实测探测**（Windows 的 `python3` 常是 Microsoft Store 别名，退出码 49）并强制 `-X utf8`（否则中文按 GBK 输出、Java 侧解码成乱码）；远程入参一律 `NodeService.shellQuote`；`remote_dir` 必须是绝对路径且只含 `A-Za-z0-9._/-`，并发度收敛到 **1~32**（0 会让 `install_execute` 的分批循环永不退出）；`package_distribute`/`install_execute`/`post_verify` 的模拟结论显式标注 `[MOCK]` 与「未查询真实集群 / 未验证服务可用性」，安装脚本缺失与全部冒烟接口不可达改为**失败**而非静默通过。
> 11. **流/轮询切换（`dd93733`/`7fbe534`）**：`applyEvent` 末尾必须是 `else if (d.type === "close")`，未知帧一律 no-op（裸 `else` 会被任意新帧类型误关流）。`es.onopen` 里除了重建缓冲区，**还要 `clearInterval` 掉降级轮询并清 `degraded`**：否则重连成功后面板仍停在「已降级」，把轮询和流两份数据同时挂着。降级期间流**不再是数据源**（`stream.degraded ? [] : stream.logs/steps`），日志只从 `GET /logs` 取。
> 12. **向导与后端门禁（`7fbe534`/`4dc3776`）**：`<Wizard key={flow.id}>` 必须有——草稿 `values` 是组件内 state，不重挂就会跨流程带旧值提交。`onDone` 签名收口为 `(stageKey, status, error?)`，回调里先 `if (key !== active.key) return;`：SSE 的迟到终态帧不能推进已被用户切走的面板。`release_name` **只读 `flow.stages[0].inputs`**（后端把流程级字段落在首阶段），逐阶段回退查找会读到空草稿。锁定的阶段**不可点**（`StageRail.tsx:17` 的 `selectable = s !== "locked"`，`:36` `disabled={!clickable}`）—— 落地时改成了禁用态，比原计划的「照样能点」更符合 I2；`title` 用「该阶段尚未解锁，需先完成前置阶段」，不复读状态名（原计划文案会渲染成「未解锁：未解锁」）。
> 13. **分片续传与取消的诚实边界（`f89b997`）**：`UploadService` 的会话在内存 `ConcurrentHashMap` 里，`init` 每次铸新 id 且 `doneChunks` 从空开始，`status()` 对未知 id 抛错——**服务端不支持“按文件名找回会话”**，所以续传只能由前端持久化：localStorage `shipdesk.upload.<name>|<size>|<lastModified>` → `{upload_id, flow_id}`，`flow_id` 匹配才复用，任何 `uploadStatus` 失败即丢弃，`complete` 成功后清除。取消按钮只认 `cancellable`（分片路径），单请求 `<64 MB` 一把梭 multipart，abort 时服务端早已收完包体，**不给它渲染「取消上传」**。`signal` 要作为参数一路传到 `fetch`（`api.post(path, body, {signal})`），且在派发前、每片前、`complete` 前、成功 toast 前逐次复查 `aborted`。
> 14. **上传区/包页显示诚实化（`fd5f6e3`/`9c42126`）**：非 secure context 下 `navigator.clipboard` 是 **`undefined`**（不是 reject，`lib.dom` 标成非可选所以 tsc 查不出），点击前必须挡；列表查询 `isLoading` 时不得渲染成「仓库为空」（与 `Flows`/`Envs` 同一 `colSpan` 占位行）；读完文件要 `input.value = ""`，否则再选同一个文件不触发 `change`；单请求路径 `progress` 只在起点 seed 一次（hook 不再更新），所以 `totalChunks <= 1` 时**不给「分片 0/1」、不给定宽进度条**，改全宽 `animate-pulse` 不确定条，字节数直接用 `progress.sentBytes` 不回算百分比；`dragover` **永远 `preventDefault()`**（不取消则浏览器不派发 `drop`，OS 拖放会直接打开文件卸载 SPA），禁用态只额外 `dropEffect = "none"` 并跳过高亮。`stage.inputs` 是 `Record<string, unknown>`，读 `_package_ids` 走 `Array.isArray` + 逐元素 `typeof`，不裸 `as string[]`（I3 依赖这些键存活）。阈值文案统一「≥64 MB」（`pickStrategy` 用 `>=`）。
> 15. **备份页以后端事实为准（`c204e42`/`e251ee8`/`e87168a`）**：`POST /backups/{bid}/restore` 在 404/428/409 三道门禁之后才查环境是否还在：`store.getEnv(b.envId)`（`ApiController.java:733`，其前是 `:725` 备份不存在 404、`:727-728` 未确认 428、`:730-731` 不可恢复/已过期 409），**环境已删必 404**，后端不认备份记录里的 `nodes_covered`；所以前端只在「清单加载完且命中不到该环境」时**禁用确认**（`ConfirmDialog` 新增 `confirmDisabled`，不复用 `busy`——那会把按钮文案变成「处理中…」，又是一句谎话），加载中照常放行（loading ≠ 不存在）。`restorable`/`status`/`error`/`verified_at` 全由后端持有（校验不一致与 409「备份目录不存在」都会把 `status` 写成 `failed` 并存 `error`），前端一律不重推、且失败分支也要失效列表。校验是磁盘遍历、恢复是节点级操作，均单发（在途时锁全部行入口）。恢复结算时结果窗绑定 TQ `variables`（用户点的那一行）无条件弹出，只有「关确认窗」用 `setToRestore((cur) => cur?.id === b.id ? null : cur)` —— 不在渲染期写 ref。`restored_nodes` 是目标 hostname 清单、含「无备份数据，跳过」的节点，所以文案只能说「目标 N 台」，不能说「已恢复 N 台」。
> 16. **K8s 集群页（T5.4 以此为准）**：`GET /k8s/clusters/{id}/releases` 经 `K8sOpsService.call`，入口 `K8S_OPS = CLOUDOPS_K8S_OPS ?? "k8s-ops/dist/index.js"` 相对 **JVM CWD** 解析（`K8sOpsService.java:25-27`）；从 `backend-java/` 启动时该路径不存在，失败**不抛异常、HTTP 200**，响应体是 `{ok:false, error:"<node stderr>"}`（一整坨 MODULE_NOT_FOUND 栈）。前端必须按 `error` 读一行给人看，不许 `JSON.stringify(data).slice(0,300)` 把栈直接糊在页面上。**成功体的 releases 是嵌套的**：`k8s-ops/src/config.ts:86` 的 `output(true, data)` 产出 `{ok:true, data:{releases:[…]}}`，Java 原样透传（`ApiController.java:884-889`），计划正文那句顶层 `data.releases` 永远读不到数组。行字段来自 `helm list -o json`，键是 `name/namespace/revision/status/chart/app_version`（**没有 `version`**，`chart` 本身就是 `<name>-<version>`），所以「Chart」与「App 版本」两列照此排。集群不存在走 `ApiException(404, Map.of("detail","集群不存在"))` → `client.ts:100` 抛 `ApiError`，查询态得同时接住 `isError`；`DELETE /k8s/clusters/{id}` 对未知 id 也回 ok，`Store.saveCluster` 在 `id==null` 时铸 `k8s-<uuid8>`，所以删除结果不能当存在性证明。集群列表 `isLoading` 时不得渲染成「尚未登记集群」；「建升级流程」走 `useNavigate("/flows?new=1&mode=upgrade_k8s")`（`Flows.tsx:31` 的 `?new=1` 开关与 `:88-89` 的 `presetEnv`/`presetMode` 预填已支持），不得整页刷新；「Helm 回滚」提示必须与 `components/flow/RollbackButton.tsx` 的真实行为一致（只在 `flow.mode === "upgrade_k8s"` 的流程向导头部出现，确实 `POST /flows/{id}/rollback` 触发 `helm rollback`，且不重置阶段状态）。
> 17. **K8s 集群页实施补充（T5.4 落地时逐条对源码复核，覆盖 Task 5.4 正文的相应文案）**：① `k8s_clusters` 这张登记表**只被本页面消费**——`StageExecutor.k8sCluster()`（`StageExecutor.java:1459-1465`）和 `POST /flows/{id}/rollback`（`ApiController.java:900-903`）都是现场从阶段 `inputs` 拼 `K8sCluster`，`cluster_id`（`Workflow.java:374`）只是个自由文本框，后端从不拿它去 `store.getCluster()`。所以 Step 2 的「按 `cluster_id` 引用该集群的阶段会找不到凭证」与 Card sub「供 upgrade_k8s 流程选择」都不成立，删除确认只能说「删除只影响本页面」。② `POST /k8s/clusters` **零校验**（`ApiController.java:860-863` 直接把体绑成 `K8sCluster`），空名字会存成一条无名记录，必填门禁只能在前端做（弹窗里给行内错误，不只 toast）。③ `context` 存了但没人用（`K8sOpsService.java:89-94` 只转发 `namespace`/`kubeconfig`，`helm.ts:13` 不带 `--kube-context`），字段必须标「仅登记备查」。④ `kubeconfig` **不接受直接粘贴 YAML 原文**：`config.ts:14-20` 对不像路径的值一律 `Buffer.from(v,"base64")`，所以弹窗只承诺「文件路径或 base64」。⑤ `{ok:true}` 而 `data.releases` 不是数组（`helm.ts:70` 的 `raw` 分支）、以及 200 空体（TanStack Query 直接判 error）都不是「namespace 下没有 release」，必须各给一条原因；`{ok:false}` 那支的常见原因提示只跟脚本失败走，不能贴到 404 上。
> 18. **K8s 页质量轮修正（`c13d2d1`→`8991171`，342 测试）**：① **`isFetching` 不能当「在途」门禁**——TQ5 首帧确实会 `fetchStatus:"fetching"`（`queryObserver.js` 的 `getOptimisticResult`），但 `networkMode` 默认 `online`，**断网时请求停在 `paused`**，`isFetching` 恒为 `false` 而 `data` 永远 `undefined`，只看它就会把空表长期摆在那儿。统一用 `const pending = data === undefined && !isError;`，这条同时兜住首帧。② `releaseError` 必须**先剔除栈帧再挑信息行**（`!FRAME && !includes("node:internal")` 过滤后再取**最后**一条命中关键词的行）：截断只剩帧的 stderr 会让「含 Error 的帧」抢先命中；取最后一条是因为 Node 把致命信息放在帧块之前、越靠后越致命；截断要补 `…`，否则读者不知道自己读到的是一刀切的片段。③ 删除集群要 `setReleasesFor((cur) => cur?.id === 被删 id ? null : cur)`，否则 `qk.clusters` 前缀失效会让那个面板带着已删集群的名字去 refetch，端着一个 404 挂在已经少了一行的表格下面。④ `qk.releases(id)` 的占位键**不能**写成 `["k8s","clusters",…]` 前缀形式——那会被 `invalidateQueries({queryKey: qk.clusters})` 命中，把已关闭的查询拉起来。⑤ 错误条前缀只对 `scriptFailed` 说「后端 helm list 未成功」，404（命令没发出去）与 `shapeMismatch`（命令恰恰成功了）改说「未取得清单」，否则句子和下一行的具体原因自相矛盾。
> 19. **Task 5.4 已整体退役（2026-10-06）**：K8s 集群页与 `/api/k8s/clusters*` 五个端点、`Store` 的集群读写与 `k8s_clusters` DDL 一并删除 —— 用户判定「升级这块是直接对接环境」，核实成立（契约校正 17 ① 就是删除依据：登记表只被那个页面消费，执行与回滚都从阶段 `inputs` 现场拼 `K8sCluster`）。上面 16/17/18 三条描述的代码已不存在，留作实施期判断的记录；变更全文见 spec §15。

### Task 4.1：表单值合并与转换 —— 不变量 I3（TDD）

**Files:**
- Create: `frontend/src/flow/formValue.ts`
- Test: `frontend/src/flow/formValue.test.ts`

- [ ] **Step 1：失败测试**

```ts
import { describe, it, expect } from "vitest";
import { mergeInputs, coerce } from "./formValue";
import type { FormField } from "../api/types";

const num: FormField = { key: "control_count", label: "控制节点数", type: "number", required: false, placeholder: "", help: "", hint: "", default: 3 };
const ml: FormField = { key: "dns_servers", label: "DNS", type: "textarea", required: false, placeholder: "", help: "", hint: "", multiline_list: true };
const bool: FormField = { key: "strict_mode", label: "严格模式", type: "boolean", required: false, placeholder: "", help: "", hint: "", default: false };

describe("formValue", () => {
  it("mergeInputs 保留服务端下划线键（I3）", () => {
    const server = { _package_id: "pk1", _package_ids: ["pk1"], ssh_user: "root" };
    const collected = { ssh_user: "ops", ssh_port: 2222 };
    expect(mergeInputs(server, collected)).toEqual({
      _package_id: "pk1", _package_ids: ["pk1"], ssh_user: "ops", ssh_port: 2222,
    });
  });

  it("mergeInputs 不修改入参", () => {
    const server = { a: 1 };
    mergeInputs(server, { b: 2 });
    expect(server).toEqual({ a: 1 });
  });

  it("number：空串→空串，数字→number", () => {
    expect(coerce(num, "")).toBe("");
    expect(coerce(num, "5")).toBe(5);
  });
  it("multiline_list：按行切并去空", () => {
    expect(coerce(ml, "10.0.0.10\n\n10.0.0.11")).toEqual(["10.0.0.10", "10.0.0.11"]);
    expect(coerce(ml, [])).toEqual([]);
  });
  it("boolean 原样", () => {
    expect(coerce(bool, true)).toBe(true);
  });
});
```

- [ ] **Step 2：确认失败**

Run: `cd frontend && npx vitest run src/flow/formValue.test.ts`
Expected: FAIL，找不到模块

- [ ] **Step 3：实现**

```ts
import type { FlowStage, FormField } from "../api/types";

/** I3：服务端写入 inputs 的下划线键（_package_id / _package_ids 等）必须原样保留。 */
export const mergeInputs = (
  server: Record<string, unknown>,
  collected: Record<string, unknown>,
): Record<string, unknown> => ({ ...server, ...collected });

export function coerce(field: FormField, raw: unknown): unknown {
  if (field.type === "number") {
    if (raw === "" || raw == null) return "";
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (field.multiline_list) {
    if (Array.isArray(raw)) return raw;
    return String(raw ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (field.type === "boolean") return Boolean(raw);
  if (field.type === "node_table") return Array.isArray(raw) ? raw : [];
  return raw ?? "";
}

export function initialValues(stage: FlowStage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of stage.form_fields) {
    const stored = stage.inputs[f.key];
    out[f.key] = stored !== undefined ? stored : (f.default ?? (f.type === "boolean" ? false : f.type === "node_table" ? [] : ""));
  }
  return out;
}

export function collect(stage: FlowStage, values: Record<string, unknown>): Record<string, unknown> {
  const collected: Record<string, unknown> = {};
  for (const f of stage.form_fields) collected[f.key] = coerce(f, values[f.key]);
  return mergeInputs(stage.inputs, collected);
}
```

- [ ] **Step 4：确认通过**

Run: `cd frontend && npx vitest run src/flow/formValue.test.ts`
Expected: 5 passed

- [ ] **Step 5：Commit**

```bash
git add frontend/src/flow/formValue.ts frontend/src/flow/formValue.test.ts
git commit -m "feat(frontend): 表单值合并保留服务端 artifacts"
```

### Task 4.2：FieldRenderer 与 DynamicForm

**Files:**
- Create: `frontend/src/flow/FieldRenderer.tsx` `frontend/src/flow/DynamicForm.tsx`

- [ ] **Step 1：`FieldRenderer.tsx`（覆盖后端全部 type）**

```tsx
import { inputCls, Field, labelCls } from "../components/ui/Field";
import { NodeMatrixEditor } from "./NodeMatrixEditor";
import type { FormField } from "../api/types";

export interface FieldRendererProps {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}

export function FieldRenderer({ field, value, onChange, disabled }: FieldRendererProps) {
  const label = (
    <span className={labelCls}>
      {field.label}
      {field.required && <span className="text-danger"> *</span>}
    </span>
  );
  const hint = field.help || undefined;

  if (field.type === "node_table") {
    return (
      <Field label={label} hint={hint} className="col-span-full">
        <NodeMatrixEditor field={field} value={(value as Record<string, unknown>[]) ?? []} onChange={onChange} disabled={disabled} />
      </Field>
    );
  }

  if (field.type === "select") {
    return (
      <Field label={label} hint={hint}>
        <select
          disabled={disabled}
          className={inputCls}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === "boolean") {
    return (
      <Field label={label} hint={hint}>
        <button
          type="button"
          disabled={disabled}
          role="switch"
          aria-checked={Boolean(value)}
          onClick={() => onChange(!value)}
          className={`relative h-6 w-11 rounded-full border transition-colors ${
            value ? "border-brand bg-brand" : "border-line bg-canvas"
          } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
        >
          <span
            className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-panel shadow-card transition-all ${
              value ? "left-[22px]" : "left-0.5"
            }`}
            style={{ height: 18, width: 18 }}
          />
        </button>
      </Field>
    );
  }

  if (field.type === "textarea") {
    const text = field.multiline_list && Array.isArray(value) ? value.join("\n") : String(value ?? "");
    return (
      <Field label={label} hint={hint} className="col-span-full">
        <textarea
          disabled={disabled}
          className={`${inputCls} h-24 font-mono`}
          value={text}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint}>
      <input
        disabled={disabled}
        type={field.type === "number" ? "number" : "text"}
        className={inputCls}
        value={String(value ?? "")}
        placeholder={field.placeholder}
        onChange={(e) => onChange(field.type === "number" ? e.target.value : e.target.value)}
      />
    </Field>
  );
}
```

> `type: "file"` 不在表单里渲染：安装包由 M5 的 `UploadZone` 走上传通道，阶段 inputs 里体现为 `_package_ids`。

- [ ] **Step 2：`NodeMatrixEditor.tsx`**

```tsx
import { Button } from "../components/ui/Button";
import type { ColumnDef, FieldGroup, FormField } from "../api/types";
import { ROLE_CN } from "../lib/labels";
import type { NodeRole } from "../api/types";

const ROLES = Object.keys(ROLE_CN) as NodeRole[];

const DEMO: Record<string, Record<string, unknown>[]> = {
  physical_nodes: [
    { hostname: "ctrl-phy-01", ip: "10.10.0.11", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "AZ1-A", rack: "R01", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
    { hostname: "ctrl-phy-02", ip: "10.10.0.12", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "AZ1-A", rack: "R02", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
    { hostname: "ctrl-phy-03", ip: "10.10.0.13", role: "control", vendor: "Dell", model: "PowerEdge R750", idc: "AZ1-A", rack: "R03", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
    { hostname: "db-phy-01", ip: "10.10.0.21", role: "db", vendor: "Huawei", model: "2288H V6", idc: "AZ1-A", rack: "R04", nic_speed: "25GbE", raid_level: "RAID10", ssh_key_path: "" },
  ],
  virtual_nodes: [
    { hostname: "worker-vm-01", ip: "10.10.1.21", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "worker-vm-02", ip: "10.10.1.22", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "worker-vm-03", ip: "10.10.1.23", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "worker-vm-04", ip: "10.10.1.24", role: "worker", host_platform: "VMware vSphere 8", vcpu: 16, memory_gb: 64, disk_gb: 500, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
    { hostname: "gw-vm-01", ip: "10.10.1.31", role: "gateway", host_platform: "VMware vSphere 8", vcpu: 8, memory_gb: 32, disk_gb: 200, image_template: "rocky9-tpl-v3", ssh_key_path: "" },
  ],
};

function blank(cols: ColumnDef[]): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const c of cols) r[c.key] = c.type === "role" ? "worker" : "";
  return r;
}

export interface NodeMatrixEditorProps {
  field: FormField;
  value: Record<string, unknown>[];
  onChange: (v: Record<string, unknown>[]) => void;
  disabled?: boolean;
}

export function NodeMatrixEditor({ field, value, onChange, disabled }: NodeMatrixEditorProps) {
  const groups: FieldGroup[] = field.groups ?? [{ key: field.key, title: field.label, fields: [] }];
  const rows = Array.isArray(value) ? value : [];

  const cell = (ri: number, key: string, v: unknown) =>
    onChange(rows.map((r, i) => (i === ri ? { ...r, [key]: v } : r)));

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.key} className="rounded-card border border-line">
          <header className="flex items-center justify-between gap-2 border-b border-line bg-canvas px-3 py-2">
            <span className="text-xs font-semibold text-ink-soft">
              {g.title} · {rows.length} 台
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={disabled}
                onClick={() => onChange([...rows, blank(g.fields)])}>+ 添加一台</Button>
              <Button size="sm" variant="ghost" disabled={disabled}
                onClick={() => onChange(DEMO[g.key] ? [...DEMO[g.key]] : [...rows])}>填充演示数据</Button>
            </div>
          </header>

          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-ink-mute">
              暂无节点。可「添加一台」逐台填写，或「填充演示数据」快速走通流程。
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-ink-mute">
                  {g.fields.map((c) => (
                    <th key={c.key} className="px-2 py-1.5" style={{ width: c.width }}>{c.label}</th>
                  ))}
                  <th className="w-10 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="border-t border-line">
                    {g.fields.map((c) => (
                      <td key={c.key} className="px-1.5 py-1">
                        {c.type === "role" ? (
                          <select
                            disabled={disabled}
                            className="w-full rounded-btn border border-line bg-panel px-1.5 py-1 outline-none focus:border-brand"
                            value={String(r[c.key] ?? "worker")}
                            onChange={(e) => cell(ri, c.key, e.target.value)}
                          >
                            {ROLES.map((x) => <option key={x} value={x}>{ROLE_CN[x]}</option>)}
                          </select>
                        ) : (
                          <input
                            disabled={disabled}
                            type={c.type === "number" ? "number" : "text"}
                            className="w-full rounded-btn border border-line bg-panel px-1.5 py-1 font-mono outline-none focus:border-brand"
                            value={String(r[c.key] ?? "")}
                            onChange={(e) => cell(ri, c.key, c.type === "number" ? e.target.value : e.target.value)}
                          />
                        )}
                      </td>
                    ))}
                    <td className="px-1.5 py-1 text-right">
                      <button
                        disabled={disabled}
                        aria-label={`删除第 ${ri + 1} 台`}
                        className="text-ink-mute hover:text-danger disabled:opacity-40"
                        onClick={() => onChange(rows.filter((_, i) => i !== ri))}
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3：`DynamicForm.tsx`**

```tsx
import { FieldRenderer } from "./FieldRenderer";
import type { FormField } from "../api/types";

export interface DynamicFormProps {
  fields: FormField[];
  values: Record<string, unknown>;
  onChange: (key: string, v: unknown) => void;
  disabled?: boolean;
}

export function DynamicForm({ fields, values, onChange, disabled }: DynamicFormProps) {
  if (fields.length === 0) {
    return <p className="text-xs text-ink-mute">本阶段无需填写参数，直接执行即可。</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
      {fields.map((f) => (
        <FieldRenderer
          key={f.key}
          field={f}
          disabled={disabled}
          value={values[f.key]}
          onChange={(v) => onChange(f.key, v)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4：验证 + Commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 无错误

```bash
git add frontend/src/flow
git commit -m "feat(frontend): 目录驱动的动态表单与节点矩阵编辑器"
```

### Task 4.3：StepList 与 LogConsole

**Files:**
- Create: `frontend/src/flow/StepList.tsx` `frontend/src/flow/LogConsole.tsx`

- [ ] **Step 1：`StepList.tsx`**

```tsx
import { fmtDuration } from "../lib/format";
import type { StepState } from "../api/types";

const GLYPH: Record<StepState["status"], string> = {
  pending: "○", running: "◐", passed: "✔", failed: "✕", skipped: "–",
};
const CLS: Record<StepState["status"], string> = {
  pending: "text-ink-mute", running: "text-brand", passed: "text-ok", failed: "text-danger", skipped: "text-ink-mute",
};

export function StepList({ steps }: { steps: StepState[] }) {
  if (steps.length === 0) return <p className="text-xs text-ink-mute">本阶段没有编排步骤。</p>;
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((s) => (
        <li key={s.id} className="rounded-card border border-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`font-mono text-sm ${CLS[s.status]}`}>{GLYPH[s.status]}</span>
            <span className="text-xs font-medium text-ink">
              {s.index + 1}. {s.title}
            </span>
            <span className="ml-auto font-mono text-[11px] text-ink-mute">
              {s.status === "running" ? "执行中…" : fmtDuration(s.duration_ms)}
            </span>
          </div>
          {s.detail && <p className="mt-1 pl-6 text-[11px] text-ink-mute">{s.detail}</p>}
          {s.output && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-btn bg-canvas px-2.5 py-2 font-mono text-[11px] leading-4 text-ink-soft">
              {s.output}
            </pre>
          )}
          {s.error && (
            <pre className="mt-2 whitespace-pre-wrap rounded-btn bg-danger/10 px-2.5 py-2 font-mono text-[11px] leading-4 text-danger">
              {s.error}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2：`LogConsole.tsx`（自动滚到底）**

```tsx
import { useEffect, useRef } from "react";
import type { LogLevel } from "../api/types";

/** 深底终端配色，保证与旧版 LogConsole 一致的可读性 */
const FG: Record<LogLevel, string> = {
  info: "text-[#c9d1d9]",
  warn: "text-[#ffd166]",
  error: "text-[#ff8a80]",
};

export interface LogLine { ts?: string; level: LogLevel; message: string }

export function LogConsole({ lines, height = 300 }: { lines: LogLine[]; height?: number }) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <pre
      ref={ref}
      style={{ height }}
      className="overflow-auto rounded-card border border-line bg-[#12151a] px-3 py-2.5 font-mono text-[11px] leading-5"
    >
      {lines.length === 0
        ? <span className="text-white/35">等待执行输出…</span>
        : lines.map((l, i) => (
            <div key={i} className={FG[l.level]}>{l.message}</div>
          ))}
    </pre>
  );
}
```

- [ ] **Step 3：Commit**

```bash
git add frontend/src/flow/StepList.tsx frontend/src/flow/LogConsole.tsx
git commit -m "feat(frontend): 步骤列表与日志控制台"
```

### Task 4.4：`useStageStream` —— 不变量 I4 + 轮询兜底（TDD）

**Files:**
- Create: `frontend/src/hooks/useStageStream.ts`
- Test: `frontend/src/hooks/useStageStream.test.tsx`
- Create: `frontend/src/test/fakeEventSource.ts`

- [ ] **Step 1：`test/fakeEventSource.ts`**

```ts
type Handler = (e: MessageEvent) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: Handler | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

export const resetFakeES = () => { FakeEventSource.instances = []; };
```

- [ ] **Step 2：失败测试**

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useStageStream } from "./useStageStream";
import { FakeEventSource, resetFakeES } from "../test/fakeEventSource";

vi.stubGlobal("EventSource", FakeEventSource);

const wrapperOf = (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

beforeEach(() => { resetFakeES(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useStageStream", () => {
  it("收到 log/step 事件写入本地状态，且 stage_done 不 close()（I4）", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const onDone = vi.fn();
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone }),
      { wrapper: wrapperOf(qc) }
    );

    const es = FakeEventSource.instances[0]!;
    expect(es.url).toContain("/api/flows/f1/stages/env_precheck/stream");

    act(() => es.emit({ type: "log", level: "info", message: "hello", ts: "1" }));
    expect(result.current.logs).toHaveLength(1);

    act(() => es.emit({ type: "step", stage: "env_precheck", step: { id: "s0", index: 0, title: "t", status: "running" } }));
    expect(result.current.steps[0]?.status).toBe("running");

    act(() => es.emit({ type: "stage_done", stage: "env_precheck", status: "passed" }));
    expect(es.closed).toBe(false);
    expect(onDone).toHaveBeenCalledWith("passed", undefined);

    act(() => es.emit({ type: "close", status: "passed" }));
    expect(es.closed).toBe(false);
  });

  it("无 EventSource 时轮询兜底刷新 flow", () => {
    vi.unstubAllGlobals();
    (globalThis as Record<string, unknown>).EventSource = undefined;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useStageStream("f1", "env_precheck", { enabled: true, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc) });
    act(() => { vi.advanceTimersByTime(1200); });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
  });
});
```

- [ ] **Step 3：确认失败**

Run: `cd frontend && npx vitest run src/hooks/useStageStream.test.tsx`
Expected: FAIL，找不到模块

- [ ] **Step 4：实现 `useStageStream.ts`**

```ts
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints, qk } from "../api/endpoints";
import type { LogLine } from "../flow/LogConsole";
import type { StageStatus, StepState, StreamEvent } from "../api/types";

const POLL_MS = 1_200;

export interface UseStageStreamOptions {
  enabled: boolean;
  onDone?: (status: StageStatus, error?: string | null) => void;
}

export interface StageStreamState {
  logs: LogLine[];
  steps: StepState[];
  running: boolean;
  error: string | null;
}

export function useStageStream(flowId: string, stageKey: string, opts: UseStageStreamOptions) {
  const qc = useQueryClient();
  const [state, setState] = useState<StageStreamState>({ logs: [], steps: [], running: false, error: null });
  const doneRef = useRef(opts.onDone);
  doneRef.current = opts.onDone;

  useEffect(() => {
    setState({ logs: [], steps: [], running: false, error: null });
    if (!opts.enabled || !flowId || !stageKey) return;

    const applyEvent = (d: StreamEvent) => {
      if (d.type === "log") {
        setState((s) => ({ ...s, running: true, logs: [...s.logs, { ts: d.ts, level: d.level, message: d.message }] }));
      } else if (d.type === "step") {
        setState((s) => {
          const idx = s.steps.findIndex((x) => x.id === d.step.id);
          const steps = idx < 0 ? [...s.steps, d.step] : s.steps.map((x, i) => (i === idx ? d.step : x));
          return { ...s, running: true, steps };
        });
      } else if (d.type === "stage_done") {
        setState((s) => ({ ...s, running: false, error: d.error ?? null }));
        // I4：不主动 close()，服务端发完 close 会自行结束流；手动 abort 会留 ERR_ABORTED
        doneRef.current?.(d.status, d.error ?? null);
      }
    };

    if (typeof EventSource === "undefined") {
      const t = setInterval(() => {
        qc.invalidateQueries({ queryKey: qk.flow(flowId) });
      }, POLL_MS);
      return () => clearInterval(t);
    }

    const url = `/api/flows/${flowId}/stages/${stageKey}/stream`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try { applyEvent(JSON.parse(e.data as string) as StreamEvent); } catch { /* 忽略非 JSON 心跳 */ }
      qc.invalidateQueries({ queryKey: qk.flow(flowId) });
    };
    es.onerror = () => {
      // 连接层错误时转轮询兜底，不 close 已建立的连接由浏览器自行重试
      setState((s) => (s.running ? { ...s } : s));
    };

    const fallback = setInterval(() => {
      if (es.readyState === EventSource.CONNECTING) qc.invalidateQueries({ queryKey: qk.flow(flowId) });
    }, POLL_MS);

    return () => {
      clearInterval(fallback);
      es.close();
    };
  }, [flowId, stageKey, opts.enabled, qc]);

  return state;
}

/** 阶段历史日志（SSE 之外的兜底数据源，也是非执行中面板的日志来源）。 */
export const useStageLogs = (flowId: string, stageKey: string) =>
  useQuery({
    queryKey: qk.stageLogs(flowId, stageKey),
    queryFn: () => endpoints.stageLogs(flowId, stageKey),
    enabled: Boolean(flowId && stageKey),
  });

/** 后端 /logs 返回混合事件，只取 type=log 的行。 */
export function toLogLines(events?: Record<string, unknown>[]): LogLine[] {
  return (events ?? [])
    .filter((e) => e.type === "log")
    .map((e) => ({
      ts: typeof e.ts === "string" ? e.ts : undefined,
      level: (e.level as LogLine["level"]) ?? "info",
      message: String(e.message ?? ""),
    }));
}
```

> 卸载时的 `es.close()` 是必要的（离开页面必须断流）；不变量 I4 针对的是**收到 stage_done 之后在组件内主动关闭**，两者不冲突。

- [ ] **Step 5：确认通过**

Run: `cd frontend && npx vitest run src/hooks/useStageStream.test.tsx`
Expected: 2 passed

- [ ] **Step 6：Commit**

```bash
git add frontend/src/hooks/useStageStream.ts frontend/src/hooks/useStageStream.test.tsx frontend/src/test/fakeEventSource.ts
git commit -m "feat(frontend): 阶段 SSE 流与轮询兜底"
```

### Task 4.5：StageRail —— 不变量 I2（TDD）

**Files:**
- Create: `frontend/src/flow/StageRail.tsx`
- Test: `frontend/src/flow/StageRail.test.tsx`

- [ ] **Step 1：失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { StageRail } from "./StageRail";
import type { FlowStage } from "../api/types";

const st = (over: Partial<FlowStage>): FlowStage => ({
  key: "k", index: 0, title: "T", description: "", form_fields: [], inputs: {},
  required: true, status: "locked", steps: [], ...over,
});

describe("StageRail (I2)", () => {
  const stages = [
    st({ key: "a", index: 0, title: "环境登记", status: "passed" }),
    st({ key: "b", index: 1, title: "环境校验", status: "ready" }),
    st({ key: "c", index: 2, title: "上传安装包", status: "locked" }),
  ];

  it("locked 阶段不可选中，点击不触发 onSelect", async () => {
    const onSelect = vi.fn();
    render(<StageRail stages={stages} activeKey="a" onSelect={onSelect} />);
    await userEvent.click(screen.getByText(/上传安装包/));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("passed 阶段可回看", async () => {
    const onSelect = vi.fn();
    render(<StageRail stages={stages} activeKey="b" onSelect={onSelect} />);
    await userEvent.click(screen.getByText(/环境登记/));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("必经阶段标注「必经」，非必经标注「可跳过」", () => {
    render(
      <StageRail
        stages={[st({ key: "x", status: "ready", title: "回滚预案", required: false })]}
        activeKey="x"
        onSelect={() => {}}
      />
    );
    expect(screen.getByText(/可跳过/)).toBeInTheDocument();
  });
});
```

> 标题与副标题的元素 textContent 分别是 `3. 上传安装包` 与 `待执行 · 可跳过`，所以断言一律用正则而非精确字符串。

- [ ] **Step 2：确认失败**

Run: `cd frontend && npx vitest run src/flow/StageRail.test.tsx`
Expected: FAIL，找不到模块

- [ ] **Step 3：实现 `StageRail.tsx`**

```tsx
import { STAGE_CN } from "../lib/labels";
import type { FlowStage, StageStatus } from "../api/types";

const BADGE: Record<StageStatus, string> = {
  locked: "border-line bg-canvas text-ink-mute",
  ready: "border-brand bg-brand-soft text-brand",
  running: "border-brand bg-brand text-white",
  passed: "border-ok bg-ok/10 text-ok",
  failed: "border-danger bg-danger/10 text-danger",
  skipped: "border-line bg-canvas text-ink-mute",
};

const GLYPH: Record<StageStatus, string> = {
  locked: "🔒", ready: "◇", running: "◐", passed: "✔", failed: "✕", skipped: "–",
};

/** I2：可点性完全由后端 status 决定，不做前端推算。 */
const selectable = (s: StageStatus) => s !== "locked";

export interface StageRailProps {
  stages: FlowStage[];
  activeKey: string;
  onSelect: (key: string) => void;
}

export function StageRail({ stages, activeKey, onSelect }: StageRailProps) {
  return (
    <ol className="flex flex-col gap-1.5">
      {stages.map((s) => {
        const active = s.key === activeKey;
        const clickable = selectable(s.status);
        return (
          <li key={s.key}>
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onSelect(s.key)}
              title={clickable ? s.description : `未解锁：${STAGE_CN[s.status] ?? STAGE_CN.locked}`}
              className={`flex w-full items-center gap-2.5 rounded-card border px-3 py-2.5 text-left transition-colors ${
                active ? "border-brand bg-panel shadow-card" : "border-transparent"
              } ${clickable ? "hover:border-line hover:bg-panel" : "cursor-not-allowed opacity-70"}`}
            >
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${BADGE[s.status]}`}>
                {GLYPH[s.status]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {s.index + 1}. {s.title}
                </span>
                <span className="mt-0.5 block text-[11px] text-ink-mute">
                  {STAGE_CN[s.status]}
                  {s.required ? " · 必经" : " · 可跳过"}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
```

> 可点性判断只有 `selectable(s.status)` 一处，即 `status !== "locked"`；任何「上游没通过就禁用」的前端推算都会与后端 `refresh_locks` 打架，禁止添加。

- [ ] **Step 4：确认通过**

Run: `cd frontend && npx vitest run src/flow/StageRail.test.tsx`
Expected: 3 passed

- [ ] **Step 5：Commit**

```bash
git add frontend/src/flow/StageRail.tsx frontend/src/flow/StageRail.test.tsx
git commit -m "feat(frontend): 阶段侧栏严格遵循后端门禁"
```

### Task 4.6：useFlowRunner 与 StagePanel

**Files:**
- Create: `frontend/src/hooks/useFlowRunner.ts` `frontend/src/flow/StagePanel.tsx`
- Test: `frontend/src/flow/StagePanel.test.tsx`

- [ ] **Step 1：`useFlowRunner.ts`**

```ts
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { endpoints, qk } from "../api/endpoints";
import { ApiError } from "../api/client";
import { useToast } from "../components/ToastProvider";
import { collect, initialValues } from "../flow/formValue";
import type { FlowDetail, FlowStage, StageStatus } from "../api/types";

const isDone = (s: StageStatus) => s === "passed" || s === "skipped";

export function useFlowRunner(flow: FlowDetail) {
  const qc = useQueryClient();
  const toast = useToast();
  const [activeKey, setActiveKey] = useState<string>(() => pickInitial(flow));
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const st = flow.stages.find((s) => s.key === pickInitial(flow));
    return st ? initialValues(st) : {};
  });
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const stage: FlowStage = useMemo(() => {
    const found = flow.stages.find((s) => s.key === activeKey) ?? flow.stages[0];
    return found;
  }, [flow, activeKey]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: qk.flow(flow.id) }), [qc, flow.id]);

  const ensureLoaded = useCallback((key: string) => {
    setValues((cur) => {
      const st = flow.stages.find((s) => s.key === key);
      if (!st) return {};
      // 切换阶段时按该阶段 inputs/default 重置
      const base = initialValues(st);
      return Object.keys(cur).length && Object.keys(cur).join() === Object.keys(base).join() && key === activeKey ? cur : base;
    });
  }, [flow, activeKey]);

  const select = useCallback((key: string) => {
    setActiveKey(key);
    setFieldErrors([]);
    ensureLoaded(key);
  }, [ensureLoaded]);

  const setValue = useCallback((k: string, v: unknown) => {
    setValues((x) => ({ ...x, [k]: v }));
    setFieldErrors([]);
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setFieldErrors([]);
    const inputs = collect(stage, values);
    try {
      const v = await endpoints.validateStage(flow.id, stage.key, inputs);
      if (!v.valid) {
        setFieldErrors(v.errors);
        toast(v.errors[0] ?? "表单校验未通过", "warn");
        return false;
      }
      await endpoints.submitStageInputs(flow.id, stage.key, inputs);
      await endpoints.runStage(flow.id, stage.key, { operator: flow.operator || "admin" });
      toast(`阶段「${stage.title}」开始执行`);
      refresh();
      return true;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.fieldErrors.length) setFieldErrors(e.fieldErrors);
        toast(e.message, "error");
      } else toast("执行失败", "error");
      return false;
    } finally {
      setBusy(false);
    }
  }, [flow, stage, values, toast, refresh]);

  const skip = useCallback(async () => {
    try {
      await endpoints.skipStage(flow.id, stage.key, flow.operator || "admin");
      toast(`阶段「${stage.title}」已跳过`);
      const next = flow.stages.find((s) => !isDone(s.status) && s.status !== "locked");
      if (next) setActiveKey(next.key);
      refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "跳过失败", "error");
    }
  }, [flow, stage, toast, refresh]);

  const cancel = useCallback(async () => {
    try {
      const r = await endpoints.cancelStage(flow.id, stage.key);
      toast(r.ok ? "已请求终止" : "当前阶段无法终止", r.ok ? "ok" : "warn");
      refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "终止失败", "error");
    }
  }, [flow.id, stage.key, toast, refresh]);

  const onStreamDone = useCallback((status: StageStatus, error?: string | null) => {
    if (status === "passed") toast(`阶段「${stage.title}」通过`);
    else if (status === "failed") toast(error ?? `阶段「${stage.title}」失败`, "error");
    const idx = flow.stages.findIndex((s) => s.key === stage.key);
    const next = flow.stages.slice(idx + 1).find((s) => s.status === "ready" || s.status === "failed");
    if (next) setActiveKey(next.key);
    refresh();
  }, [flow.stages, stage, toast, refresh]);

  const nextReady = useMemo(() => {
    const idx = flow.stages.findIndex((s) => s.key === stage.key);
    return flow.stages.slice(idx + 1).find((s) => s.status === "ready" || s.status === "failed");
  }, [flow.stages, stage.key]);

  return {
    stage, activeKey, select, values, setValue, fieldErrors,
    busy, run, skip, cancel, onStreamDone, nextReady,
  };
}

/** 默认停在第一个未通过的阶段（locked 由后端算好，不会选中）。 */
function pickInitial(flow: FlowDetail): string {
  const first = flow.stages.find((s) => s.status === "running")
    ?? flow.stages.find((s) => s.status === "failed")
    ?? flow.stages.find((s) => s.status === "ready")
    ?? flow.stages.find((s) => !isDone(s.status))
    ?? flow.stages[0];
  return first?.key ?? "";
}
```

- [ ] **Step 2：`StagePanel.tsx`**

```tsx
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { StatusTag } from "../components/StatusTag";
import { DynamicForm } from "./DynamicForm";
import { StepList } from "./StepList";
import { LogConsole, type LogLine } from "./LogConsole";
import { useStageStream, useStageLogs, toLogLines } from "../hooks/useStageStream";
import type { ReactNode } from "react";
import type { FlowStage, StageStatus } from "../api/types";

export interface StagePanelProps {
  flowId: string;
  stage: FlowStage;
  values: Record<string, unknown>;
  onChange: (k: string, v: unknown) => void;
  fieldErrors: string[];
  busy: boolean;
  onRun: () => void | Promise<boolean | void>;
  onSkip: () => void;
  onCancel: () => void;
  onStreamDone: (status: StageStatus, error?: string | null) => void;
  uploadSlot?: ReactNode;
}

export function StagePanel({
  flowId, stage, values, onChange, fieldErrors, busy, onRun, onSkip, onCancel, onStreamDone, uploadSlot,
}: StagePanelProps) {
  const running = stage.status === "running";
  const stream = useStageStream(flowId, stage.key, { enabled: running, onDone: onStreamDone });

  // 执行中用 SSE 全量流（服务端 connect 时会先回放历史，故不会与 history 重复）；
  // 非执行中读 /logs 历史，切阶段也不丢已完成阶段的日志。
  const { data: history } = useStageLogs(flowId, stage.key);
  const steps = running || stream.steps.length > 0 ? mergeSteps(stage.steps, stream.steps) : stage.steps;
  const logs = running && stream.logs.length > 0 ? stream.logs : toLogLines(history);

  const canRun = stage.status === "ready" || stage.status === "failed";

  return (
    <Card
      title={<span>{stage.index + 1}. {stage.title}</span>}
      sub={stage.description}
      actions={
        <div className="flex items-center gap-2">
          <StatusTag kind="stage" value={stage.status} />
          {running ? (
            <Button size="sm" variant="danger" onClick={onCancel}>终止</Button>
          ) : (
            <>
              {!stage.required && canRun && <Button size="sm" variant="ghost" onClick={onSkip}>跳过此阶段</Button>}
              <Button size="sm" onClick={onRun} disabled={!canRun || busy}>
                {busy ? "提交中…" : stage.status === "failed" ? "重试此阶段" : "校验并执行"}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {stage.error && (
          <div className="rounded-btn border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {stage.error}
          </div>
        )}

        {stage.form_fields.length > 0 && (
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-mute">阶段参数</h3>
            <DynamicForm fields={stage.form_fields} values={values} onChange={onChange} disabled={running} />
          </div>
        )}

        {uploadSlot}

        {fieldErrors.length > 0 && (
          <ul className="list-disc space-y-1 rounded-btn border border-warn/40 bg-warn/10 px-4 py-2.5 text-xs text-warn">
            {fieldErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )}

        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-mute">执行步骤</h3>
          <StepList steps={steps} />
        </div>

        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-mute">执行日志</h3>
          <LogConsole lines={logs} />
        </div>
      </div>
    </Card>
  );
}

function mergeSteps(base: FlowStage["steps"], live: FlowStage["steps"]) {
  if (live.length === 0) return base;
  const map = new Map(base.map((s) => [s.id, s]));
  for (const s of live) map.set(s.id, s);
  return [...map.values()].sort((a, b) => a.index - b.index);
}
```

> 单测里不 stub `/logs`，`useStageLogs` 会静默失败（`retry: 0`），`toLogLines(undefined)` 返回空数组，不影响断言。

- [ ] **Step 3：失败测试 `StagePanel.test.tsx`（锁住 I2 的按钮门禁与 I3 的表单入口）**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StagePanel } from "./StagePanel";
import type { FlowStage } from "../api/types";

const stage: FlowStage = {
  key: "package_upload", index: 2, title: "上传安装包", description: "",
  form_fields: [{ key: "chunk_size", label: "分片大小 MB", type: "number", required: false, placeholder: "", help: "", hint: "", default: 8 }],
  inputs: { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 8 },
  required: true, status: "ready", steps: [],
};

function setup() {
  const onRun = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <StagePanel
        flowId="f1" stage={stage} values={{ chunk_size: 8 }} onChange={() => {}}
        fieldErrors={[]} busy={false} onRun={onRun} onSkip={() => {}} onCancel={() => {}}
        onStreamDone={() => {}}
      />
    </QueryClientProvider>
  );
  return onRun;
}

describe("StagePanel", () => {
  it("ready 阶段可执行，非必经不显示跳过（此阶段 required=true）", async () => {
    const onRun = setup();
    expect(screen.queryByText("跳过此阶段")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /校验并执行/ }));
    expect(onRun).toHaveBeenCalled();
  });

  it("locked 阶段禁用执行", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StagePanel flowId="f1" stage={{ ...stage, status: "locked" }} values={{}} onChange={() => {}}
          fieldErrors={[]} busy={false} onRun={() => {}} onSkip={() => {}} onCancel={() => {}}
          onStreamDone={() => {}} />
      </QueryClientProvider>
    );
    expect(screen.getByRole("button", { name: /校验并执行/ })).toBeDisabled();
  });
});
```

- [ ] **Step 4：跑测试**

Run: `cd frontend && npx vitest run src/flow/StagePanel.test.tsx`
Expected: 2 passed；若失败，优先检查 `Button` 的可访问名拼接（用 `getByRole("button", { name: /校验并执行/ })` 而非精确文本）

- [ ] **Step 5：Commit**

```bash
git add frontend/src/hooks/useFlowRunner.ts frontend/src/flow/StagePanel.tsx frontend/src/flow/StagePanel.test.tsx
git commit -m "feat(frontend): 阶段面板与流程执行 hook"
```

### Task 4.7：流程向导页 + 新建流程 + 流程列表

**Files:**
- Modify: `frontend/src/pages/FlowWizard.tsx`（替换 stub）`frontend/src/pages/Flows.tsx`（替换 stub）
- Create: `frontend/src/components/flow/NewFlowDialog.tsx` `frontend/src/components/flow/RollbackButton.tsx`

- [ ] **Step 1：`NewFlowDialog.tsx`（mode 三选一，来自 `MODE_OPTIONS`）**

```tsx
import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, inputCls, labelCls } from "../ui/Field";
import { useToast } from "../ToastProvider";
import { useCreateFlow, useEnvironments } from "../../hooks/queries";
import { MODE_OPTIONS } from "../../lib/labels";
import { ApiError } from "../../api/client";
import type { FlowMode } from "../../api/types";

export function NewFlowDialog({ open, onClose, presetEnv, presetMode, onCreated }: {
  open: boolean; onClose: () => void; presetEnv?: string; presetMode?: FlowMode;
  onCreated: (flowId: string) => void;
}) {
  const [name, setName] = useState("");
  const [envId, setEnvId] = useState(presetEnv ?? "");
  const [mode, setMode] = useState<FlowMode>(presetMode ?? "install");
  const create = useCreateFlow();
  const toast = useToast();
  const { data: envs = [] } = useEnvironments();
  const hint = MODE_OPTIONS.find((m) => m.value === mode)?.hint ?? "";

  const submit = () => {
    if (!name.trim()) { toast("流程名称必填", "warn"); return; }
    if (mode === "install" && !envId) { toast("全新安装必须选择环境", "warn"); return; }
    create.mutate(
      { name: name.trim(), env_id: envId, mode },
      {
        onSuccess: (f) => { toast(`流程「${f.name}」已创建`); onCreated(f.id); },
        onError: (e) => toast(e instanceof ApiError ? e.message : "创建失败", "error"),
      }
    );
  };

  return (
    <Modal open={open} title="新建流程" width={560} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button onClick={submit} disabled={create.isPending}>创建并进入</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label={<span className={labelCls}>流程名称 *</span>}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="生产-AZ1 全新安装" />
        </Field>
        <Field label={<span className={labelCls}>编排模式 *</span>} hint={hint}>
          <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as FlowMode)}>
            {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label={<span className={labelCls}>目标环境 *</span>}
          hint={envs.length === 0 ? "还没有环境，请先到「环境」页创建" : "阶段 1 的节点矩阵会写入该环境"}>
          <select className={inputCls} value={envId} onChange={(e) => setEnvId(e.target.value)}>
            <option value="">（未选择）</option>
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
```

> 导航一律由父组件通过 `onCreated` 完成，对话框自身只负责校验与提交。

- [ ] **Step 2：`pages/Flows.tsx`**

```tsx
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { StatusTag } from "../components/StatusTag";
import { NewFlowDialog } from "../components/flow/NewFlowDialog";
import { useDeleteFlow, useFlows } from "../hooks/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { fmtTime, fmtDate } from "../lib/format";
import { modeLabel } from "../lib/labels";
import type { FlowSummary, FlowMode } from "../api/types";

export default function Flows() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: flows = [] } = useFlows(100);
  const del = useDeleteFlow();
  const creating = params.get("new") === "1";
  const [toDelete, setToDelete] = useState<FlowSummary | null>(null);

  const closeNew = () => {
    params.delete("new");
    params.delete("env");
    params.delete("mode");
    setParams(params, { replace: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="流程列表"
        sub="按门禁顺序推进：上一阶段通过或跳过才会解锁下一阶段"
        actions={<Button size="sm" onClick={() => setParams({ new: "1" })}>新建流程</Button>}
      >
        <Table head={["流程", "模式", "环境", "阶段进度", "状态", "创建时间", "操作"]}>
          {flows.length === 0 && <tr><Td colSpan={7}><Empty>还没有流程</Empty></Td></tr>}
          {flows.map((f) => (
            <Tr key={f.id}>
              <Td><Link to={`/flows/${f.id}`} className="font-medium text-brand hover:underline">{f.name}</Link></Td>
              <Td className="text-ink-soft">{modeLabel(f.mode)}</Td>
              <Td className="font-mono text-xs text-ink-mute">{f.env_id || "—"}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                    <span className="block h-full bg-brand" style={{ width: `${f.progress.total ? (f.progress.done / f.progress.total) * 100 : 0}%` }} />
                  </span>
                  <span className="font-mono text-xs">{f.progress.done}/{f.progress.total}</span>
                </div>
              </Td>
              <Td><StatusTag kind="flow" value={f.status} /></Td>
              <Td className="text-xs text-ink-mute">{fmtTime(f.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => nav(`/flows/${f.id}`)}>进入</Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(f)}>删除</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <NewFlowDialog
        open={creating}
        onClose={closeNew}
        presetEnv={params.get("env") ?? undefined}
        presetMode={(params.get("mode") as FlowMode | null) ?? undefined}
        onCreated={(id) => { closeNew(); nav(`/flows/${id}`); }}
      />

      <ConfirmDialog
        open={!!toDelete}
        title="删除流程"
        body={toDelete ? `将删除流程「${toDelete.name}」（${fmtDate(toDelete.created_at)} 创建）及其阶段执行记录。安装包与备份点不受影响。` : ""}
        danger
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          del.mutate(toDelete.id, {
            onSuccess: () => { toast("流程已删除"); setToDelete(null); },
            onError: () => { toast("删除失败", "error"); setToDelete(null); },
          });
        }}
      />
    </div>
  );
}
```

> 新建成功后需要跳转到向导页：在 `NewFlowDialog` 增加 `onCreated: (id: string) => void` prop，`onSuccess` 内调用 `onCreated(f.id)`；`Flows.tsx` 传 `onCreated={(id) => { closeNew(); nav(`/flows/${id}`); }}`。**不要**保留步骤 1 里的 `window.location.hash` 那行。

- [ ] **Step 3：`RollbackButton.tsx`（仅 upgrade_k8s）**

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, inputCls, labelCls } from "../ui/Field";
import { useToast } from "../ToastProvider";
import { endpoints, qk } from "../../api/endpoints";
import { ApiError } from "../../api/client";
import { qk } from "../../api/endpoints";

export function RollbackButton({ flowId, releaseName }: { flowId: string; releaseName: string }) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const go = async () => {
    setBusy(true);
    try {
      const r = await endpoints.rollback(flowId, revision ? Number(revision) : undefined);
      const ok = r.ok === true;
      toast(ok ? `Helm 回滚完成：${releaseName || "release"}` : `回滚失败：${JSON.stringify(r).slice(0, 120)}`, ok ? "ok" : "error");
      qc.invalidateQueries({ queryKey: qk.flow(flowId) });
      if (ok) setOpen(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "回滚失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>Helm 回滚</Button>
      <Modal
        open={open}
        title={`回滚 Helm Release${releaseName ? ` · ${releaseName}` : ""}`}
        sub="调用 helm rollback 回到上一 revision，流程阶段状态不会被重置"
        width={460}
        onClose={() => setOpen(false)}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button variant="danger" onClick={go} disabled={busy}>{busy ? "回滚中…" : "确认回滚"}</Button></>}
      >
        <Field label={<span className={labelCls}>目标 revision（留空=上一版本）</span>}>
          <input className={inputCls} type="number" min={0} value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="0" />
        </Field>
      </Modal>
    </>
  );
}
```

> 回滚是**直接调用 helm rollback 的真实操作**，所以按钮放在流程头部而非阶段内，且必须经过 Modal 确认。

- [ ] **Step 4：`pages/FlowWizard.tsx`**

```tsx
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { StatusTag } from "../components/StatusTag";
import { StageRail } from "../flow/StageRail";
import { StagePanel } from "../flow/StagePanel";
import { RollbackButton } from "../components/flow/RollbackButton";
import { NodeMatrixReadonly } from "../components/env/NodeMatrixReadonly";
import { UploadZone } from "../components/upload/UploadZone";
import { useFlow, usePackage } from "../hooks/queries";
import { useFlowRunner } from "../hooks/useFlowRunner";
import { fmtTime, fmtBytes } from "../lib/format";
import { modeLabel } from "../lib/labels";
import type { FlowDetail } from "../api/types";

export default function FlowWizard() {
  const { id = "" } = useParams();
  const { data: flow } = useFlow(id);
  if (!flow) return <div className="text-sm text-ink-mute">加载流程…</div>;
  return <Wizard flow={flow} />;
}

function Wizard({ flow }: { flow: FlowDetail }) {
  const r = useFlowRunner(flow);
  const running = flow.stages.some((s) => s.status === "running");

  useEffect(() => {
    document.title = `${flow.name} · ShipDesk Console`;
  }, [flow.name]);

  const pkgIds = (r.stage.inputs._package_ids as string[] | undefined) ?? [];
  const isUploadStage = r.stage.key === "package_upload";
  const releaseName = String(r.stage.inputs.release_name ?? flow.stages[0]?.inputs.release_name ?? "");

  return (
    <div className="flex flex-col gap-5">
      <Card
        title={
          <span className="flex items-center gap-2.5">
            {flow.name}
            <StatusTag kind="flow" value={flow.status} />
          </span>
        }
        sub={`${modeLabel(flow.mode)} · 环境 ${flow.env_name || "—"} · ${flow.stages.length} 阶段 · 更新于 ${fmtTime(flow.updated_at)}`}
        actions={
          <div className="flex items-center gap-2">
            {flow.mode === "upgrade_k8s" && <RollbackButton flowId={flow.id} releaseName={releaseName} />}
            <Link to="/flows" className="text-xs text-ink-soft hover:text-brand">返回列表</Link>
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-line">
            <span className="block h-full bg-brand transition-all"
              style={{ width: `${flow.progress.total ? (flow.progress.done / flow.progress.total) * 100 : 0}%` }} />
          </span>
          <span className="font-mono text-xs text-ink-soft">{flow.progress.done}/{flow.progress.total}</span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_1fr]">
        <div className="lg:sticky lg:top-[72px] lg:self-start">
          <Card title="阶段" tight sub="点锁定的阶段不可进入">
            <div className="p-2.5">
              <StageRail stages={flow.stages} activeKey={r.activeKey} onSelect={r.select} />
            </div>
          </Card>
          {flow.nodes.length > 0 && (
            <details className="mt-3 rounded-card border border-line bg-panel px-3 py-2.5">
              <summary className="cursor-pointer text-xs font-medium text-ink-soft">
                环境节点 · {flow.nodes.length} 台
              </summary>
              <div className="mt-3 max-h-[420px] overflow-auto">
                <NodeMatrixReadonly nodes={flow.nodes} />
              </div>
            </details>
          )}
        </div>

        <StagePanel
          flowId={flow.id}
          stage={r.stage}
          values={r.values}
          onChange={r.setValue}
          fieldErrors={r.fieldErrors}
          busy={r.busy}
          onRun={r.run}
          onSkip={r.skip}
          onCancel={r.cancel}
          onStreamDone={r.onStreamDone}
          uploadSlot={
            isUploadStage ? (
              <div className="rounded-card border border-dashed border-line p-4">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-mute">安装包上传</h3>
                <p className="mb-3 text-[11px] text-ink-mute">
                  大于 64 MB 自动走分片续传{running ? "（阶段执行中禁止上传）" : ""}
                </p>
                <UploadZone flowId={flow.id} flowName={flow.name} disabled={running} />
                {pkgIds.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1">
                    {pkgIds.map((pid) => <PackageChip key={pid} id={pid} />)}
                  </ul>
                )}
              </div>
            ) : null
          }
        />
      </div>

      {r.nextReady && r.stage.status === "passed" && (
        <Card title="下一步" tight>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm text-ink-soft">
              已解锁「{r.nextReady.title}」，可继续推进。
            </span>
            <button className="text-xs font-medium text-brand hover:underline" onClick={() => r.select(r.nextReady!.key)}>
              进入下一阶段 →
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

function PackageChip({ id }: { id: string }) {
  const { data } = usePackage(id);
  if (!data) return <li className="font-mono text-[11px] text-ink-mute">{id}</li>;
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="font-medium text-ink">{data.name}</span>
      <span className="font-mono text-[11px] text-ink-mute">{fmtBytes(data.size_bytes)}</span>
      <span className="font-mono text-[11px] text-ink-mute">{id}</span>
    </li>
  );
}
```

> 轮询策略：`useFlow` 的 `refetchInterval` 用函数式判断（有 running 阶段才 1.2s 轮询），`useStageStream` 在每条 SSE 消息后 `invalidateQueries`，两者叠加即可保证阶段结束后侧栏立刻解锁，无需手写常量。

- [ ] **Step 5：验证与手动走查**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npx vitest run && npm run build`
Expected: 全绿

浏览器走查（后端 8848 + dev 5173）：
1. `/flows?new=1&mode=install` 建流程 → 进入向导，阶段 1 可填节点矩阵、点「填充演示数据」→ 校验并执行 → 日志滚动、步骤逐个 ✔ → 侧栏阶段 2 自动解锁。
2. 点 locked 阶段无反应（I2）。
3. 切到已通过的阶段 1，参数仍在（inputs 回填），再次执行不会丢 `_package_id`（I3）。

- [ ] **Step 6：Commit**

```bash
git add frontend/src/pages/Flows.tsx frontend/src/pages/FlowWizard.tsx frontend/src/components/flow frontend/src/hooks/queries.ts
git commit -m "feat(frontend): 流程向导、新建流程与 Helm 回滚入口"
```

---

## M5 安装包上传、备份与 K8s 页

### Task 5.1：`useChunkedUpload` —— 分片 + 断点续传（TDD）

**Files:**
- Create: `frontend/src/hooks/useChunkedUpload.ts`
- Test: `frontend/src/hooks/useChunkedUpload.test.ts`

- [ ] **Step 1：失败测试**

```ts
import { describe, it, expect } from "vitest";
import { sliceRanges, pickStrategy, CHUNK_SIZE } from "./useChunkedUpload";

describe("sliceRanges", () => {
  it("整片对齐：24MB 切 3 片", () => {
    expect(sliceRanges(3 * CHUNK_SIZE, CHUNK_SIZE)).toEqual([
      [0, CHUNK_SIZE],
      [CHUNK_SIZE, 2 * CHUNK_SIZE],
      [2 * CHUNK_SIZE, 3 * CHUNK_SIZE],
    ]);
  });
  it("末片取余", () => {
    const r = sliceRanges(CHUNK_SIZE + 10, CHUNK_SIZE);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual([CHUNK_SIZE, CHUNK_SIZE + 10]);
  });
  it("空文件不切", () => {
    expect(sliceRanges(0, CHUNK_SIZE)).toEqual([]);
  });
});

describe("pickStrategy", () => {
  it("小于阈值走单请求", () => {
    expect(pickStrategy(8 * 1024 * 1024)).toBe("single");
  });
  it("达到阈值走分片续传", () => {
    expect(pickStrategy(64 * 1024 * 1024)).toBe("chunked");
  });
});
```

- [ ] **Step 2：确认失败**

Run: `cd frontend && npx vitest run src/hooks/useChunkedUpload.test.ts`
Expected: FAIL，找不到模块

- [ ] **Step 3：实现 `useChunkedUpload.ts`**

```ts
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { endpoints, qk } from "../api/endpoints";
import { useToast } from "../components/ToastProvider";
import { ApiError } from "../api/client";
import type { PackageEntry } from "../api/types";

export const CHUNK_SIZE = 8 * 1024 * 1024;
const SINGLE_LIMIT = 64 * 1024 * 1024;

export type UploadStrategy = "single" | "chunked";

export const pickStrategy = (size: number): UploadStrategy => (size >= SINGLE_LIMIT ? "chunked" : "single");

export function sliceRanges(size: number, chunk: number): [number, number][] {
  const out: [number, number][] = [];
  for (let off = 0; off < size; off += chunk) out.push([off, Math.min(off + chunk, size)]);
  return out;
}

export interface UploadProgress {
  fileName: string;
  totalBytes: number;
  sentBytes: number;
  percent: number;
  chunkIndex: number;
  totalChunks: number;
  resuming: boolean;
}

export function useChunkedUpload(flowId?: string, flowName?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.packages });
    if (flowId) qc.invalidateQueries({ queryKey: qk.flow(flowId) });
  }, [qc, flowId]);

  const single = useCallback(async (file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("name", file.name);
    fd.append("version", "");
    fd.append("kind", "bundle");
    fd.append("flow_id", flowId ?? "");
    return endpoints.uploadPackage(fd);
  }, [flowId]);

  const chunked = useCallback(async (file: File) => {
    const signal = abortRef.current?.signal;
    const init = await endpoints.initUpload({
      name: file.name,
      version: "",
      kind: "bundle",
      size_bytes: file.size,
      chunk_size: CHUNK_SIZE,
      flow_id: flowId ?? "",
    });

    // 断点续传：先问服务端哪些片已到
    const st = await endpoints.uploadStatus(init.upload_id);
    const done = new Set(st.done_chunks);
    const ranges = sliceRanges(file.size, init.chunk_size);

    setProgress({
      fileName: file.name, totalBytes: file.size, sentBytes: st.uploaded_bytes,
      percent: st.progress, chunkIndex: done.size, totalChunks: ranges.length, resuming: done.size > 0,
    });

    for (let i = 0; i < ranges.length; i++) {
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      if (done.has(i)) continue;
      const [from, to] = ranges[i]!;
      const r = await endpoints.uploadChunk(init.upload_id, i, file.slice(from, to), `${file.name}.part${i}`);
      setProgress({
        fileName: file.name, totalBytes: file.size, sentBytes: r.progress * file.size / 100,
        percent: r.progress, chunkIndex: i + 1, totalChunks: ranges.length, resuming: done.size > 0,
      });
    }
    return endpoints.completeUpload(init.upload_id);
  }, [flowId]);

  const upload = useCallback(async (file: File): Promise<PackageEntry | null> => {
    setBusy(true);
    abortRef.current = new AbortController();
    setProgress({
      fileName: file.name, totalBytes: file.size, sentBytes: 0,
      percent: 0, chunkIndex: 0, totalChunks: 1, resuming: false,
    });
    try {
      const entry = pickStrategy(file.size) === "single" ? await single(file) : await chunked(file);
      toast(`「${entry.name}」上传完成${flowName ? `，已挂到流程「${flowName}」` : ""}`);
      refresh();
      return entry;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toast("上传已取消，可在原会话继续", "warn");
      } else {
        toast(e instanceof ApiError ? e.message : "上传失败", "error");
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, [single, chunked, toast, refresh]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  return { busy, progress, upload, cancel };
}
```

> `sentBytes` 由 `progress` 反推（服务端只回百分比），仅用于进度条文案；断点续传的正确性由 `done_chunks` 决定，不依赖该字段。

- [ ] **Step 4：确认通过**

Run: `cd frontend && npx vitest run src/hooks/useChunkedUpload.test.ts`
Expected: 5 passed

- [ ] **Step 5：Commit**

```bash
git add frontend/src/hooks/useChunkedUpload.ts frontend/src/hooks/useChunkedUpload.test.ts
git commit -m "feat(frontend): 分片续传上传 hook"
```

### Task 5.2：UploadZone 与安装包页

**Files:**
- Create: `frontend/src/components/upload/UploadZone.tsx`
- Modify: `frontend/src/pages/Packages.tsx`（替换 stub）

- [ ] **Step 1：`UploadZone.tsx`**

```tsx
import { useRef, useState } from "react";
import { Button } from "../ui/Button";
import { useChunkedUpload } from "../../hooks/useChunkedUpload";
import { fmtBytes } from "../../lib/format";

export interface UploadZoneProps {
  flowId?: string;
  flowName?: string;
  disabled?: boolean;
  onUploaded?: (packageId: string) => void;
}

export function UploadZone({ flowId, flowName, disabled, onUploaded }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const up = useChunkedUpload(flowId, flowName);

  const pick = (f: File | null) => setFile(f);

  const go = async () => {
    if (!file) return;
    const entry = await up.upload(file);
    if (entry) { setFile(null); onUploaded?.(entry.id); }
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0] ?? null); }}
        className={`flex flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed px-4 py-7 text-center transition-colors ${
          drag ? "border-brand bg-brand-soft" : "border-line bg-canvas"
        }`}
      >
        <p className="text-xs text-ink-soft">
          {file ? `已选择：${file.name} · ${fmtBytes(file.size)}` : "拖拽 tar.gz / chart 包到此处，或点击选择文件"}
        </p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => inputRef.current?.click()} disabled={disabled || up.busy}>
            选择文件
          </Button>
          {up.busy ? (
            <Button size="sm" variant="danger" onClick={up.cancel}>取消上传</Button>
          ) : (
            <Button size="sm" onClick={go} disabled={disabled || !file}>开始上传</Button>
          )}
        </div>
      </div>

      {up.progress && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-ink-mute">
            <span>
              {up.progress.resuming ? "断点续传中" : "上传中"} · 分片 {up.progress.chunkIndex}/{up.progress.totalChunks}
            </span>
            <span className="font-mono">
              {fmtBytes(Math.round(up.progress.totalBytes * up.progress.percent / 100))} / {fmtBytes(up.progress.totalBytes)}
            </span>
          </div>
          <span className="block h-1.5 overflow-hidden rounded-full bg-line">
            <span className="block h-full bg-brand transition-all" style={{ width: `${up.progress.percent}%` }} />
          </span>
        </div>
      )}
    </div>
  );
}
```

> 阈值只判断一次（在 `useChunkedUpload.pickStrategy`），组件不重复决策；文案里的「≥64 MB 自动分片」是静态说明。

- [ ] **Step 2：`pages/Packages.tsx`**

```tsx
import { useState } from "react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { Tag } from "../components/ui/Tag";
import { UploadZone } from "../components/upload/UploadZone";
import { useDeletePackage, usePackages } from "../hooks/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { fmtBytes, fmtTime } from "../lib/format";
import { KIND_CN } from "../lib/labels";
import type { PackageEntry } from "../api/types";

export default function Packages() {
  const { data: rows = [] } = usePackages();
  const del = useDeletePackage();
  const toast = useToast();
  const [toDelete, setToDelete] = useState<PackageEntry | null>(null);
  const bytes = rows.reduce((a, p) => a + p.size_bytes, 0);

  return (
    <div className="flex flex-col gap-5">
      <Card title="上传安装包" sub="≥64 MB 自动分片（8 MB/片），中断后重传同名文件会跳过已完成分片">
        <UploadZone />
      </Card>

      <Card title="安装包仓库" sub={`${rows.length} 个 · ${fmtBytes(bytes)}`}>
        <Table head={["名称", "类型", "版本", "大小", "已上传", "完整", "关联环境", "创建时间", "操作"]}>
          {rows.length === 0 && <tr><Td colSpan={9}><Empty>仓库为空</Empty></Td></tr>}
          {rows.map((p) => (
            <Tr key={p.id}>
              <Td>
                <div className="font-medium">{p.name}</div>
                <div className="font-mono text-[11px] text-ink-mute">{p.id}</div>
              </Td>
              <Td><Tag tone="purple">{KIND_CN[p.kind] ?? p.kind}</Tag></Td>
              <Td className="font-mono text-xs">{p.version || "—"}</Td>
              <Td className="font-mono text-xs">{fmtBytes(p.size_bytes)}</Td>
              <Td className="font-mono text-xs">{fmtBytes(p.uploaded_bytes)}</Td>
              <Td>
                {p.upload_complete
                  ? <Tag tone="ok">完整</Tag>
                  : <span className="flex items-center gap-2">
                      <span className="block h-1.5 w-16 overflow-hidden rounded-full bg-line">
                        <span className="block h-full bg-warn" style={{ width: `${p.progress}%` }} />
                      </span>
                      <span className="font-mono text-[11px] text-warn">{p.progress}%</span>
                    </span>}
              </Td>
              <Td className="font-mono text-xs text-ink-mute">{p.target_env_id || "—"}</Td>
              <Td className="text-xs text-ink-mute">{fmtTime(p.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(p.checksum).then(() => toast("校验和已复制"))}>
                    复制校验和
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(p)}>删除</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <ConfirmDialog
        open={!!toDelete}
        title="删除安装包"
        body={toDelete ? `将删除「${toDelete.name}」（${fmtBytes(toDelete.size_bytes)}）。已完成的流程阶段记录不受影响，但未执行的「包分发」会拿不到该包。` : ""}
        danger
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          del.mutate(toDelete.id, {
            onSuccess: () => { toast("安装包已删除"); setToDelete(null); },
            onError: () => { toast("删除失败", "error"); setToDelete(null); },
          });
        }}
      />
    </div>
  );
}
```

- [ ] **Step 3：验证 + Commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npx vitest run && npm run build`
Expected: 全绿

```bash
git add frontend/src/components/upload frontend/src/pages/Packages.tsx
git commit -m "feat(frontend): 分片上传区与安装包仓库页"
```

### Task 5.3：备份页（校验 / 恢复 / 过期）

**Files:**
- Modify: `frontend/src/pages/Backups.tsx`（替换 stub）

- [ ] **Step 1：`pages/Backups.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { Tag } from "../components/ui/Tag";
import { StatusTag } from "../components/StatusTag";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { useBackups, useEnvironments } from "../hooks/queries";
import { endpoints, qk } from "../api/endpoints";
import { ApiError } from "../api/client";
import { fmtBytes, fmtDate, fmtTime } from "../lib/format";
import { BACKUP_KIND_CN } from "../lib/labels";
import type { BackupPoint, VerifyResult } from "../api/types";

export default function Backups() {
  const { data: rows = [] } = useBackups();
  const { data: envs = [] } = useEnvironments();
  const qc = useQueryClient();
  const toast = useToast();
  const [verifyOut, setVerifyOut] = useState<{ b: BackupPoint; r: VerifyResult } | null>(null);
  const [restore, setRestore] = useState<BackupPoint | null>(null);
  const [envFilter, setEnvFilter] = useState("");

  const verify = useMutation({
    mutationFn: (id: string) => endpoints.verifyBackup(id),
    onSuccess: (r, id) => {
      const b = rows.find((x) => x.id === id);
      if (b) setVerifyOut({ b, r });
      qc.invalidateQueries({ queryKey: qk.backups() });
      toast(r.ok ? "校验通过" : "校验不一致", r.ok ? "ok" : "error");
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "校验失败", "error"),
  });

  const expire = useMutation({
    mutationFn: (id: string) => endpoints.expireBackup(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.backups() }); toast("已标记过期"); },
  });

  const list = envFilter ? rows.filter((b) => b.env_id === envFilter) : rows;
  const bytes = list.reduce((a, b) => a + b.size_bytes, 0);

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="备份点"
        sub={`${list.length} 个 · ${fmtBytes(bytes)} · 恢复会覆盖目标节点数据`}
        actions={
          <select
            className="rounded-btn border border-line bg-panel px-2 py-1 text-xs"
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
          >
            <option value="">全部环境</option>
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        }
      >
        <Table head={["名称", "类型", "状态", "覆盖节点", "大小", "校验和", "完成时间", "过期时间", "操作"]}>
          {list.length === 0 && <tr><Td colSpan={9}><Empty>流程的备份阶段执行后会自动生成备份点</Empty></Td></tr>}
          {list.map((b) => (
            <Tr key={b.id}>
              <Td>
                <div className="font-medium">{b.name}</div>
                <div className="font-mono text-[11px] text-ink-mute">{b.id}</div>
              </Td>
              <Td><Tag tone="purple">{BACKUP_KIND_CN[b.kind]}</Tag></Td>
              <Td><StatusTag kind="backup" value={b.status} /></Td>
              <Td>
                <span className="font-mono text-xs">{b.nodes_covered.length} 台</span>
                <div className="mt-0.5 truncate text-[11px] text-ink-mute">{b.nodes_covered.join(", ") || "—"}</div>
              </Td>
              <Td className="font-mono text-xs">{fmtBytes(b.size_bytes)}</Td>
              <Td className="font-mono text-[11px] text-ink-mute">{b.checksum.slice(0, 12) || "—"}</Td>
              <Td className="text-xs text-ink-mute">{fmtTime(b.finished_at)}</Td>
              <Td className="text-xs text-ink-mute">{fmtDate(b.expire_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => verify.mutate(b.id)} disabled={verify.isPending}>校验</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRestore(b)} disabled={!b.restorable}>恢复</Button>
                  <Button size="sm" variant="danger" onClick={() => expire.mutate(b.id)}>标记过期</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Modal
        open={!!verifyOut}
        title={verifyOut?.r.ok ? "校验通过" : "校验失败"}
        width={520}
        onClose={() => setVerifyOut(null)}
        footer={<Button variant="ghost" onClick={() => setVerifyOut(null)}>关闭</Button>}
      >
        {verifyOut && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-ink-soft">{verifyOut.r.message}</p>
            <Row k="备份点" v={verifyOut.b.name} />
            <Row k="文件数" v={String(verifyOut.r.files)} />
            <Row k="体积" v={fmtBytes(verifyOut.r.size_bytes)} />
            <Row k="期望校验和" v={verifyOut.r.expected} mono />
            <Row k="实际校验和" v={verifyOut.r.actual} mono />
          </div>
        )}
      </Modal>

      <RestoreDialog backup={restore} onClose={() => setRestore(null)} />
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <span className="text-xs text-ink-mute">{k}</span>
      <span className={`text-right text-xs ${mono ? "font-mono break-all" : "text-ink"}`}>{v}</span>
    </div>
  );
}

function RestoreDialog({ backup, onClose }: { backup: BackupPoint | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: envs = [] } = useEnvironments();
  const env = envs.find((e) => e.id === backup?.env_id);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (!backup) return null;
  const targets = picked.length === 0 ? env?.nodes ?? [] : (env?.nodes ?? []).filter((n) => picked.includes(n.id));

  const go = async () => {
    setBusy(true);
    try {
      const r = await endpoints.restoreBackup(backup.id, {
        backup_id: backup.id, node_ids: targets.map((n) => n.id), confirm: true,
      });
      toast(`已恢复 ${r.restored_nodes.length} 台节点`);
      qc.invalidateQueries({ queryKey: qk.backups() });
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "恢复失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title="恢复备份"
      danger
      confirmLabel="确认覆盖并恢复"
      busy={busy}
      onCancel={onClose}
      onConfirm={go}
      body={
        `备份点「${backup.name}」覆盖 ${backup.nodes_covered.length} 台节点。\n` +
        `本次恢复目标：${targets.length === 0 ? "全部（未勾选）" : targets.map((n) => n.hostname).join(", ")}\n` +
        `该操作会覆盖目标节点上的现有数据，不可撤销。`
      }
    />
  );
}
```

> `RestoreDialog` 用 `ConfirmDialog`（body 为纯文本）而非多选控件：`node_ids` 留空即「全部节点」，与后端 `RestoreRequest` 的默认行为一致，避免在前端复制一份环境节点选择逻辑。若后续要做按节点挑选，再补 checkbox 列表。

- [ ] **Step 2：验证 + Commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 无错误

```bash
git add frontend/src/pages/Backups.tsx
git commit -m "feat(frontend): 备份点校验、恢复与过期"
```

### Task 5.4：K8s 集群页

> 落地以「契约校正」16、17 为准。本节代码里的三处文案已在实现中改掉：Card sub 的「供 upgrade_k8s 流程选择」、删除确认的「按 `cluster_id` 引用该集群的阶段会找不到凭证」（登记表根本不被引擎读）、弹窗 sub 的「也可粘贴内容」（不像路径的值一律按 base64 解码）。

**Files:**
- Modify: `frontend/src/pages/K8s.tsx`（替换 stub）
- Create: `frontend/src/components/k8s/NewClusterDialog.tsx`

- [ ] **Step 1：`NewClusterDialog.tsx`**

```tsx
import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, inputCls, labelCls } from "../ui/Field";
import { useToast } from "../ToastProvider";
import { useCreateCluster } from "../../hooks/queries";
import { ApiError } from "../../api/client";

export function NewClusterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kubeconfig, setKubeconfig] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [context, setContext] = useState("");
  const create = useCreateCluster();
  const toast = useToast();

  const submit = () => {
    if (!name.trim()) { toast("集群名称必填", "warn"); return; }
    create.mutate(
      { name: name.trim(), kubeconfig: kubeconfig.trim(), namespace: namespace.trim() || "default", context },
      {
        onSuccess: (c) => { toast(`集群「${c.name}」已登记`); setName(""); setKubeconfig(""); onClose(); },
        onError: (e) => toast(e instanceof ApiError ? e.message : "登记失败", "error"),
      }
    );
  };

  return (
    <Modal open={open} title="登记 K8s 集群" width={620} onClose={onClose}
      sub="kubeconfig 可以是文件路径，也可粘贴内容；留空则使用默认 KUBECONFIG"
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button onClick={submit} disabled={create.isPending}>保存</Button></>}>
      <div className="flex flex-col gap-3.5">
        <Field label={<span className={labelCls}>集群名称 *</span>}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-hz-01" />
        </Field>
        <Field label={<span className={labelCls}>kubeconfig</span>}>
          <textarea className={`${inputCls} h-28 font-mono`} value={kubeconfig}
            onChange={(e) => setKubeconfig(e.target.value)} placeholder="/home/ops/.kube/config" />
        </Field>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label={<span className={labelCls}>默认命名空间</span>}>
            <input className={inputCls} value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          </Field>
          <Field label={<span className={labelCls}>context</span>}>
            <input className={inputCls} value={context} onChange={(e) => setContext(e.target.value)} placeholder="留空=当前 context" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2：`pages/K8s.tsx`（导航一律用 `useNavigate`，不要整页刷新）**

```tsx
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { Tag } from "../components/ui/Tag";
import { NewClusterDialog } from "../components/k8s/NewClusterDialog";
import { useClusters, useDeleteCluster } from "../hooks/queries";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { endpoints, qk } from "../api/endpoints";
import { ApiError } from "../api/client";
import { fmtDate } from "../lib/format";
// 后端回执 → 可读文本的纯函数（releaseError / kubeFirstLine / cell）最终住在 lib/k8sRelease.ts
import { releaseError } from "../lib/k8sRelease";
import type { K8sCluster } from "../api/types";

export default function K8s() {
  const { data: rows = [], isLoading } = useClusters();
  const del = useDeleteCluster();
  const nav = useNavigate();
  const toast = useToast();
  const [showNew, setShowNew] = useState(false);
  const [toDelete, setToDelete] = useState<K8sCluster | null>(null);
  const [releasesFor, setReleasesFor] = useState<K8sCluster | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="K8s 集群"
        sub="供 upgrade_k8s 流程选择；Helm 操作在流程阶段内执行"
        actions={<Button size="sm" onClick={() => setShowNew(true)}>登记集群</Button>}
      >
        <Table head={["名称", "命名空间", "context", "kubeconfig", "创建时间", "操作"]}>
          {isLoading && (
            <tr><Td colSpan={6}><div className="text-sm text-ink-mute">加载集群清单…</div></Td></tr>
          )}
          {!isLoading && rows.length === 0 && (
            <tr><Td colSpan={6}><Empty>尚未登记集群。upgrade_k8s 流程可留空 kubeconfig 使用默认 KUBECONFIG</Empty></Td></tr>
          )}
          {rows.map((c) => (
            <Tr key={c.id}>
              <Td>
                <div className="font-medium">{c.name}</div>
                <div className="font-mono text-[11px] text-ink-mute">{c.id}</div>
              </Td>
              <Td><Tag tone="brand">{c.namespace}</Tag></Td>
              <Td className="font-mono text-xs text-ink-soft">{c.context || "—"}</Td>
              <Td className="max-w-[280px] truncate font-mono text-[11px] text-ink-mute">{c.kubeconfig}</Td>
              <Td className="text-xs text-ink-mute">{fmtDate(c.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setReleasesFor(c)}>Helm Release</Button>
                  <Button size="sm" variant="ghost" onClick={() => nav("/flows?new=1&mode=upgrade_k8s")}>
                    建升级流程
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(c)}>删除</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <NewClusterDialog open={showNew} onClose={() => setShowNew(false)} />

      <ReleasesModal cluster={releasesFor} onClose={() => setReleasesFor(null)} />

      <ConfirmDialog
        open={!!toDelete}
        title="删除集群登记"
        body={toDelete ? `将删除「${toDelete.name}」的连接信息。已创建的流程仍可执行，但按 cluster_id 引用该集群的阶段会找不到凭证。` : ""}
        danger
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          del.mutate(toDelete.id, {
            onSuccess: () => { toast("集群已删除"); setToDelete(null); },
            onError: () => { toast("删除失败", "error"); setToDelete(null); },
          });
        }}
      />

      <Card title="提示" tight>
        <p className="px-4 py-3 text-xs leading-5 text-ink-soft">
          需要回滚时进入对应 <Link to="/flows" className="text-brand hover:underline">K8s 升级流程</Link>，
          页面右上角「Helm 回滚」会调用 <code className="font-mono">helm rollback</code>；
          「回滚预案」阶段只生成命令清单，不执行回滚。
        </p>
      </Card>
    </div>
  );
}

function ReleasesModal({ cluster, onClose }: { cluster: K8sCluster | null; onClose: () => void }) {
  const id = cluster?.id ?? "";
  const { data, isError, error } = useQuery({
    // 哨兵 key 不能写成 ["k8s","clusters",…] 形式：qk.clusters 的失效是前缀匹配，会连收起的面板一起去请求
    queryKey: id ? qk.releases(id) : ["k8s", "releases", "none"],
    queryFn: () => endpoints.clusterReleases(id),
    enabled: Boolean(id),
    retry: 0,
  });
  if (!cluster) return null;
  // 成功体是 {ok:true, data:{releases:[…]}}（k8s-ops config.ts 的 output 把负载包在 data 里），
  // 顶层没有 releases——照计划原样读会永远渲染成空表。
  const inner = data?.data;
  const payload = typeof inner === "object" && inner !== null ? inner as { releases?: unknown } : undefined;
  const rawList = Array.isArray(payload?.releases) ? payload.releases : null;
  const releases = rawList
    ? rawList.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    : [];
  // 结果没落地又没失败＝仍在途：断网时请求停在 fetchStatus=paused，光看 isFetching 会把在途显示成空表
  const pending = data === undefined && !isError;
  // 四条分支各自独立（详见契约校正 16/17/18 与已落地实现 frontend/src/pages/K8s.tsx）：
  // 404 → ApiError.message；{ok:false} → releaseError 抽一行；{ok:true} 但拿不到数组 → 不猜清单；在途 → pending
  const scriptFailed = !isError && data?.ok === false;
  const shapeMismatch = !isError && !scriptFailed && data !== undefined && rawList === null;
  const reason = isError
    ? (error instanceof ApiError ? error.message : "查询失败")
    : scriptFailed ? releaseError(typeof data?.error === "string" ? data.error : "")
    : shapeMismatch ? "后端返回体里没有 releases 数组，前端不猜清单"
    : null;
  return (
    <Card
      title={`Helm Release · ${cluster.name}`}
      sub={pending ? "查询中…" : reason ? "未取得 release 清单" : `${releases.length} 个 release（namespace ${cluster.namespace}）`}
      actions={<Button size="sm" variant="ghost" onClick={onClose}>收起</Button>}
    >
      {reason && (
        <p className="mb-3 rounded-btn bg-danger/10 px-3 py-2 text-xs text-danger">
          {scriptFailed ? "后端 helm list 未成功：" : "未取得清单："}{reason}
        </p>
      )}
      <Table head={["Release", "namespace", "revision", "状态", "Chart", "App 版本"]}>
        {pending && <tr><Td colSpan={6}><div className="text-sm text-ink-mute">读取 release 清单…</div></Td></tr>}
        {!pending && !reason && releases.length === 0 && <tr><Td colSpan={6}><Empty>该 namespace 下没有 release</Empty></Td></tr>}
        {releases.map((r) => (
          // 稳定 key：下标 key 在清单变动时会错行
          <Tr key={`${cell(r.namespace)}/${cell(r.name)}/${cell(r.revision)}`}>
            <Td className="font-medium">{cell(r.name)}</Td>
            <Td className="font-mono text-xs">{cell(r.namespace)}</Td>
            <Td className="font-mono text-xs">{cell(r.revision)}</Td>
            <Td><Tag tone={r.status === "deployed" ? "ok" : "warn"}>{cell(r.status)}</Tag></Td>
            {/* helm list -o json 的 chart 已经是 <name>-<version>，没有独立 version 键 */}
            <Td className="font-mono text-xs">{cell(r.chart)}</Td>
            <Td className="font-mono text-xs">{cell(r.app_version)}</Td>
          </Tr>
        ))}
      </Table>
    </Card>
  );
}
```

> `cell()` / `releaseError()` / `kubeFirstLine()` 最终住在 `frontend/src/lib/k8sRelease.ts`（页面只 export 组件）。删除集群要用 `setReleasesFor((cur) => cur?.id === 被删 id ? null : cur)` 把那个集群正开着的 release 面板一起收掉（契约校正 18③）。

失败原因不能整坨端上页面：`K8sOpsService.call` 在 node 非零退出或 stdout 为空时返回 `{ok:false, error:"<node stderr>"}`，整坨栈直接糊到页面对运维毫无用处。实现里由 `lib/k8sRelease.ts` 的 `releaseError` 先滤掉栈帧（`node:internal` 一行都不许过），再从剩下的行里取**最后**一条带信息量的行——node 把致命信息排在帧块之前，第一条匹配常常只是 harmless 的 warning；一行都挑不出来就退回固定文案，截断时补 `…`。

- [ ] **Step 3：验证 + Commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 无错误

```bash
git add frontend/src/pages/K8s.tsx frontend/src/components/k8s
git commit -m "feat(frontend): K8s 集群登记与 Helm release 查看"
```
> 19. **M6 落地时的后端/镜像事实（T6.1 已按此实施，`fddbcef`；T6.2/T6.3 以此为准）**：① 移除 `/` 兜底路由与 `/static/**` 挂载后，8848 上只剩 `/healthz`（`IndexController`）+ `/favicon.ico`（内联 SVG，**不再从磁盘读**，那条资源处理器就是删掉的东西）。**不会打死 pod**：`k8s/deployment.yaml:42-64` 的 liveness/readiness/startup 三个探针与 `Dockerfile:66-67` 的 HEALTHCHECK 全部打 `/healthz`，没有一个依赖 `/`。② 代价是 `README.md:72`「http://127.0.0.1:8848/」与 `start.sh:7` 的同一句话从此失效（这两个行号是 **T6.3 之前**的位置，按此执行后该表述已不在 README 里，`start.sh` 整个文件也已删除）——**T6.3 必须删掉「打开后端根路径即控制台」的表述**，改成前端 dev（`frontend && npm run dev`）或 nginx 镜像。③ 计划正文 Step 3 的 `./mvnw -q -DskipTests package` 在本机**不能执行**：Windows 下运行中的 JVM 独占 `target/cloudops-console-2.0.0.jar`，package/clean 会以 IOException 失败并可能留下半个 jar；只能 `mvn -o -q compile`（`mvnw.cmd` 在 Git Bash 下还会静默 no-op）。因此 T6.1 的**运行时验证（`/` 返回 404、`/healthz` 仍 200）挂起，等一次后端重启再补**，别当成已验证。④ `frontend/nginx.conf` 里写死 `cloudops-console:8848` 不可用：本仓库根本没有 docker-compose 文件，部署走 `k8s/*.yaml`，Service 全名是 `cloudops-console.cloudops.svc.cluster.local:8848`（`k8s/service.yaml:2-16`，namespace `cloudops`）；而 nginx 对字面量 `proxy_pass` 在**解析配置时**就做一次 DNS，域名解析不到时容器根本起不来。所以上游要做成环境变量可替换（官方 nginx 镜像的 `/etc/nginx/templates/*.template` envsubst 即可），默认指集群内 DNS，本机跑时 `-e SHIPDESK_API_UPSTREAM=host.docker.internal:8848` 覆盖。⑤ `.dockerignore` 必须**两份**：根目录那份管 `docker build .`；`docker build -f frontend/Dockerfile … frontend` 的 context 是 `frontend/`，Docker 只读 context 根的 `.dockerignore`，所以还须 `frontend/.dockerignore` 排除 `node_modules`/`dist`/`test-results`/`playwright-report`，否则 `COPY . .` 会把几百 MB 的 node_modules 塞进构建层。
>
> 后端与镜像清理（M6）实施约束：本机 8848 上有一个**别人启动的** `java -jar cloudops-console-2.0.0.jar`（PID 28228，CWD=`backend-java/`），8849 上还挂着 `kubectl -n cloudops port-forward`——两者都不得被任何任务杀掉或重启。Docker 已装（Server 29.7.2），所以 Task 6.2 Step 5 的「若本机无 Docker」兜底分支不适用，必须真机构建两个镜像。

---

## M6 后端与镜像清理（前端解耦）

### Task 6.1：移除 Java 静态资源挂载

**Files:**
- Modify: `backend-java/src/main/java/com/cloudops/config/WebConfig.java`
- Modify: `backend-java/src/main/java/com/cloudops/config/IndexController.java`

- [ ] **Step 1：`WebConfig.java` 只留 CORS**

```java
package com.cloudops.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    /** 前端独立部署，跨域放开以便本地 dev 与任意静态托管访问。 */
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")
                .allowedMethods("*")
                .allowedHeaders("*")
                .allowCredentials(true);
    }
}
```

- [ ] **Step 2：`IndexController.java` 删掉 `/` 处理器，保留健康检查与图标**

```java
package com.cloudops.config;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class IndexController {

    @GetMapping("/healthz")
    public ResponseEntity<Map<String, String>> healthz() {
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    @GetMapping(value = "/favicon.ico", produces = "image/svg+xml")
    public ResponseEntity<String> favicon() {
        String svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">"
                + "<rect width=\"32\" height=\"32\" rx=\"7\" fill=\"#2563eb\"/>"
                + "<path d=\"M8 22V13l5 3 5-3v9\" stroke=\"#fff\" stroke-width=\"2.2\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
                + "<circle cx=\"23\" cy=\"19\" r=\"3\" stroke=\"#fff\" stroke-width=\"2\" fill=\"none\"/></svg>";
        return ResponseEntity.ok()
                .header("Cache-Control", "public, max-age=86400")
                .contentType(org.springframework.http.MediaType.valueOf("image/svg+xml"))
                .body(svg);
    }
}
```

> 品牌名已是 ShipDesk，但 jar 名、包名 `com.cloudops`、环境变量 `CLOUDOPS_*` 保持不变——改名会影响 Dockerfile 与运维脚本，属于后续独立变更。

- [ ] **Step 3：编译并确认无 `/static` 残留引用**

Run: `cd backend-java && ./mvnw -q -DskipTests package && grep -rn "frontend" src/main/java || echo "clean"`
Expected: 打包成功；`clean`

- [ ] **Step 4：Commit**

```bash
git add backend-java/src/main/java/com/cloudops/config
git commit -m "refactor(backend): 前端解耦，移除静态资源挂载与 index 兜底路由"
```

### Task 6.2：Dockerfile 拆分与前端镜像

**Files:**
- Modify: `Dockerfile`
- Create: `frontend/Dockerfile` `frontend/nginx.conf` `.dockerignore`

- [ ] **Step 1：主 `Dockerfile` 去掉 `COPY frontend /app/frontend`**

删除这两行（第 58–59 行）：

```dockerfile
# 复制前端
COPY frontend /app/frontend
```

其余阶段与 `ENV` 不动。

- [ ] **Step 2：`frontend/Dockerfile`**（落地版，含两处对计划正文的校正）

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 分离部署到 CDN / 静态托管时才需要绝对 API base；留空即同源，交给 nginx 反代
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

FROM nginx:1.27-alpine
# 模板名必须叫 default.conf.template：渲染出的 /etc/nginx/conf.d/default.conf 正好覆盖官方默认站点，
# 否则两份 server 都 listen 80，默认站点会以 server_name localhost 抢占未匹配的 Host，令反代与 SPA 回落失效
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /build/dist /usr/share/nginx/html
ENV SHIPDESK_API_UPSTREAM=cloudops-console.cloudops.svc.cluster.local:8848
EXPOSE 80
```

> 校正：`package-lock.json*` 与 `npm ci || npm install` 都要去掉——锁文件已入库，回落到 `npm install` 只会把锁文件漂移藏起来，构建也不再可复现。

- [ ] **Step 3：`frontend/default.conf.template`（SPA fallback + `/api` 反代到后端）**

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # 前端 <64 MiB 走单次 multipart、≥64 MiB 才按 8 MiB 分片（useChunkedUpload.ts 的 SINGLE_LIMIT）。
  # 64 MiB 差一点的文件整份进请求体，加上 MIME 边界就越过 64m，会在 nginx 吃 413 —— 上限必须留余量。
  client_max_body_size 128m;

  gzip on;
  gzip_vary on;
  gzip_min_length 1024;
  gzip_types text/css text/javascript application/javascript application/json image/svg+xml;

  location /api/ {
    proxy_pass http://${SHIPDESK_API_UPSTREAM};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # SSE：必须关缓冲，否则阶段日志不会流式到达
    proxy_buffering off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding on;
  }

  location /healthz {
    proxy_pass http://${SHIPDESK_API_UPSTREAM}/healthz;
  }

  # 产物名带内容哈希，可以放心永久缓存
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  # 壳文件不能缓存：旧 index.html 指向的哈希产物在新版本里已经不存在
  # 下面的 SPA 回落内部重定向会重新匹配到这里，所以深链接同样拿到 no-cache
  location = /index.html {
    add_header Cache-Control "no-cache";
  }

  # SPA：非实体路径一律回落 index.html，交给 React Router
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

> 计划正文原先写死 `proxy_pass http://cloudops-console:8848` 且文件名是 `nginx.conf`：本仓库没有 compose 文件、部署走 `k8s/*.yaml`，Service 全名带 namespace；而 nginx 对字面量域名在**解析配置时**就做一次 DNS，解析不到容器直接起不来。所以改成官方镜像的 `/etc/nginx/templates/*.template` envsubst 注入 `SHIPDESK_API_UPSTREAM`。
> `64m` 也不是终点：`application.properties:5-6` 的后端上限是 2048MB，真正卡人在哪儿由这一行决定。

- [ ] **Step 4：`.dockerignore`（**两份**，因为两个 build 的 context 不同）**

仓库根（管 `docker build .`）：

```
.git
frontend/node_modules
frontend/dist
frontend/playwright-report
frontend/test-results
backend-java/target
backend-java/.m2
k8s-ops/node_modules
data
*.db
```

`frontend/.dockerignore`（管 `docker build -f frontend/Dockerfile … frontend`；Docker 只读 context 根的那份，少了它 `COPY . .` 会把几百 MB 的 node_modules 塞进构建层）：

```
node_modules
dist
playwright-report
test-results
e2e
```

- [ ] **Step 5：构建验证（本机装有 Docker 就必须真跑，不许只写不验）**

```bash
docker build -t shipdesk-api:dev .
docker build -f frontend/Dockerfile -t shipdesk-web:dev frontend
```
Expected: 两个镜像均构建成功

配套的四条实盘证据（`a943245`/`706fba6`/`78b6be9` 三个 commit 都跑过）：

1. 后端镜像里已经没有前端：`docker run --rm --entrypoint sh shipdesk-api:dev -c "ls /app"` →
   `app.jar backups k8s-ops scripts`，`test -e /app/frontend` 为 NO。
2. envsubst 只吃已定义的环境变量，nginx 自己的 `$host`/`$uri` 不会被吞：起容器后
   `docker exec c sh -c "nginx -T"` 里同时出现渲染后的 `proxy_pass http://<上游>;` 与字面量
   `proxy_set_header Host $host;`、`try_files $uri $uri/ /index.html;`。
3. 官方默认站点确实被覆盖：`ls /etc/nginx/conf.d/` 只剩一份 `default.conf`，`grep server_name` 只有 `server_name _;`。
4. 反代与回落到活后端上跑通：`docker run -d -p 5180:80 -e SHIPDESK_API_UPSTREAM=host.docker.internal:8848`，
   `/` → 200 `text/html` 含 `id="root"`；`/flows` → 200（深链接走回落）；`/api/environments` → 200 JSON
   （**注意路径是 `/api/environments`，`/api/envs` 会 404**）；`/healthz` → `{"status":"ok"}`；
   `/assets/*.js` 带 `Content-Encoding: gzip`（411 KB → 实测 147 KB）与 `immutable`，`/` 与 `/flows` 带 `no-cache`。
   注意 `--entrypoint sh` 起容器时模板**不会**渲染（官方入口只在 `$1` 为 nginx 时做 envsubst），
   要验渲染必须以正常 CMD 起来再 `nginx -T`。

- [ ] **Step 6：Commit**

```bash
git add Dockerfile frontend/Dockerfile frontend/nginx.conf .dockerignore
git commit -m "build: 前端独立镜像与 nginx 反代，后端镜像不再打包前端"
```

### Task 6.3：清理失效文件与文档

**Files:**
- Delete: `start.sh` `requirements.txt`
- Modify: `README.md`

- [ ] **Step 1：删除失效文件**

```bash
git rm -f start.sh requirements.txt
```

- [ ] **Step 2：README 更新点（逐条改，不重写全文）**

1. 标题与产品名改为 **ShipDesk Console**（保留 `cloudops-console` jar 名并注明「构建产物名沿用」）。
2. 「快速开始」删除 Python/uvicorn 段落，改成两条：
   ```bash
   # 后端
   cd backend-java && ./mvnw package -DskipTests && java -jar target/cloudops-console-2.0.0.jar
   # 前端
   cd frontend && npm install && npm run dev     # http://127.0.0.1:5173
   ```
3. 目录结构：`backend/`（Python）条目删除，`frontend/` 描述改为 React + TS + Vite，新增 `docs/superpowers/`。
4. API 表补充：`/api/catalog/{mode}`、`/api/k8s/clusters*`、`/api/flows/{id}/rollback`、`/api/packages/upload/init|chunk|{id}|{id}/complete`。
5. 设计说明里「迁移尚未接入控制台」那段补一句：迁移/扩容作为新 mode 的路线见 `docs/superpowers/specs/2026-10-04-shipdesk-react-frontend-design.md` §11–§12。
6. 新增「前端独立部署」小节：nginx 反代 `/api`、SSE 需 `proxy_buffering off`、`client_max_body_size ≥ 64m`。

- [ ] **Step 3：Commit**

```bash
git add -A README.md start.sh requirements.txt
git commit -m "docs: 更新为 Java 后端 + React 前端，移除 Python 残留"
```

> **契约校正 20（T6.3 落地为 `bad299f`+`b44daf3`，覆盖本节正文）**：
> ① Step 3 的 `git add -A …` 禁用（本计划全程只允许显式路径）；而且 `git rm` 之后工作区里已经没有 `start.sh`/`requirements.txt`，再 `git add start.sh` 直接 `fatal: pathspec did not match`——删除已经进索引，只需 `git add README.md`。
> ② 逐条改远远不够：README 的「为什么是阶段流水线 / 闸门表 / 状态机 / 七阶段」这类**叙述**仍然成立，但 `快速开始`、`目录结构`、`两个核心文件`、`API`、`真实/模拟模式`、`验证`、`技术栈` 七节的**事实**几乎全部指向已删除的 Python 实现，必须整节重写并按 `file:line` 逐条对 Java 源码核实。核实后落地的几条：Spring Boot parent 是 `4.1.1`（`pom.xml:10`）；升级流程的「升级前备份」是 `required=true`（`Workflow.java:305-307`，旧文案只说「不建议跳过」）；`confirm=false` 的恢复是 **428**（`ApiController.java:727-728`）、跳过必经阶段是 **409**（`:381`）；SSE 先重放历史（事件带 `replay: true`）终态才推 `close`；`/api/capabilities` 的键恰好是 `ssh/rsync/force_mock/effective_mode/mock_notice`。
> ③ 后端侧**仍然有** Python：`backend-java/scripts/` 那 4 个脚本由 Java 用 `python3` 调用且只依赖标准库，`backend-java/e2e_test.py` 是活的端到端冒烟（stdlib urllib，`BASE` 写死 8848，取 `envs[0]`）。所以「移除 Python 残留」只指 FastAPI 后端与 `requirements.txt`，别写成「本仓库不再有 Python」。
> ④ `frontend/e2e/` 在 M6 结束时**还不存在**，README 的「验证」节必须如实说「浏览器端 E2E 还没有，Playwright 骨架已就位（testDir `./e2e`、baseURL 5173、`SHIPDESK_WEB` 可覆盖）」，等 M7 落地再补。
> ⑤ 分离托管的前提：产物调的是**同源** `/api`（`client.ts:26` 的 `VITE_API_BASE ?? ""`），所以「静态文件托管在哪都行」只有在托管点能反代 `/api`、或构建期注入 `VITE_API_BASE` 时才成立。

---

## M7 端到端验证与收尾

> **契约校正 21（T7.1 的 I4 缺陷在浏览器里坐实，覆盖 Task 4.4/4.6 的 close 帧处理）**：
> ① `close` 帧**不断流**。服务端是「`send(close)` → `break` → `detach` → `complete()`」（`ApiController.java:437-457`），在这一帧上 `es.close()` 掐断的是尚未落地完的响应，Playwright 的 `requestfailed` 就记下 `net::ERR_ABORTED`。真正的断开时机是紧随其后的 `onerror`：那时响应已正常结束，关闭它只阻止浏览器自动重连与二次全量重放，不留任何失败请求。
> ② `enabled` 落下与**换阶段都不算断流理由**。轮询到的 `stage.status` 和向导推进（`onDone` 就在 `stage_done` 上发生）都比 `close` 帧（最迟下一轮 ~300ms tick）先走一步，effect 清理里那句 `es.close()` 会把每一条**被观察到的**流都变成 abort：一次 7 阶段走完就是 4 条 `ERR_ABORTED`（只有快到来不及被看见 running 的阶段不报）。
> ③ 落地形态：连接由 `useStageStream` 内部的会话表按 `flowId+stageKey` 持有，只有三种情况真断——流自己走完（`close` + `error`）、被放弃过又重开（新一轮运行）、卸载/换流程；`enabled` 落下与换阶段只是「放弃」（缓冲清空、兜底轮询撤下，`hush`）。缓冲区进 `state` 前要过 `activeKeyRef` 这道闸，否则 A 迟到的日志会串进 B 的面板。
> ④ 单测里 `FakeEventSource.close()` 只置标记、仍会派发帧，所以「close 帧后不断流」这一步必须显式 `emit(closeEvent)` → 断言 `closed === false` → `fail()` → 断言 `closed === true`，否则替身会把真实 EventSource 的「响应已结束」这一层语义替掉。
> ⑤ 「放弃」必须在**目标一换**就对不属于当前目标的会话生效（`enabled` 落下只查得到当前目标，查不到刚被换走的那条）：缓冲区有 `activeKeyRef` 挡着，兜底轮询与 `degraded` 横幅挡不住——被换走的流断线会给另一个阶段挂上「实时连接中断，已转轮询」并留一个没人撤的 1.2s 轮询。横幅的两个写入点（`onopen` 熄灭、`onerror` 点亮）同样只认当前视图。
> ⑥ StrictMode 双挂载（`main.tsx:10`，dev 模式每次进向导都走）是 ③ 里「同一目标重开」的假阳性：`enabled` 从没落下过，同一轮运行却因 mount→unmount→mount 被拆成两条连接，第一条正好掐在半路 → dev 控制台固定一句 `ERR_ABORTED`。改为 `adopt()`：没被放弃过的同目标会话直接接管（不新建也不关闭），只有 `hush` 过的才让位。卸载的断开随之推迟一个宏任务，重挂时由同一句 effect 取消——真卸载仍是到点就断。
> 复现要点：`renderHook` 复现不出 StrictMode 的双跑（它只调用 callback 取返回值，effect 归内部组件、wrapper 的 StrictMode 不触发重挂），必须用 `render(<StrictMode><QueryClientProvider>…`。

### Task 7.1：Playwright E2E —— 安装全流程

**Files:**
- Create: `frontend/e2e/install-flow.spec.ts`
- Create: `frontend/e2e/fixtures.ts`

- [ ] **Step 1：`e2e/fixtures.ts`**

```ts
import { expect, type Page } from "@playwright/test";

const STAGES = [
  "环境登记", "环境校验", "上传安装包", "包分发",
  "安装前备份", "执行安装", "安装后验证",
];

export async function createFlow(page: Page, name: string) {
  await page.goto("/flows?new=1");
  await page.getByPlaceholder("生产-AZ1 全新安装").fill(name);
  const envSelect = page.locator("select").nth(1);
  if (await envSelect.inputValue() === "") {
    await page.goto("/envs");
    await page.getByRole("button", { name: "新建环境" }).click();
    await page.getByPlaceholder("生产-AZ1").fill(`e2e-${Date.now()}`);
    await page.getByRole("button", { name: "创建" }).click();
    await page.getByRole("button", { name: "建流程" }).first().click();
    await page.getByPlaceholder("生产-AZ1 全新安装").fill(name);
  }
  await page.getByRole("button", { name: "创建并进入" }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f]{12}$/);
}

/** 逐个阶段：填充演示数据（如有节点矩阵）→ 校验并执行 → 等待阶段徽章变绿 */
export async function walkStages(page: Page, untilStageTitle?: string) {
  for (const title of STAGES) {
    if (untilStageTitle && title === untilStageTitle) return;
    const rail = page.locator("li").filter({ hasText: title });
    await expect(rail.first()).toBeVisible();
    await rail.first().click();

    const demo = page.getByRole("button", { name: "填充演示数据" });
    if (await demo.count() > 0 && await demo.first().isEnabled()) await demo.first().click();

    const run = page.getByRole("button", { name: /校验并执行|重试此阶段/ });
    if (!(await run.isVisible())) {
      // 该阶段已被跳过/通过，直接下一个
      continue;
    }
    await run.click();
    await expect(page.locator("main")).toContainText("待执行", { timeout: 60_000 });
  }
}

export async function expectStagePassed(page: Page, title: string) {
  await expect(
    page.locator("li").filter({ hasText: title }).first()
  ).toContainText(/已通过|已跳过/, { timeout: 60_000 });
}
```

- [ ] **Step 2：`e2e/install-flow.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import { createFlow, walkStages, expectStagePassed } from "./fixtures";

const MOCK = process.env.SHIPDESK_FORCE_MOCK === "1";

test.describe("安装流程", () => {
  test("7 阶段可推进到底并流程转 succeeded", async ({ page }) => {
    test.skip(!MOCK, "真实模式需目标环境，CI 用强制模拟");
    const name = `e2e-install-${Date.now()}`;
    await createFlow(page, name);

    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await walkStages(page);
    for (const t of ["环境登记", "环境校验", "包分发", "安装前备份", "执行安装", "安装后验证"]) {
      await expectStagePassed(page, t);
    }
    // I4：SSE 收尾不应留下 ERR_ABORTED
    expect(errors.filter((e) => /ERR_ABORTED|Failed to load resource/.test(e))).toEqual([]);
  });

  test("locked 阶段不可进入（I2）", async ({ page }) => {
    test.skip(!MOCK, "同上");
    await createFlow(page, `e2e-gate-${Date.now()}`);
    await page.locator("li").filter({ hasText: "包分发" }).first().click().catch(() => {});
    await expect(page.getByRole("heading", { name: /1\. 环境登记/ })).toBeVisible();
  });
});
```

- [ ] **Step 3：跑 E2E**

```bash
cd backend-java && java -jar target/cloudops-console-2.0.0.jar   # 需 CLOUDOPS_FORCE_MOCK=1
cd frontend && npm run dev                                        # 另开 shell
SHIPDESK_FORCE_MOCK=1 npx playwright test e2e/install-flow.spec.ts
```
Expected: 2 passed

- [ ] **Step 4：Commit**

```bash
git add frontend/e2e
git commit -m "test(frontend): 安装全流程 E2E 与门禁回归"
```

- [ ] **Step 4.5：I4 收尾缺陷的修复（契约校正 21）**

首跑（`6cc3ab4`）里 test 1 的七阶段确实全绿、后端 `status=succeeded 7/7`，但守卫拦到 4 条
`GET /api/flows/{id}/stages/{key}/stream → net::ERR_ABORTED`（被观察到的每条流一条，没被观察到的是因为快到来不及看见 `running`）。
根因两条都在 `useStageStream` 的收尾时机上，改法见契约校正 21①②③：`close` 帧只落终态、断开交给随后的 `onerror`；
`enabled` 落下与换阶段只「放弃」会话不断流。落地为显式路径修复提交，涉及文件只有：

```bash
git add frontend/src/hooks/useStageStream.ts frontend/src/hooks/useStageStream.test.tsx
git commit -m "fix(frontend): 阶段流的收尾交给 close 之后的 error，abort 不再留 ERR_ABORTED"
```

复跑：`SHIPDESK_WEB=http://127.0.0.1:5174 npx playwright test e2e/install-flow.spec.ts --headed` → 2 passed（连跑两次稳定），
`npx vitest run` 349 passed、`npx tsc -b` 与 `npx eslint src` 均 0。

复审在这条修复上又坐实两处（契约校正 21⑤⑥）：目标一换就要对所有非当前目标的会话 `hush`，
否则被换走的流会把降级横幅与 1.2s 轮询挂到另一个阶段上；StrictMode 的双挂载改为 `adopt()` 接管原连接，
卸载的断开推迟一个宏任务给重挂留取消窗口。复跑同上一条命令 → 2 passed，`npx vitest run` 352 passed、
`npx tsc -b`、`npx eslint src`、`npm run build` 均 0。

### Task 7.2：E2E —— 分片续传与 upgrade_k8s

**Files:**
- Create: `frontend/e2e/chunked-upload.spec.ts` `frontend/e2e/upgrade-k8s.spec.ts`

- [ ] **Step 1：`chunked-upload.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

const SIZE = 180 * 1024; // 180 KB，单请求阈值以下，用来自检文件名与列表

test("上传安装包出现在仓库且校验和可读", async ({ page }) => {
  await page.goto("/packages");
  await page.setInputFiles('input[type=file]', {
    name: "demo-bundle-v2.4.0.tar.gz",
    mimeType: "application/gzip",
    buffer: Buffer.alloc(SIZE, 7),
  });
  await page.getByRole("button", { name: "开始上传" }).click();
  await expect(page.getByText("demo-bundle-v2.4.0.tar.gz")).toBeVisible({ timeout: 30_000 });
});

test("流程内上传会挂到 package_upload 阶段（I3）", async ({ page, request }) => {
  // 直接建流程，避免依赖 UI 建环境
  const env = await request.post("/api/environments", { data: { name: `e2e-up-${Date.now()}` } });
  const envId = (await env.json()).id;
  const flow = await request.post("/api/flows", { data: { name: "e2e-upload", env_id: envId, mode: "install" } });
  const flowId = (await flow.json()).id;

  await page.goto(`/flows/${flowId}`);
  await page.locator("li").filter({ hasText: "上传安装包" }).first().click();
  await page.setInputFiles('input[type=file]', {
    name: "chart.tgz", mimeType: "application/gzip", buffer: Buffer.alloc(4 * 1024, 3),
  });
  await page.getByRole("button", { name: "开始上传" }).click();
  await expect(page.getByText("chart.tgz")).toBeVisible({ timeout: 30_000 });

  const detail = await (await request.get(`/api/flows/${flowId}`)).json();
  const stage = detail.stages.find((s: { key: string }) => s.key === "package_upload");
  expect(stage.inputs._package_ids?.length).toBeGreaterThan(0);
  expect(stage.inputs._package_id).toBeTruthy();
});
```

- [ ] **Step 2：`upgrade-k8s.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("upgrade_k8s 渲染 6 个阶段且末阶段可跳过", async ({ page, request }) => {
  const flow = await request.post("/api/flows", {
    data: { name: "e2e-k8s", env_id: "", mode: "upgrade_k8s" },
  });
  const id = (await flow.json()).id;
  await page.goto(`/flows/${id}`);

  await expect(page.locator("li")).toHaveCount(6);
  await expect(page.getByText(/回滚预案/)).toContainText("可跳过");

  // 表单来自 catalog，K8s 专有字段必须出现
  await expect(page.getByText("Helm Release 名称")).toBeVisible();
  await expect(page.getByText("目标 Chart 版本")).toBeVisible();
  await expect(page.getByRole("button", { name: "Helm 回滚" })).toBeVisible();
});

test("非法 mode 被后端拒绝", async ({ request }) => {
  const r = await request.post("/api/flows", { data: { name: "bad", env_id: "", mode: "migrate" } });
  expect(r.status()).toBe(400);
});
```

- [ ] **Step 3：跑 E2E**

Run: `cd frontend && npx playwright test`
Expected: M7.1 + M7.2 全部 passed

- [ ] **Step 4：Commit**

```bash
git add frontend/e2e
git commit -m "test(frontend): 分片上传与 upgrade_k8s E2E"
```

### Task 7.3：全量验证与验收清单

- [ ] **Step 1：单测 + 类型 + lint + 构建全绿**

```bash
cd frontend
npx vitest run
npx tsc --noEmit -p tsconfig.json
npm run lint
npm run build
```
Expected: 全绿；`dist/` 产出带 hash 的 assets

- [ ] **Step 2：后端测试与打包**

Run: `cd backend-java && ./mvnw -q test && ./mvnw -q -DskipTests package`
Expected: BUILD SUCCESS

- [ ] **Step 3：解耦部署实盘验证**

```bash
cd backend-java && java -jar target/cloudops-console-2.0.0.jar
cd frontend && npm run build && npx serve dist -l 5173   # 或 docker run shipdesk-web:dev
```

逐项确认（浏览器 + 控制台无 error）：
1. 静态站点独立于 8848 提供页面；`/api` 反代或 Vite 代理可用。
2. `GET http://127.0.0.1:8848/` 现在返回 404，`/healthz` 与 `/favicon.ico` 仍 200。
3. 模式徽章与后端 `effective_mode` 一致；`CLOUDOPS_FORCE_MOCK=1` 重启后徽章变「模拟模式（已强制模拟）」（I1）。
4. install / upgrade / upgrade_k8s 三种流程各自阶段数正确（7/5/6）。
5. 阶段执行时日志实时滚动，阶段通过后侧栏自动解锁（I2/I4）。
6. 上传包后回到「环境登记」重跑，`_package_ids` 不丢（I3）。

- [ ] **Step 4：把验收结果写进 spec 的「交付确认」**

在 `docs/superpowers/specs/2026-10-04-shipdesk-react-frontend-design.md` 末尾追加 `## 14. 验收记录（YYYY-MM-DD）`，列出上面 6 项的实际结果与截图路径；未通过项写清原因，不留空。

- [ ] **Step 5：最终 Commit**

```bash
git add -A
git commit -m "chore(frontend): ShipDesk Console React 重写收尾与验收记录"
```

---

## 自检记录（writing-plans self-review）

**1. 规格覆盖**

| spec 条目 | 实现位置 |
|-----------|----------|
| React19/TS/Vite6/Tailwind/Router6/TanStack5 选型 | M0（T0.1–T0.3） |
| 前后端分离部署 | T6.1（去静态挂载）+ T6.2（nginx 镜像）+ T7.3 实盘 |
| 全量对齐后端能力（含 upgrade_k8s） | M1（契约/端点全覆盖）+ T4.7（mode 三选一 + 回滚）+ T5.4（集群页） |
| 分片续传上传 | T5.1 + T5.2 + T7.2 |
| 备份校验/恢复/过期 | T5.3 |
| 审计与总览 | T2.4 |
| 品牌改名为 ShipDesk | T0.3（title）+ T2.4（TopBar logo）+ T6.3（README） |
| §6 后端/Dockerfile 清理 | M6 |
| §7 测试策略（Vitest + Playwright 取代 puppeteer） | M0（配置）+ M1–M5 各 TDD 任务 + M7 |
| §11 内核路线、§12 定制化 | 明确不在本次范围；靠 catalog 驱动渲染（T4.2 的 `FieldRenderer` 全 type 覆盖、T4.7 的 `MODE_OPTIONS` 单点扩展）保证未来新增 mode 零改前端 |

**2. 占位符扫描**：无 TBD/TODO；M2 里 6 个页面 stub 在 M3/M4/M5 各自任务中被显式替换，且 stub 代码已给出。已清除全部「实现时再改」类表述，代码块即为最终代码。

**3. 类型一致性**：`mergeInputs(server, collected)` 签名在 T1.x/T4.1/T4.6 一致；`useStageStream(flowId, key, {enabled,onDone})` 与 T4.6 调用一致；`FlowCreate.env_id` 与后端 `@JsonNaming` 后的请求体一致；`qk.flow(id) = ["flows","detail",id]` 与 T4.4 断言一致；`StatusTag kind` 取值为 `stage|flow|node|backup`，与 T2.4/T3.1/T5.3 用法一致。

**遗留风险**：
- ~~`GET /api/k8s/clusters/{id}/releases` 在模拟模式下的返回结构未经真机确认~~ —— T5.4 已对真机核实：本机（后端 CWD=`backend-java/`、无 helm）恒为 HTTP 200 `{ok:false, error:"<MODULE_NOT_FOUND 栈>"}`，未知 id 为 404 `{"detail":"集群不存在"}`，成功体是 `{ok:true, data:{releases:[…]}}`；三条分支都有回归测试（`frontend/src/pages/K8s.test.tsx`）。真实 helm 输出仍需在装了 helm 的环境上跑一次 E2E（T7.2）。
- 8848 常被本机既有 java/kubectl port-forward 占用：M2/T7.3 启服务前必须先确认占用者身份再处理，不要直接杀进程。

---


