import { expect, test } from "@playwright/test";
import {
  STAGES, STAGE_CN, FLOW_SUCCEEDED_CN, runId, flowNameOf, packageNameOf,
  attachConsoleGuard, announceMode, announceSkip, createFlowViaUi, expectNoConsoleNoise,
  expectStageStatus, fillDemoNodes, mockSkipReason, panelHeading, railStage, readCapabilities,
  runButton, selectStage, stubFavicon, walkStages,
  type Capabilities, type Created,
} from "./fixtures";

/**
 * Task 7.1：ShipDesk Console 的第一份浏览器级 E2E。
 * 跑在已运行的 Vite dev server（baseURL，见 playwright.config.ts）+ 已运行的 Java 后端之上，
 * 前端把 /api 代理到 127.0.0.1:8848（vite.config.ts:8-12）。
 *
 * 共享库纪律：环境、流程、安装包全部以 e2e- 前缀命名（runId 唯一），afterEach 只删自己建的那些。
 * 环境专门自建而不是复用 sse-env：「环境登记」阶段会把节点矩阵写进所选环境，
 * 借用别人的环境就是改别人的数据。
 */

let caps: Capabilities = { effective_mode: "unknown", force_mock: false };
let env = { id: "", name: "" };
const created: Created = { flowIds: [], envIds: [], packageNames: [] };

test.beforeAll(async ({ request }) => {
  caps = await readCapabilities(request);

  // 夹具里写死的 7 个中文阶段名来自后端目录，不是计划里的猜测：先与运行中的后端逐字对齐，
  // 不一致就直接失败，避免整套用例在断言一个后端根本不给的 UI。
  const res = await request.get("/api/catalog/install");
  expect(res.ok(), `GET /api/catalog/install 返回 ${res.status()}`).toBe(true);
  const body = (await res.json()) as { stages: { key: string; title: string }[] };
  expect(body.stages.map((s) => s.key)).toEqual(STAGES.map((s) => s.key));
  expect(body.stages.map((s) => s.title)).toEqual(STAGES.map((s) => s.title));
});

test.beforeEach(async ({ request }) => {
  env = { id: "", name: "" };
  const res = await request.post("/api/environments", {
    data: {
      name: `e2e-env-${runId}`,
      description: "Playwright Task 7.1 自建环境",
      base_domain: `e2e-${runId}.internal`,
      ntp_server: "ntp.e2e.internal",
      timezone: "Asia/Shanghai",
      dns_servers: ["10.0.0.53"],
    },
  });
  expect(res.ok(), `POST /api/environments 返回 ${res.status()}: ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { id: string; name: string };
  env = { id: body.id, name: body.name };
  created.envIds.push(body.id);
  expect(env.id, "后端没有回来自建环境的 id").toBeTruthy();
});

test.afterEach(async ({ request }) => {
  // 先删流程（它引用环境与包），再删包，最后删环境。只动 e2e- 前缀且本次记下的行。
  for (const id of created.flowIds.splice(0)) {
    const r = await request.delete(`/api/flows/${id}`);
    if (!r.ok()) console.log(`[e2e][CLEANUP] 流程 ${id} 删除失败：HTTP ${r.status()}`);
  }
  for (const name of created.packageNames.splice(0)) {
    const res = await request.get("/api/packages");
    if (!res.ok()) continue;
    const pkgs = (await res.json()) as { id: string; name: string }[];
    for (const p of pkgs.filter((x) => x.name === name)) {
      const r = await request.delete(`/api/packages/${p.id}`);
      if (!r.ok()) console.log(`[e2e][CLEANUP] 安装包 ${p.id} 删除失败：HTTP ${r.status()}`);
    }
  }
  for (const id of created.envIds.splice(0)) {
    const r = await request.delete(`/api/environments/${id}`);
    if (!r.ok()) console.log(`[e2e][CLEANUP] 环境 ${id} 删除失败：HTTP ${r.status()}`);
  }
});

test("安装全流程：7 个阶段逐个通过，流程走到成功，控制台不留残留错误", async ({ page, request }, testInfo) => {
  const reason = mockSkipReason(caps);
  if (reason) {
    announceSkip(testInfo, reason);
    test.skip(true, reason);
  }
  announceMode(testInfo, caps);
  // 7 个阶段串行走完远超配置的 120s 默认值；按用例抬高，不改全局 timeout（本地实测 18s，留足余量）。
  test.setTimeout(300_000);

  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const flowName = flowNameOf("full");
  const packageName = packageNameOf();
  const baseDomain = `e2e-${runId}.test`;
  const version = "v9.9.9-e2e";

  const flowId = await createFlowViaUi(page, { name: flowName, envId: env.id, envName: env.name });
  created.flowIds.push(flowId);
  created.packageNames.push(packageName);
  console.log(`[e2e][FLOW] ${flowName} → ${flowId} · ${page.url()}`);
  testInfo.annotations.push({ type: "flow", description: `${flowId} ${page.url()}` });

  // I1：徽章只认后端 effective_mode / force_mock，这里按后端给的值断言 UI 的字。
  const badge = caps.force_mock ? "模拟模式（已强制模拟）" : "模拟模式";
  await expect(page.locator("header").getByText(badge, { exact: true })).toBeVisible();

  await walkStages(page, { packageName, baseDomain, version });

  for (let i = 0; i < STAGES.length; i++) {
    await expectStageStatus(page, i, "passed");
  }
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(flowName) }))
    .toContainText(FLOW_SUCCEEDED_CN);

  // 后端自己的口径：状态、进度、以及「UI 里敲进去的字确实进了 inputs」。
  const res = await request.get(`/api/flows/${flowId}`);
  expect(res.ok(), `GET /api/flows/${flowId} 返回 ${res.status()}`).toBe(true);
  const flow = (await res.json()) as {
    status: string; progress: { done: number; total: number };
    stages: { key: string; status: string; inputs: Record<string, unknown> }[];
  };
  expect(flow.status, `流程状态：${JSON.stringify(flow.stages.map((s) => s.status))}`).toBe("succeeded");
  expect(flow.progress).toEqual({ done: 7, total: 7 });
  expect(flow.stages.map((s) => s.status)).toEqual(STAGES.map(() => "passed"));
  expect(flow.stages[0].inputs.base_domain).toBe(baseDomain);
  expect(flow.stages[2].inputs.package_version).toBe(version);
  expect(String(flow.stages[2].inputs._package_id ?? ""), "上传阶段没有把包挂到流程上").not.toBe("");
  console.log(
    `[e2e][BACKEND] ${flowId} status=${flow.status} progress=${flow.progress.done}/${flow.progress.total} `
    + `stages=${flow.stages.map((s) => s.status).join(",")}`,
  );

  // I4：EventSource 只应由 {type:"close"} 关闭 —— 走完 7 个阶段不该留下任何请求失败/控制台错误。
  //
  // 已知缺陷（本断言当前会失败，属应用侧而非选择器侧，勿放宽）：
  // 阶段终态一进入轮询到的 flow，StagePanel 的 running（StagePanel.tsx:35）立即变 false，
  // useStageStream 的 effect 清理就 es.close()（useStageStream.ts:150-153）；而服务端的 close 帧
  // 要等轮询线程下一个 300ms tick 才发出（ApiController.java:431-448：sleep(300) → 发 close → complete）。localhost 上
  // 「stage_done → 失效 flow 查询 → 重新渲染」几乎总是赢，于是每条流都以客户端 abort 收场。
  // 实测：一次跑 3~7 条 `GET /api/flows/{id}/stages/{key}/stream → net::ERR_ABORTED`，
  // 且与控制台无关（console 侧恒为 0 条）；dev 代理不背这个锅——同一阶段经 5174 代理与直连 8848
  // 拿到 close 的延迟分别是 305ms / 309ms。
  expectNoConsoleNoise(guard);
});

test("门禁回归：locked 阶段不可进入也不可执行（I2）", async ({ page }, testInfo) => {
  const reason = mockSkipReason(caps);
  if (reason) {
    announceSkip(testInfo, reason);
    test.skip(true, reason);
  }
  announceMode(testInfo, caps);
  test.setTimeout(240_000);

  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const flowName = flowNameOf("gate");
  const flowId = await createFlowViaUi(page, { name: flowName, envId: env.id, envName: env.name });
  created.flowIds.push(flowId);
  console.log(`[e2e][FLOW] ${flowName} → ${flowId} · ${page.url()}`);
  testInfo.annotations.push({ type: "flow", description: `${flowId} ${page.url()}` });

  // 新建流程：只有阶段 1 是待执行，其余 6 个都由后端标为 locked 并渲染成禁用按钮。
  await expect(railStage(page, 0)).toBeEnabled();
  await expect(railStage(page, 0)).toContainText(STAGE_CN.ready);
  for (let i = 1; i < STAGES.length; i++) {
    const btn = railStage(page, i);
    await expect(btn, `阶段「${STAGES[i].title}」的 rail 按钮不该可点（后端 status=locked）`).toBeDisabled();
    await expect(btn).toContainText(STAGE_CN.locked);
    // 诚实的禁用理由：StageRail.tsx:38 的 title 文案
    await expect(btn).toHaveAttribute("title", "该阶段尚未解锁，需先完成前置阶段");
  }

  // 硬点第 3 阶段（上传安装包）：面板必须仍停在第 1 阶段，不给任何执行入口。
  await railStage(page, 2).click({ force: true });
  await expect(panelHeading(page, 0)).toBeVisible();
  await expect(panelHeading(page, 2)).toHaveCount(0);

  // 走完阶段 1，门禁只放开一格。
  await selectStage(page, 0);
  await page.getByLabel(/^基础域名/).fill(`e2e-${runId}.test`);
  await fillDemoNodes(page);
  await runButton(page).click();
  await expect(railStage(page, 0)).toContainText(STAGE_CN.passed);

  await expect(railStage(page, 1)).toBeEnabled();
  await expect(railStage(page, 1)).toContainText(STAGE_CN.ready);
  await expect(railStage(page, 2)).toBeDisabled();
  await expect(railStage(page, 2)).toContainText(STAGE_CN.locked);
  await expect(panelHeading(page, 2)).toHaveCount(0);

  expectNoConsoleNoise(guard);
});
