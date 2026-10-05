import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  FLOW_SUCCEEDED_CN, runId, flowNameOf,
  announceMode, announceSkip, attachConsoleGuard, createFlowViaUi, deleteCreated,
  expectNoConsoleNoise, expectStageStatus, mockSkipReason, panelHeading, readCapabilities,
  runButton, selectStage, stubFavicon,
  type Capabilities, type Created, type StageRef,
} from "./fixtures";

/**
 * 原地升级（mode=upgrade，5 阶段）的浏览器级走查。
 *
 * 这一份用例存在的理由是一个真实的死锁：升级模式的 env_register 表单里没有节点表格，
 * 而后端曾按「本次提交了几台节点」校验并重建 env.nodes —— 第一步永远 422，
 * 万一放行又会把环境里已登记的矩阵清空（Workflow.validateStageInputs / ApiController.submitInputs）。
 * 所以除了「走到成功」，本用例还钉住两件事：环境矩阵一台不少，面板不给节点编辑器。
 *
 * 共享库纪律同 install-flow：只建只删自己带 e2e- 前缀的数据。
 */

const UPGRADE_STAGES: readonly StageRef[] = [
  { key: "env_register", title: "环境确认" },
  { key: "env_precheck", title: "环境校验" },
  { key: "pre_upgrade_backup", title: "升级前备份" },
  { key: "upgrade_execute", title: "执行升级" },
  { key: "post_verify", title: "升级后验证" },
] as const;

/** 环境的既有矩阵：升级模式确认的就是这一份。3 台 control（奇数）+ 1 台 worker。 */
const NODES = [
  { hostname: "up-ctrl-01", ip: "10.30.0.11", role: "control", machine_type: "physical", vendor: "Dell", model: "R750", idc: "AZ1" },
  { hostname: "up-ctrl-02", ip: "10.30.0.12", role: "control", machine_type: "physical", vendor: "Dell", model: "R750", idc: "AZ1" },
  { hostname: "up-ctrl-03", ip: "10.30.0.13", role: "control", machine_type: "physical", vendor: "Dell", model: "R750", idc: "AZ1" },
  { hostname: "up-work-01", ip: "10.30.0.21", role: "worker", machine_type: "virtual", host_platform: "KVM", vcpu: 8, memory_gb: 32, disk_gb: 200 },
] as const;

let caps: Capabilities = { effective_mode: "unknown", force_mock: false };
const created: Created = { flowIds: [], envIds: [], packageNames: [] };

test.beforeAll(async ({ request }) => {
  caps = await readCapabilities(request);

  const res = await request.get("/api/catalog/upgrade");
  expect(res.ok(), `GET /api/catalog/upgrade 返回 ${res.status()}`).toBe(true);
  const body = (await res.json()) as { stages: { key: string; title: string; form_fields: { key: string }[] }[] };
  expect(body.stages.map((s) => s.key), "升级阶段表与用例字面量不一致").toEqual(UPGRADE_STAGES.map((s) => s.key));
  expect(body.stages.map((s) => s.title), "升级阶段标题与用例字面量不一致").toEqual(UPGRADE_STAGES.map((s) => s.title));
  // 目录里就没有节点表格：这一步是「面板不该出现编辑器」的后端依据
  expect(body.stages[0].form_fields.map((f) => f.key)).toEqual(["target_version"]);
});

test.afterEach(async ({ request }) => {
  await deleteCreated(request, created);
});

/** 带既有矩阵的环境：升级模式确认的就是这一份。 */
async function createEnvWithNodes(request: APIRequestContext) {
  const res = await request.post("/api/environments", {
    data: { name: `e2e-env-${runId}`, description: "Playwright 升级用例自建环境", timezone: "Asia/Shanghai" },
  });
  expect(res.ok(), `POST /api/environments 返回 ${res.status()}: ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { id: string; name: string };
  const nodes = await request.post(`/api/environments/${body.id}/nodes`, { data: NODES });
  expect(nodes.ok(), `POST /api/environments/${body.id}/nodes 返回 ${nodes.status()}: ${await nodes.text()}`).toBe(true);
  created.envIds.push(body.id);
  return { id: body.id, name: body.name };
}

test("原地升级全流程：5 个阶段逐个通过，环境的节点矩阵一台不少", async ({ page, request }, testInfo) => {
  const reason = mockSkipReason(caps);
  if (reason) {
    announceSkip(testInfo, reason);
    test.skip(true, reason);
  }
  announceMode(testInfo, caps);
  test.setTimeout(300_000);

  const env = await createEnvWithNodes(request);
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  const flowName = flowNameOf("upgrade");
  const version = "v9.9.9-e2e";
  const flowId = await createFlowViaUi(page, { name: flowName, envId: env.id, envName: env.name, mode: "upgrade", stages: UPGRADE_STAGES });
  created.flowIds.push(flowId);
  console.log(`[e2e][FLOW] ${flowName} → ${flowId} · ${page.url()}`);
  testInfo.annotations.push({ type: "flow", description: `${flowId} ${page.url()}` });

  // I1：模式徽章只认后端给的值
  const badge = caps.force_mock ? "模拟模式（已强制模拟）" : "模拟模式";
  await expect(page.locator("header").getByText(badge, { exact: true })).toBeVisible();

  // 侧栏下方的只读矩阵：这就是升级目标，来自环境而不是本阶段表单
  await expect(page.getByText(`环境节点 · ${NODES.length} 台`)).toBeVisible();

  // 阶段 1 环境确认：没有节点编辑器，只有一个目标版本输入
  await selectStage(page, 0, UPGRADE_STAGES);
  await expect(panelHeading(page, 0, UPGRADE_STAGES)).toBeVisible();
  await expect(page.getByRole("group", { name: "物理机列表" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "虚拟机列表" })).toHaveCount(0);
  await page.getByLabel(/^目标版本/).fill(version);
  await runButton(page).click();
  await expectStageStatus(page, 0, "passed", UPGRADE_STAGES);

  // 环境矩阵没被这次提交改写（回归钉：submitInputs 曾无条件 env.nodes = built）
  const envAfterRegister = (await (await request.get(`/api/environments/${env.id}`)).json()) as { nodes: unknown[] };
  expect(envAfterRegister.nodes.length, "环境确认阶段改写了环境的节点矩阵").toBe(NODES.length);

  for (let i = 1; i < UPGRADE_STAGES.length; i++) {
    await selectStage(page, i, UPGRADE_STAGES);
    await runButton(page).click();
    await expectStageStatus(page, i, "passed", UPGRADE_STAGES);
  }

  await expect(page.getByRole("heading", { level: 2, name: new RegExp(flowName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }))
    .toContainText(FLOW_SUCCEEDED_CN);

  const flow = (await (await request.get(`/api/flows/${flowId}`)).json()) as {
    status: string; progress: { done: number; total: number };
    stages: { key: string; status: string; inputs: Record<string, unknown> }[];
  };
  expect(flow.status, `流程状态：${JSON.stringify(flow.stages.map((s) => s.status))}`).toBe("succeeded");
  expect(flow.progress).toEqual({ done: UPGRADE_STAGES.length, total: UPGRADE_STAGES.length });
  expect(flow.stages.map((s) => s.status)).toEqual(UPGRADE_STAGES.map(() => "passed"));
  expect(flow.stages[0].inputs.target_version, "目标版本没有落到 env_register 的 inputs").toBe(version);
  // 服务端写进环境的还是那 4 台
  const envFinal = (await (await request.get(`/api/environments/${env.id}`)).json()) as { nodes: unknown[] };
  expect(envFinal.nodes.length, "升级流程走完后台把环境矩阵改写了").toBe(NODES.length);
  console.log(
    `[e2e][BACKEND] ${flowId} status=${flow.status} stages=${flow.stages.map((s) => s.status).join(",")} `
    + `env.nodes=${envFinal.nodes.length}`,
  );

  expectNoConsoleNoise(guard);
});

test("原地升级没选环境：前端拦下，后端也不收（前端 toast + API 400）", async ({ page, request }, testInfo) => {
  // 这条只验门禁与提示，不驱动 mock 执行器，真实模式下同样成立，不做跳过。
  announceMode(testInfo, caps);

  const guard = attachConsoleGuard(page);
  await stubFavicon(page);

  await page.goto("/flows?new=1");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^流程名称/).fill(flowNameOf("upgrade-noenv"));
  await dialog.getByLabel(/^编排模式/).selectOption("upgrade");
  await expect(dialog.getByLabel(/^目标环境/)).toHaveValue("");
  // 提示要说清「为什么这一档也不能留空」
  await expect(dialog).toContainText("该环境里已登记的节点矩阵就是升级目标，阶段 1 只做确认与校验");

  await dialog.getByRole("button", { name: "创建并进入" }).click();
  await expect(page.getByText("原地升级必须选择已登记节点的环境")).toBeVisible();
  await expect(page.url()).toContain("/flows?new=1");
  await dialog.getByRole("button", { name: "取消" }).click();

  // 取消后重开必须是干净表单：对话框实例从不卸载，靠「由关到开重新播种」把上一轮的
  // name 与 upgrade 模式抹掉。否则残留的草稿会把下一次新建带进错误的编排模式。
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "新建流程" }).click();
  const reopened = page.getByRole("dialog");
  await expect(reopened.getByLabel(/^流程名称/)).toHaveValue("");
  await expect(reopened.getByLabel(/^编排模式/)).toHaveValue("install");

  // 绕过界面直接建也一样：没有环境的升级流程压根不该存在
  const bad = await request.post("/api/flows", {
    data: { name: flowNameOf("upgrade-noenv-api"), env_id: "", mode: "upgrade" },
  });
  expect(bad.status(), "后端接受了没有环境的原地升级").toBe(400);
  expect(String((await bad.json()).detail)).toContain("原地升级必须选择目标环境");

  expectNoConsoleNoise(guard);
});
