import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

/**
 * Task 7.1 的公共夹具：安装流程（mode=install，7 阶段）的浏览器侧走查。
 *
 * 一切中文串都来自已交付代码与运行中的后端，不是计划里的猜测：
 * - 阶段 key / title：`GET /api/catalog/install` 实测（Workflow.java:160-200 建目录），
 *   install-flow.spec.ts 里再用断言把这份字面量与后端实际下发的对齐，防漂移。
 * - 状态中文：与 src/lib/labels.ts 的 STAGE_CN / FLOW_STATUS_CN 逐值一致。
 *   测试刻意自带一份词表：E2E 要断言的是「用户看到的字」，复用应用的 map 会让 map 本身
 *   的错误（比如 labels 改词）静默通过。
 * - 按钮名：「创建并进入」NewFlowDialog.tsx:54、「校验并执行 / 重试此阶段」StagePanel.tsx:64、
 *   「填充演示数据」NodeMatrixEditor.tsx:99、「开始上传」UploadZone.tsx:85。
 */

export const STAGES = [
  { key: "env_register", title: "环境登记" },
  { key: "env_precheck", title: "环境校验" },
  { key: "package_upload", title: "上传安装包" },
  { key: "package_distribute", title: "包分发" },
  { key: "pre_install_backup", title: "安装前备份" },
  { key: "install_execute", title: "执行安装" },
  { key: "post_verify", title: "安装后验证" },
] as const;

export const STAGE_CN = {
  locked: "未解锁",
  ready: "待执行",
  running: "执行中",
  passed: "已通过",
  failed: "失败",
  skipped: "已跳过",
} as const;

/** FLOW_STATUS_CN.succeeded —— 全流程走完时流程头部该出现的字。 */
export const FLOW_SUCCEEDED_CN = "成功";

/** 单个 mock 阶段的执行上限：安装阶段要遍历 9 台节点，留足余量。 */
export const STAGE_RUN_TIMEOUT = 120_000;

export type StageStatusKey = keyof typeof STAGE_CN;

export interface Capabilities {
  effective_mode: string;
  force_mock: boolean;
  mock_notice?: string;
}

export interface Created {
  flowIds: string[];
  envIds: string[];
  packageNames: string[];
}

/** 本次运行的唯一后缀：所有自建数据都以它命名，绝不与共享库里的他人数据重名。含 PID，两个 worker 也不会撞名。 */
export const runId = `${Date.now().toString(36)}-${process.pid}`;

export const flowNameOf = (suffix: string) => `e2e-flow-${runId}-${suffix}`;
export const packageNameOf = () => `e2e-package-${runId}.tar.gz`;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function readCapabilities(request: APIRequestContext): Promise<Capabilities> {
  const res = await request.get("/api/capabilities");
  if (!res.ok()) throw new Error(`读取 /api/capabilities 失败：HTTP ${res.status()}，无法判定运行模式`);
  return res.json();
}

/**
 * 诚实的门禁：只在后端**真的是真实模式**时给出跳过理由，否则返回 null。
 * 计划里 `test.skip(!SHIPDESK_FORCE_MOCK)` 那种「环境变量没设就静默绿」的写法会造出假通过，
 * 所以理由由运行中的后端给出，并且由调用方把跳过喊出来（见 announceSkip）。
 */
export function mockSkipReason(caps: Capabilities): string | null {
  if (caps.effective_mode === "mock") return null;
  return `后端 effective_mode=${caps.effective_mode}（force_mock=${caps.force_mock}）：`
    + "本用例依赖 mock 执行器，真实模式下会真的去连节点，不能跑";
}

/** 把「没跑」和「跑绿了」在报告里区分开：annotations + 直接打印一行。 */
export function announceSkip(testInfo: TestInfo, reason: string): void {
  testInfo.annotations.push({ type: "NOT RUN — SKIPPED", description: reason });
  console.log(`\n[e2e][SKIPPED] ${testInfo.title}\n[e2e][SKIPPED] ${reason}\n`);
}

export function announceMode(testInfo: TestInfo, caps: Capabilities): void {
  testInfo.annotations.push({
    type: "mode",
    description: `effective_mode=${caps.effective_mode} force_mock=${caps.force_mock}`,
  });
  console.log(`[e2e][MODE] effective_mode=${caps.effective_mode} force_mock=${caps.force_mock}`);
}

/**
 * I4 的守卫：控制台错误 + 页面异常 + 请求失败（`net::ERR_ABORTED` 就出现在这里）。
 * 收集全量、断言全量，不做任何“看起来无关就放过”的过滤。
 */
export interface ConsoleGuard {
  errors: string[];
  failures: string[];
}

export function attachConsoleGuard(page: Page): ConsoleGuard {
  const guard: ConsoleGuard = { errors: [], failures: [] };
  page.on("console", (m) => {
    if (m.type() === "error") guard.errors.push(`[console.error] ${m.text()}`);
  });
  page.on("pageerror", (e) => guard.errors.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => {
    guard.failures.push(`[requestfailed] ${r.method()} ${r.url()} → ${r.failure()?.errorText ?? "unknown"}`);
  });
  return guard;
}

/**
 * 空白页会自己去请求 /favicon.ico，本应用没有 favicon（index.html 无 link 标签），
 * Vite 回 404 会打进控制台。它与 I4 无关，也不能靠放宽断言来消，故在路由层喂一个空图标，
 * 让「控制台必须干净」这条断言保持全量、零过滤。
 */
export async function stubFavicon(page: Page): Promise<void> {
  await page.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 200, contentType: "image/x-icon", body: "" }),
  );
}

export function expectNoConsoleNoise(guard: ConsoleGuard): void {
  const noise = [...guard.failures, ...guard.errors];
  expect(
    noise,
    "I4/控制台：走完安装流程不该留下任何请求失败或控制台错误"
      + `（requestfailed=${guard.failures.length}，console=${guard.errors.length}）：\n${noise.join("\n")}`,
  ).toEqual([]);
}

/** 侧栏阶段项：StageRail 的 li > button（StageRail.tsx:33-55），可访问名含「N. 标题」。 */
export function railStage(page: Page, index: number) {
  const stage = STAGES[index];
  return page.getByRole("button", { name: new RegExp(`${index + 1}\\. ${esc(stage.title)}`) });
}

/** 阶段面板标题：StagePanel 的 Card h2「N. 标题」（StagePanel.tsx:51）。 */
export function panelHeading(page: Page, index: number) {
  return page.getByRole("heading", { level: 2, name: `${index + 1}. ${STAGES[index].title}` });
}

/** 面板里唯一的执行按钮（ready → 校验并执行，failed → 重试此阶段）。 */
export function runButton(page: Page) {
  return page.getByRole("button", { name: /^(校验并执行|重试此阶段)$/ });
}

export async function expectStageStatus(page: Page, index: number, status: StageStatusKey): Promise<void> {
  const cn = STAGE_CN[status];
  await expect(railStage(page, index), `阶段「${STAGES[index].title}」应为「${cn}」`)
    .toContainText(cn, { timeout: STAGE_RUN_TIMEOUT });
}

/**
 * 选中某阶段。I2：可点性只看后端 status —— locked 的 rail 按钮是 disabled 的，
 * 这里先断言它可点，再点，再断言面板确实换到了这一阶段（点空了就是回归）。
 */
export async function selectStage(page: Page, index: number): Promise<void> {
  const btn = railStage(page, index);
  await expect(btn, `阶段「${STAGES[index].title}」尚未按后端 status 解锁`).toBeEnabled();
  await btn.click();
  await expect(panelHeading(page, index)).toBeVisible();
}

/** 执行当前面板的阶段并等它「已通过」（不通过失败/跳过混为一谈）。 */
export async function runStageToPassed(page: Page, index: number): Promise<void> {
  const title = STAGES[index].title;
  const btn = runButton(page);
  await expect(btn, `阶段「${title}」的执行按钮不该是禁用态（I2）`).toBeEnabled();
  await btn.click();
  await expect(railStage(page, index), `阶段「${title}」没有走到已通过`)
    .toContainText(STAGE_CN.passed, { timeout: STAGE_RUN_TIMEOUT });
}

/**
 * 节点矩阵填演示数据（NodeMatrixEditor 的 DEMO：4 台物理机含 3 台 control，5 台虚拟机）。
 * 断言落进了真实单元格，而不是「点了按钮没报错就算过」。
 */
export async function fillDemoNodes(page: Page): Promise<void> {
  const groups = [
    { label: "物理机列表", rows: 4, firstName: "ctrl-phy-01" },
    { label: "虚拟机列表", rows: 5, firstName: "worker-vm-01" },
  ] as const;
  for (const g of groups) {
    const group = page.getByRole("group", { name: g.label });
    await expect(group, `环境登记表单里找不到「${g.label}」矩阵`).toBeVisible();
    await group.getByRole("button", { name: "填充演示数据" }).click();
    const hostnames = group.getByRole("textbox", { name: "主机名" });
    await expect(hostnames).toHaveCount(g.rows);
    await expect(hostnames.first()).toHaveValue(g.firstName);
  }
}

/**
 * 上传安装包阶段：小文件走单请求 multipart，服务端把 `_package_id` 回填进 stage.inputs。
 * 这是后端 package_upload 校验的硬条件（Workflow.java:646「尚未上传任何安装包」），
 * 所以「7 阶段走完」必须真的在浏览器里传一个包，不能用接口绕过。
 */
export async function uploadDemoPackage(page: Page, fileName: string): Promise<void> {
  const body = Buffer.alloc(64 * 1024, "shipdesk-e2e");
  const input = page.locator('input[type="file"]');
  await expect(input, "上传安装包阶段应有且只有一个文件输入").toHaveCount(1);
  await input.setInputFiles({ name: fileName, mimeType: "application/gzip", buffer: body });
  await expect(page.getByText(`已选择：${fileName}`)).toBeVisible();

  const go = page.getByRole("button", { name: "开始上传" });
  await expect(go).toBeEnabled();
  await go.click();
  // 上传成功后 PackageChip 用流程详情的 _package_ids 渲染包名（FlowWizard.tsx:135-140、161-171）
  await expect(page.getByRole("listitem").filter({ hasText: fileName })).toBeVisible();
}

/** 新建流程：走 /flows?new=1 的预填向导（Flows.tsx:23、75-81）。返回后端给的流程 id。 */
export async function createFlowViaUi(
  page: Page,
  opts: { name: string; envId: string; envName: string },
): Promise<string> {
  await page.goto("/flows?new=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "新建流程" })).toBeVisible();

  await dialog.getByLabel(/^流程名称/).fill(opts.name);
  const envSelect = dialog.getByLabel(/^目标环境/);
  await envSelect.selectOption({ label: opts.envName });
  await expect(envSelect).toHaveValue(opts.envId);
  // 模式默认 install；断言它，用例才真的在测 7 阶段那条路。
  await expect(dialog.getByLabel(/^编排模式/)).toHaveValue("install");

  await dialog.getByRole("button", { name: "创建并进入" }).click();
  await page.waitForURL(/\/flows\/[^/?#]+$/);
  const id = /\/flows\/([^/?#]+)$/.exec(page.url())?.[1] ?? "";
  if (!id) throw new Error(`创建流程后没有拿到流程 id，当前 URL：${page.url()}`);
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(esc(opts.name)) })).toBeVisible();
  await expect(railStage(page, 0)).toBeVisible();
  return id;
}

/** 逐阶段走完全流程；index 0 需要先登记节点，index 2 需要先传包。 */
export async function walkStages(page: Page, opts: { packageName: string; baseDomain: string; version: string }): Promise<void> {
  // 阶段 1 环境登记：节点矩阵 + 一个可回查的自由文本字段（证明表单真的提交到了后端）
  await selectStage(page, 0);
  await page.getByLabel(/^基础域名/).fill(opts.baseDomain);
  await fillDemoNodes(page);
  await runStageToPassed(page, 0);

  // 阶段 2 环境校验：ssh_user / port 都有目录默认值
  await selectStage(page, 1);
  await runStageToPassed(page, 1);

  // 阶段 3 上传安装包：必须真传
  await selectStage(page, 2);
  await page.getByLabel(/^版本号/).fill(opts.version);
  await uploadDemoPackage(page, opts.packageName);
  await runStageToPassed(page, 2);

  for (const index of [3, 4, 5, 6]) {
    await selectStage(page, index);
    await runStageToPassed(page, index);
  }
}
