import { expect, test, type Page } from "@playwright/test";
import {
  STAGE_CN, attachConsoleGuard, announceMode, announceSkip, deleteCreated, expectNoConsoleNoise,
  flowNameOf, mockSkipReason, panelHeading, railStage, readCapabilities, runButton, runId,
  selectStage, stubFavicon, type Capabilities, type Created, type StageRef,
} from "./fixtures";

/**
 * Task 7.2：upgrade_k8s 模式在浏览器里走通 —— 门禁、表单、可跳过阶段与回滚入口。
 *
 * 阶段表与字段标签都取自运行中的后端（`GET /api/catalog/upgrade_k8s`），beforeAll 先逐字对齐，
 * 不一致就直接失败而不是让用例去断言一份后端已经不发下来的 UI。
 * 「走完 5 个阶段 + 跳过回滚预案」这条路是实测过的：本环境没有 helm/kubectl，
 * 服务端对 `k8s.discover` 一类步骤「记录但不阻断」（StageExecutor.java:1460-1467），
 * 因此流程能落到 succeeded —— 真实集群下的 helm 动作不在本用例的验证范围内。
 */

const K8S_STAGES: StageRef[] = [
  { key: "env_register", title: "环境登记" },
  { key: "env_precheck", title: "环境校验" },
  { key: "pre_upgrade_backup", title: "升级前备份" },
  { key: "upgrade_execute", title: "执行升级" },
  { key: "post_verify", title: "升级后验证" },
  { key: "rollback_plan", title: "回滚预案" },
];

/** 阶段 1 的必填项：目录里 required=true 的四项（命名空间有默认值，不用填）。 */
const K8S_TARGET = {
  clusterId: `e2e-cluster-${runId}`,
  release: "shipdesk-e2e",
  chart: "shipdesk/shipdesk",
  version: "1.2.3-e2e",
};

/** 自建数据名里只有字母数字与点横线，进正则前仍按字面量收口。 */
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

let caps: Capabilities = { effective_mode: "unknown", force_mock: false };
const created: Created = { flowIds: [], envIds: [], packageNames: [] };

/** 新建流程对话框：升级类模式允许环境留空（NewFlowDialog.tsx:35 只对 install 拦）。 */
async function createFlowViaUi(page: Page, name: string, modeLabel: string): Promise<string> {
  await page.goto("/flows?new=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "新建流程" })).toBeVisible();
  await dialog.getByLabel(/^流程名称/).fill(name);
  await dialog.getByLabel(/^编排模式/).selectOption({ label: modeLabel });
  // 环境留空：升级类流程的目标环境在环境登记阶段才落定（NewFlowDialog.tsx:35 的拦截只对 install）
  await expect(dialog.getByLabel(/^目标环境/)).toHaveValue("");
  await dialog.getByRole("button", { name: "创建并进入" }).click();
  await page.waitForURL(/\/flows\/[^/?#]+$/);
  const id = /\/flows\/([^/?#]+)$/.exec(page.url())?.[1] ?? "";
  if (!id) throw new Error(`创建流程后没有拿到流程 id，当前 URL：${page.url()}`);
  return id;
}

async function fillK8sRegister(page: Page): Promise<void> {
  await page.getByLabel(/^K8s 集群 ID/).fill(K8S_TARGET.clusterId);
  await page.getByLabel(/^Helm Release 名称/).fill(K8S_TARGET.release);
  await page.getByLabel(/^Chart 名称/).fill(K8S_TARGET.chart);
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
  expect(body.stages.map((s) => s.required)).toEqual([true, true, true, true, true, false]);
});

test.afterEach(async ({ request }) => {
  await deleteCreated(request, created);
});

test("向导骨架：6 阶段与必经/可跳过标注、K8s 专有表单、回滚入口、没有上传区", async ({ page }, testInfo) => {
  announceMode(testInfo, caps);
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const name = flowNameOf("k8s-shell");
  const flowId = await createFlowViaUi(page, name, "K8s / Helm 升级");
  created.flowIds.push(flowId);

  // 头部按 modeLabel 与目录长度说话：模式与「6 阶段」都来自后端给的 mode/stages，不是前端猜的
  await expect(page.getByRole("heading", { level: 2, name: re(name) })).toBeVisible();
  await expect(page.getByText(/K8s \/ Helm 升级 · 环境 — · 6 阶段/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^7\. / })).toHaveCount(0);

  for (let i = 0; i < K8S_STAGES.length; i++) {
    const btn = railStage(page, i, K8S_STAGES);
    await expect(btn, `阶段「${K8S_STAGES[i].title}」应标注 ${i === 5 ? "可跳过" : "必经"}`)
      .toContainText(i === 5 ? "· 可跳过" : "· 必经");
  }

  // I2：新建流程只有阶段 1 解锁，其余 5 个由后端 status 决定为不可点
  await expect(railStage(page, 0, K8S_STAGES)).toBeEnabled();
  await expect(railStage(page, 0, K8S_STAGES)).toContainText(STAGE_CN.ready);
  for (let i = 1; i < K8S_STAGES.length; i++) {
    await expect(railStage(page, i, K8S_STAGES), `阶段「${K8S_STAGES[i].title}」不该可点`).toBeDisabled();
    await expect(railStage(page, i, K8S_STAGES)).toContainText(STAGE_CN.locked);
  }

  // 目录里的 K8s 专有字段必须真的渲染出来（升级模式没有 package_upload，安装专有项也不该出现）
  await selectStage(page, 0, K8S_STAGES);
  for (const label of ["K8s 集群 ID", "kubeconfig 路径/内容", "命名空间", "Helm Release 名称", "Chart 名称/路径", "目标 Chart 版本", "Chart 仓库地址"]) {
    await expect(page.getByLabel(new RegExp(`^${label}`)), `表单缺少目录字段「${label}」`).toBeVisible();
  }
  await expect(page.getByText("安装包上传")).toHaveCount(0);
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

test("走完 5 个阶段并跳过回滚预案：流程落到成功，控制台不留残留错误", async ({ page, request }, testInfo) => {
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
  const flowId = await createFlowViaUi(page, name, "K8s / Helm 升级");
  created.flowIds.push(flowId);
  testInfo.annotations.push({ type: "flow", description: `${flowId} ${page.url()}` });

  // 阶段 1：四个必填项填进去，面板标题里那格就该变成已通过
  await selectStage(page, 0, K8S_STAGES);
  await fillK8sRegister(page);
  await runButton(page).click();
  await expect(railStage(page, 0, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });

  // 阶段 2~5：目录默认值就够跑（本环境没有 helm/kubectl，服务端对这些步骤「记录但不阻断」）
  for (const i of [1, 2, 3, 4]) {
    await selectStage(page, i, K8S_STAGES);
    await runButton(page).click();
    await expect(railStage(page, i, K8S_STAGES)).toContainText(STAGE_CN.passed, { timeout: 120_000 });
  }

  // 阶段 6 是唯一的非必经阶段：解锁后给的是「跳过此阶段」，跳完直接算完成
  await selectStage(page, 5, K8S_STAGES);
  const skip = page.getByRole("button", { name: "跳过此阶段" });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect(railStage(page, 5, K8S_STAGES)).toContainText(STAGE_CN.skipped, { timeout: 60_000 });
  await expect(page.getByText(`阶段「${K8S_STAGES[5].title}」已跳过`)).toBeVisible();

  // 跳完不自动改选：面板仍停在第 6 阶段，流程头部则已经落到「成功」
  await expect(panelHeading(page, 5, K8S_STAGES)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: re(name) })).toContainText("成功");

  const flow = (await (await request.get(`/api/flows/${flowId}`)).json()) as {
    status: string; progress: { done: number; total: number };
    stages: { key: string; status: string; inputs: Record<string, unknown> }[];
  };
  expect(flow.status).toBe("succeeded");
  expect(flow.progress).toEqual({ done: 6, total: 6 });
  expect(flow.stages.map((s) => s.status))
    .toEqual(["passed", "passed", "passed", "passed", "passed", "skipped"]);
  // 表单提交真的进了后端 inputs（I3：草稿 + stage.inputs 合并后提交）
  expect(flow.stages[0].inputs.release_name).toBe(K8S_TARGET.release);
  expect(flow.stages[0].inputs.target_chart_version).toBe(K8S_TARGET.version);
  // 阶段 1 的 release_name 是回滚按钮取名的来源（FlowWizard.tsx:51）
  expect(String(flow.stages[0].inputs.cluster_id)).toBe(K8S_TARGET.clusterId);

  console.log(`[e2e][BACKEND] ${flowId} status=${flow.status} progress=${flow.progress.done}/${flow.progress.total} stages=${flow.stages.map((s) => s.status).join(",")}`);
  expectNoConsoleNoise(guard);
});

test("模式目录与后端一致：对话框只给三种模式，非法 mode 被拒", async ({ page, request }) => {
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  await page.goto("/flows?new=1");
  const mode = page.getByRole("dialog").getByLabel(/^编排模式/);
  await expect(mode.locator("option")).toHaveCount(3);
  const values = await mode.locator("option").evaluateAll((os) => os.map((o) => o.getAttribute("value")));
  expect(values, "对话框的模式选项必须与后端目录的三个值一一对应").toEqual(["install", "upgrade", "upgrade_k8s"]);

  // 选到 upgrade_k8s 时 hint 说的是 6 阶段，与环境无关的「可留空」也该跟着变
  await mode.selectOption({ label: "K8s / Helm 升级" });
  await expect(page.getByRole("dialog")).toContainText("6 阶段 · Helm release 升级，含回滚预案");
  await expect(page.getByRole("dialog")).toContainText("升级类流程的目标环境在环境登记阶段落定，可留空");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();

  const bad = await request.post("/api/flows", {
    data: { name: `e2e-bad-mode-${runId}`, env_id: "", mode: "migrate" },
  });
  expect(bad.status(), "后端接受了目录之外的模式").toBe(400);
  expect(String((await bad.json()).detail)).toContain("mode 必须是");

  expectNoConsoleNoise(guard);
});
