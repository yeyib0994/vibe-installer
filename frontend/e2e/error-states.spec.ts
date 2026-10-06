import { expect, test, type Route } from "@playwright/test";
import { runId, stubFavicon } from "./fixtures";

/**
 * 列表接口挂掉时（nginx 断链、后端没起、503）每张列表页都必须端出「加载失败 + 重试」，
 * 而不是空态，也不能永远停在「加载…」。这条纪律单测里是靠 stub 造响应，
 * 真浏览器 + 真 nginx + 真后端的链路只有这里覆盖得到，所以在此用 route.fulfill 掐掉指定接口。
 *
 * 刻意不调用 fixtures 里的 expectNoConsoleNoise：请求是我们自己掐断的，
 * 控制台里那条 503 记录属于被测行为本身，安装流程那套「零噪声」守卫不适用于本 spec。
 */

const DETAIL = "e2e：故意让这一页读取失败";

const fail = (route: Route) =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ detail: DETAIL }),
  });

interface Case {
  path: string;
  /** 被掐掉的接口 pathname：列表页唯一的读请求（用谓词而不是 glob，免得 ? 与 / 的通配语义坏事）。 */
  api: string;
  /** QueryError 的 label（各页各一张表）。 */
  label: string;
  /** 只有「确实读到空」才该出现的空态文案，用正则截取（页面上是完整句）。 */
  emptyText: RegExp;
  /** 加载占位文案：失败后不能停在这里。 */
  loadingText: RegExp;
}

const CASES: Case[] = [
  { path: "/", api: "/api/overview", label: "加载总览失败", emptyText: /还没有流程/, loadingText: /加载总览…/ },
  { path: "/envs", api: "/api/environments", label: "加载环境失败", emptyText: /暂无环境/, loadingText: /加载环境…/ },
  { path: "/flows", api: "/api/flows", label: "加载流程失败", emptyText: /还没有流程/, loadingText: /加载流程…/ },
  { path: "/packages", api: "/api/packages", label: "加载安装包失败", emptyText: /仓库为空/, loadingText: /加载安装包…/ },
  { path: "/backups", api: "/api/backups", label: "加载备份点失败", emptyText: /自动生成备份点/, loadingText: /加载备份点…/ },
];

/** 精确匹配 pathname 的路由谓词：同一份引用交给 route/unroute，撤除时才犯不到别的 handler。 */
const hit = (pathname: string) => (url: URL) => url.pathname === pathname;

for (const c of CASES) {
  test(`${c.path} 读取失败：显示后端消息与重试，不伪装成空态`, async ({ page }) => {
    await stubFavicon(page);
    await page.route(hit(c.api), fail);
    await page.goto(c.path);

    const banner = page.getByText(`${c.label}：${DETAIL}`);
    await expect(banner, "失败必须带着后端原话显示出来").toBeVisible();
    await expect(page.getByText(c.emptyText), "查询失败不能伪装成「没有数据」").toHaveCount(0);
    await expect(page.getByText(c.loadingText), "失败不能伪装成「还在加载」").toHaveCount(0);

    // 放开接口后点重试：错误行必须真的消失（读到数据或读到空，都由后端说了算）
    await page.unroute(hit(c.api), fail);
    await page.getByRole("button", { name: "重试" }).click();
    await expect(banner).toHaveCount(0);
  });
}

test("/backups 环境清单失败：表格给出错误行，限定受影响范围", async ({ page }) => {
  await stubFavicon(page);
  // 备份点本身读得到，只掐环境清单——这才是「恢复目标解析不了」的真实形态
  await page.route(hit("/api/environments"), fail);
  await page.goto("/backups");

  const banner = page.getByText(/环境清单加载失败，恢复目标将无法解析/);
  await expect(banner, "环境清单失败要在表格里说清楚，并限定受影响范围").toBeVisible();
  await expect(banner).toContainText(DETAIL);
});

test("/flows/{id} 阶段历史日志读取失败：控制台给后端原话与重试，不端空态也不停在读取中", async ({ page, request }) => {
  await stubFavicon(page);
  // upgrade_k8s 允许不选环境（后端只在 install/upgrade 拦空环境），新建流程的第一阶段是 ready 的 env_register：
  // 面板此时非 running，日志的唯一来源是 GET /logs 历史，掐掉它才测到本用例要测的那条读取路径。
  const created = await request.post("/api/flows", {
    data: { name: `e2e-errstate-${runId}`, env_id: "", mode: "upgrade_k8s" },
  });
  expect(created.status(), `POST /api/flows 返回 ${created.status()}: ${await created.text()}`).toBe(200);
  const flowId = String((await created.json()).id);
  const logsPath = `/api/flows/${flowId}/stages/env_register/logs`;

  try {
    await page.route(hit(logsPath), fail);
    await page.goto(`/flows/${flowId}`);

    const banner = page.getByText(`读取本阶段历史日志失败：${DETAIL}`);
    await expect(banner, "阶段历史日志失败必须带后端原话显示出来").toBeVisible();
    await expect(page.getByText(/等待执行输出/), "查询失败不能伪装成空控制台").toHaveCount(0);
    await expect(page.getByText(/正在读取本阶段的历史日志/), "失败不能伪装成「还在读取」").toHaveCount(0);

    await page.unroute(hit(logsPath), fail);
    await page.getByRole("button", { name: "重试" }).click();
    await expect(banner, "重试成功后错误行必须真的消失").toHaveCount(0);
  } finally {
    // 自建自删：错误态用例同样受共享库纪律约束，只带走自己带 e2e- 前缀的那一条流程。
    const del = await request.delete(`/api/flows/${flowId}`);
    if (!del.ok()) console.log(`[e2e][CLEANUP] 流程 ${flowId} 删除失败：HTTP ${del.status()}`);
  }
});
