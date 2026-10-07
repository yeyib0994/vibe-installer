import { expect, test, type Page } from "@playwright/test";
import {
  STAGE_CN, attachConsoleGuard, announceMode, announceSkip, deleteCreated, expectNoConsoleNoise,
  flowNameOf, mockSkipReason, panelHeading, railStage, readCapabilities, runButton, runId,
  selectStage, stubFavicon, uploadBundlePackage, uploadBundleWithoutChart,
  type Capabilities, type Created, type StageRef,
} from "./fixtures";

/**
 * Task 7.2：upgrade_k8s 模式在浏览器里走通 —— 门禁、离线包链路、可跳过阶段与回滚入口。
 *
 * 阶段表与字段标签都取自运行中的后端（`GET /api/catalog/upgrade_k8s`），beforeAll 先逐字对齐，
 * 不一致就直接失败而不是让用例去断言一份后端已经不发下来的 UI。
 * 「走完 6 个必经阶段 + 跳过回滚预案」这条路只在后端处于模拟模式时成立：
 * CLOUDOPS_FORCE_MOCK=1 时 K8sOpsService 直接回合成成功并带 mock 标记（K8sOpsServiceMockTest），
 * 日志行前缀 [MOCK]；真实模式下 sidecar 报 ok=false 就把阶段打红（StageExecutorK8sHonestyTest）。
 * 真实集群那条路不在本用例范围内 —— 2026-10-07 在 Docker Desktop 的 shipdesk-verify 命名空间
 * 用真 helm/kubectl 单独实跑过，含「helm 渲染失败必须让阶段失败」这一条。
 * 「上传软件包」阶段走的是真实 multipart 上传 + 服务端 commons-compress 解包，
 * 夹具见 bundle-fixture.ts，解出来的 chart 路径由服务端注入「执行升级」的 inputs。
 */

const K8S_STAGES: StageRef[] = [
  { key: "env_register", title: "环境登记" },
  { key: "package_upload", title: "上传软件包" },
  { key: "env_precheck", title: "环境校验" },
  { key: "pre_upgrade_backup", title: "升级前备份" },
  { key: "upgrade_execute", title: "执行升级" },
  { key: "post_verify", title: "升级后验证" },
  { key: "rollback_plan", title: "回滚预案" },
];

/**
 * 阶段 1 的必填项：目录里 required=true 且无默认值的两项（命名空间有默认值，不用填）。
 * version 必须等于 bundle-fixture 写进 Chart.yaml 的那一份，否则解包阶段按契约失败。
 */
const K8S_TARGET = {
  release: "shipdesk-e2e",
  version: "1.2.3-e2e",
};

/** 自建数据名里只有字母数字与点横线，进正则前仍按字面量收口。 */
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

let caps: Capabilities = { effective_mode: "unknown", force_mock: false };
const created: Created = { flowIds: [], envIds: [], packageNames: [] };

/** 新建流程对话框：只有 K8s 升级允许环境留空，install 被前端门禁拦下。 */
async function createFlowViaUi(page: Page, name: string, modeLabel: string): Promise<string> {
  await page.goto("/flows?new=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "新建流程" })).toBeVisible();
  await dialog.getByLabel(/^流程名称/).fill(name);
  await dialog.getByLabel(/^编排模式/).selectOption({ label: modeLabel });
  // 环境留空：K8s 升级的目标是阶段 1 的 Helm Release 与阶段 2 的离线包，创建时不需要环境
  await expect(dialog.getByLabel(/^目标环境/)).toHaveValue("");
  await dialog.getByRole("button", { name: "创建并进入" }).click();
  await page.waitForURL(/\/flows\/[^/?#]+$/);
  const id = /\/flows\/([^/?#]+)$/.exec(page.url())?.[1] ?? "";
  if (!id) throw new Error(`创建流程后没有拿到流程 id，当前 URL：${page.url()}`);
  return id;
}

async function fillK8sRegister(page: Page): Promise<void> {
  await page.getByLabel(/^Helm Release 名称/).fill(K8S_TARGET.release);
  await page.getByLabel(/^目标 Chart 版本/).fill(K8S_TARGET.version);
}

test.beforeAll(async ({ request }) => {
  caps = await readCapabilities(request);
  const res = await request.get("/api/catalog/upgrade_k8s");
  expect(res.ok(), `GET /api/catalog/upgrade_k8s 返回 ${res.status()}`).toBe(true);
  const body = (await res.json()) as {
    mode: string;
    stages: { key: string; title: string; required: boolean; form_fields?: { key: string; label: string }[] }[];
  };
  expect(body.mode).toBe("upgrade_k8s");
  expect(body.stages.map((s) => s.key)).toEqual(K8S_STAGES.map((s) => s.key));
  expect(body.stages.map((s) => s.title)).toEqual(K8S_STAGES.map((s) => s.title));
  // 只有末阶段可跳过：这条决定侧栏「必经 / 可跳过」怎么标，也决定「跳过此阶段」按钮该不该出现
  expect(body.stages.map((s) => s.required)).toEqual([true, true, true, true, true, true, false]);
});

test.afterEach(async ({ request }) => {
  await deleteCreated(request, created);
});

test("向导骨架：7 阶段与必经/可跳过标注、K8s 专有表单、回滚入口、登记阶段没有上传区", async ({ page }, testInfo) => {
  announceMode(testInfo, caps);
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const name = flowNameOf("k8s-shell");
  const flowId = await createFlowViaUi(page, name, "K8s / Helm 升级");
  created.flowIds.push(flowId);

  // 头部按 modeLabel 与目录长度说话：模式与「7 阶段」都来自后端给的 mode/stages，不是前端猜的
  await expect(page.getByRole("heading", { level: 2, name: re(name) })).toBeVisible();
  await expect(page.getByText(/K8s \/ Helm 升级 · 环境 — · 7 阶段/)).toBeVisible();
  await expect(railStage(page, 6, K8S_STAGES)).toBeVisible();
  await expect(page.getByRole("button", { name: /^8\. / })).toHaveCount(0);

  for (let i = 0; i < K8S_STAGES.length; i++) {
    const btn = railStage(page, i, K8S_STAGES);
    await expect(btn, `阶段「${K8S_STAGES[i].title}」应标注 ${i === 6 ? "可跳过" : "必经"}`)
      .toContainText(i === 6 ? "· 可跳过" : "· 必经");
  }

  // I2：新建流程只有阶段 1 解锁，其余 6 个由后端 status 决定为不可点
  await expect(railStage(page, 0, K8S_STAGES)).toBeEnabled();
  await expect(railStage(page, 0, K8S_STAGES)).toContainText(STAGE_CN.ready);
  for (let i = 1; i < K8S_STAGES.length; i++) {
    await expect(railStage(page, i, K8S_STAGES), `阶段「${K8S_STAGES[i].title}」不该可点`).toBeDisabled();
    await expect(railStage(page, i, K8S_STAGES)).toContainText(STAGE_CN.locked);
  }

  // 目录里阶段 1 的字段必须真的渲染出来（离线包专有：集群 ID 与 chart 仓库已随 registry 退役）
  await selectStage(page, 0, K8S_STAGES);
  for (const label of ["kubeconfig 路径/内容", "命名空间", "Helm Release 名称", "目标 Chart 版本"]) {
    await expect(page.getByLabel(new RegExp(`^${label}`)), `表单缺少目录字段「${label}」`).toBeVisible();
  }
  await expect(page.getByLabel(/^集群/)).toHaveCount(0);
  await expect(page.getByLabel(/^Chart 名称/)).toHaveCount(0);
  await expect(page.getByLabel(/^Chart 仓库地址/)).toHaveCount(0);
  // 上传区只属于 package_upload（FlowWizard.tsx:52）；本阶段没有，安装专有项也不该出现
  await expect(page.getByRole("heading", { level: 3, name: "安装包上传" })).toHaveCount(0);
  await expect(page.getByLabel(/^基础域名/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "填充演示数据" })).toHaveCount(0);

  // 回滚是真实 helm 操作，入口在流程头部且强制确认；这里只走到「取消」，一个请求都不该发
  await expect(page.getByRole("button", { name: "Helm 回滚" })).toBeVisible();
  const rollbackPosts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/flows/${flowId}/rollback`)) rollbackPosts.push(r.url());
  });
  await page.getByRole("button", { name: "Helm 回滚" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByText("回滚 Helm Release")).toBeVisible();
  await expect(modal.getByText("流程阶段状态不会被重置")).toBeVisible();
  await modal.getByRole("button", { name: "取消" }).click();
  await expect(modal).toHaveCount(0);
  expect(rollbackPosts, "点了取消仍然发了回滚请求").toEqual([]);

  expectNoConsoleNoise(guard);
});

test("走完 6 个必经阶段并跳过回滚预案：离线包被解出并注入执行升级，流程落到成功", async ({ page, request }, testInfo) => {
  const reason = mockSkipReason(caps);
  if (reason) {
    announceSkip(testInfo, reason);
    test.skip(true, reason);
  }
  announceMode(testInfo, caps);
  test.setTimeout(300_000);

  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const name = flowNameOf("k8s-walk");
  const bundleName = `e2e-bundle-${runId}.tar.gz`;
  const flowId = await createFlowViaUi(page, name, "K8s / Helm 升级");
  created.flowIds.push(flowId);
  created.packageNames.push(bundleName);
  testInfo.annotations.push({ type: "flow", description: `${flowId} ${page.url()}` });

  // 阶段 1：两项必填填进去，侧栏那格就该变成已通过
  await selectStage(page, 0, K8S_STAGES);
  await fillK8sRegister(page);
  await runButton(page).click();
  await expect(railStage(page, 0, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });

  // 阶段 2 上传软件包：必须真传一个后端解得开的 bundle，并等解包步骤跑完
  await selectStage(page, 1, K8S_STAGES);
  await expect(page.getByRole("heading", { level: 3, name: "安装包上传" })).toBeVisible();
  await uploadBundlePackage(page, bundleName, K8S_TARGET.version);
  await runButton(page).click();
  await expect(railStage(page, 1, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });

  // 阶段 3~6：目录默认值就够跑 —— 模拟通路给的是带 [MOCK] 标记的合成成功，
  // 真实模式下这些步骤任一失败就会把阶段打红（StageExecutorK8sHonestyTest 钉住这条）。
  for (const i of [2, 3, 4, 5]) {
    await selectStage(page, i, K8S_STAGES);
    if (K8S_STAGES[i].key === "upgrade_execute") {
      // 只读的 chart 显示的是上一阶段注入的路径，不是前端自己填的（I3 + Task 9）
      const chartField = page.getByLabel(/^本次使用的 Chart/);
      await expect(chartField).toHaveAttribute("readonly");
      await expect(chartField).toHaveValue(re(`shipdesk-e2e-${K8S_TARGET.version}.tgz`));
    }
    await runButton(page).click();
    await expect(railStage(page, i, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });
  }

  // 阶段 7 是唯一的非必经阶段：解锁后给的是「跳过此阶段」，跳完直接算完成
  await selectStage(page, 6, K8S_STAGES);
  const skip = page.getByRole("button", { name: "跳过此阶段" });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect(railStage(page, 6, K8S_STAGES)).toContainText(STAGE_CN.skipped, { timeout: 60_000 });
  await expect(page.getByText(`阶段「${K8S_STAGES[6].title}」已跳过`)).toBeVisible();

  // 跳完不自动改选：面板仍停在第 7 阶段，流程头部则已经落到「成功」
  await expect(panelHeading(page, 6, K8S_STAGES)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: re(name) })).toContainText("成功");

  const flow = (await (await request.get(`/api/flows/${flowId}`)).json()) as {
    status: string; progress: { done: number; total: number };
    stages: { key: string; status: string; inputs: Record<string, unknown> }[];
  };
  expect(flow.status).toBe("succeeded");
  expect(flow.progress).toEqual({ done: 7, total: 7 });
  expect(flow.stages.map((s) => s.status))
    .toEqual(["passed", "passed", "passed", "passed", "passed", "passed", "skipped"]);
  // 表单提交真的进了后端 inputs（I3：草稿 + stage.inputs 合并后提交）
  expect(flow.stages[0].inputs.release_name).toBe(K8S_TARGET.release);
  expect(flow.stages[0].inputs.target_chart_version).toBe(K8S_TARGET.version);
  // 上传通路给的是服务端包 id，不是前端造的
  expect(flow.stages[1].inputs._package_id, "上传阶段该拿到服务端注入的包 id").toBeTruthy();
  // 解包结果跨阶段注入：chart 由服务端写进「执行升级」的 inputs（不是前端造的）
  const chart = String(flow.stages[4].inputs.chart ?? "");
  expect(chart, "执行升级阶段该有注入的 chart").toContain(`shipdesk-e2e-${K8S_TARGET.version}.tgz`);
  expect(String(flow.stages[4].inputs._chart_version)).toBe(K8S_TARGET.version);

  console.log(`[e2e][BACKEND] ${flowId} status=${flow.status} progress=${flow.progress.done}/${flow.progress.total} stages=${flow.stages.map((s) => s.status).join(",")}`);
  expectNoConsoleNoise(guard);
});

test("缺 chart 的离线包：上传阶段失败并把目录约定打在日志里", async ({ page }, testInfo) => {
  const reason = mockSkipReason(caps);
  if (reason) {
    announceSkip(testInfo, reason);
    test.skip(true, reason);
  }
  announceMode(testInfo, caps);

  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const name = flowNameOf("k8s-bad-bundle");
  const flowId = await createFlowViaUi(page, name, "K8s / Helm 升级");
  created.flowIds.push(flowId);
  created.packageNames.push(`e2e-bad-${runId}.tar.gz`);

  await selectStage(page, 0, K8S_STAGES);
  await fillK8sRegister(page);
  await runButton(page).click();
  await expect(railStage(page, 0, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });

  await selectStage(page, 1, K8S_STAGES);
  await uploadBundleWithoutChart(page, `e2e-bad-${runId}.tar.gz`);
  await runButton(page).click();
  await expect(railStage(page, 1, K8S_STAGES)).toContainText(STAGE_CN.failed, { timeout: 120_000 });
  // 契约提示来自服务端 BundleUnpacker 的原话，不是前端编的（同一段文字会出现在步骤行与控制台，故取 first）
  await expect(page.getByText(/chart\/<name>-<version>\.tgz/).first()).toBeVisible();

  expectNoConsoleNoise(guard);
});

test("模式目录与后端一致：对话框只给两种模式，非法 mode 被拒", async ({ page, request }) => {
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  await page.goto("/flows?new=1");
  const mode = page.getByRole("dialog").getByLabel(/^编排模式/);
  await expect(mode.locator("option")).toHaveCount(2);
  const values = await mode.locator("option").evaluateAll((os) => os.map((o) => o.getAttribute("value")));
  expect(values, "对话框的模式选项必须与后端目录的两个值一一对应").toEqual(["install", "upgrade_k8s"]);

  // 选到 upgrade_k8s 时 hint 说的是 7 阶段，环境提示也跟着改口（只有这一档可以留空）
  await mode.selectOption({ label: "K8s / Helm 升级" });
  await expect(page.getByRole("dialog")).toContainText("7 阶段 · 离线包驱动的 Helm 升级，含回滚预案");
  await expect(page.getByRole("dialog")).toContainText("阶段 1 登记 Helm Release，阶段 2 上传离线包，环境可留空");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();

  const bad = await request.post("/api/flows", {
    data: { name: `e2e-bad-mode-${runId}`, env_id: "", mode: "migrate" },
  });
  expect(bad.status(), "后端接受了目录之外的模式").toBe(400);
  expect(String((await bad.json()).detail)).toContain("mode 必须是");

  // 退役的原地升级模式不会因为旧记录而重新出现在目录里
  const legacy = await request.post("/api/flows", {
    data: { name: `e2e-bad-mode-${runId}-legacy`, env_id: "", mode: "upgrade" },
  });
  expect(legacy.status(), "后端仍接受已退役的 upgrade 模式").toBe(400);

  expectNoConsoleNoise(guard);
});
