import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  attachConsoleGuard, deleteCreated, expectNoConsoleNoise, readCapabilities, runId, stubFavicon,
  type Created,
} from "./fixtures";

/**
 * Task 7.2：安装包上传的两条路径在真实后端前各走过一遍。
 *
 * 阈值与片长都取自代码而不是计划稿：`SINGLE_LIMIT = 64MB`、`CHUNK_SIZE = 8MB`
 * （useChunkedUpload.ts:9-17），服务端按客户端建议建会话（UploadService.java:50-53），
 * 所以大文件这一趟在浏览器里确实是 9 个分片请求，不是一个 multipart。
 * 与安装流程那套不同，这里不需要 mock 执行器：上传只碰包存储，真实模式下同样成立，
 * 故不设 mode 门禁 —— 门禁只用来把「没跑」和「跑绿了」分开，这里没有需要分开的东西。
 */

const MIB = 1024 * 1024;
/** 阈值之上、且不是 8 MB 的整数倍：末片取余，sliceRanges 的余数分支（useChunkedUpload.ts:26）才真被压到。 */
const BIG_BYTES = 64 * MIB + 8 * 1024;
const BIG_CHUNKS = 9;
const SMALL_BYTES = 4096;

const nameOf = (suffix: string) => `e2e-package-${runId}-${suffix}.tar.gz`;

/**
 * 64MB 的包走不了 `setInputFiles({ buffer })` —— Playwright 的通道上限是 50MB
 * （「Cannot set buffer larger than 50Mb」），只能落成临时文件按路径选进去。
 * 文件名就是包名：File.name 由路径的 basename 决定，UI 的「已选择：」与后端的登记名都靠它。
 */
const tmpDir = mkdtempSync(join(tmpdir(), "shipdesk-e2e-"));
const fileOf = (fileName: string, bytes: number, fill: string): string => {
  const p = join(tmpDir, fileName);
  writeFileSync(p, Buffer.alloc(bytes, fill));
  return p;
};

/** 请求计数按 URL 结尾分类；单请求路径的 /api/packages/upload 必须与 /upload/init 等区分开。 */
function trackUploadRequests(page: Page) {
  const seen = { single: 0, init: 0, chunk: 0, complete: 0, status: 0 };
  const posted = (u: string, path: string) => u.endsWith(path);
  page.on("request", (r) => {
    const u = r.url();
    if (r.method() === "POST" && posted(u, "/api/packages/upload")) seen.single += 1;
    else if (r.method() === "POST" && posted(u, "/api/packages/upload/init")) seen.init += 1;
    else if (r.method() === "POST" && posted(u, "/api/packages/upload/chunk")) seen.chunk += 1;
    else if (/\/api\/packages\/upload\/[^/]+\/complete$/.test(u) && r.method() === "POST") seen.complete += 1;
    else if (/\/api\/packages\/upload\/[^/]+$/.test(u) && r.method() === "GET") seen.status += 1;
  });
  return seen;
}

/** 从选文件到落进仓库：返回该包在 GET /api/packages 里的那一行（后端口径，不是 UI 文案）。 */
async function uploadThroughUi(page: Page, fileName: string, filePath: string, chunked: boolean) {
  await page.goto("/packages");
  const input = page.locator('input[type="file"]');
  await expect(input, "安装包页应有且只有一个文件输入").toHaveCount(1);
  await input.setInputFiles(filePath);
  await expect(page.getByText(`已选择：${fileName}`)).toBeVisible();

  const go = page.getByRole("button", { name: "开始上传" });
  await expect(go).toBeEnabled();

  const settled = chunked
    ? page.waitForResponse((r) => r.url().endsWith("/complete"), { timeout: 120_000 })
    : page.waitForResponse((r) => r.url().endsWith("/api/packages/upload"), { timeout: 120_000 });
  await go.click();
  const res = await settled;
  expect(res.ok(), `${fileName} 的收尾请求返回 HTTP ${res.status()}`).toBe(true);

  await expect(page.getByText(`「${fileName}」上传完成`)).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: fileName });
  await expect(row).toBeVisible();
  await expect(row).toContainText("完整");
  return row;
}

async function readPackageRow(request: APIRequestContext, fileName: string) {
  const res = await request.get("/api/packages");
  expect(res.ok(), `GET /api/packages 返回 ${res.status()}`).toBe(true);
  const rows = (await res.json()) as {
    id: string; name: string; size_bytes: number; uploaded_bytes: number;
    checksum: string; upload_complete: boolean;
  }[];
  const hits = rows.filter((p) => p.name === fileName);
  expect(hits, `后端仓库里没有「${fileName}」`).toHaveLength(1);
  return hits[0]!;
}

const created: Created = { flowIds: [], envIds: [], packageNames: [] };

test.beforeAll(async ({ request }) => {
  const caps = await readCapabilities(request);
  console.log(`[e2e][MODE] effective_mode=${caps.effective_mode} force_mock=${caps.force_mock}`);
});

test.afterEach(async ({ request }) => {
  await deleteCreated(request, created);
});

test.afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("阈值以下走单请求：一个 multipart，一次分片请求都不发", async ({ page, request }) => {
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);
  const seen = trackUploadRequests(page);
  const fileName = nameOf("single");
  created.packageNames.push(fileName);

  await uploadThroughUi(page, fileName, fileOf(fileName, SMALL_BYTES, "shipdesk-e2e"), false);

  expect(seen, "64MB 以下不该碰分片协议的任何一步").toMatchObject({ single: 1, init: 0, chunk: 0, complete: 0 });

  const row = await readPackageRow(request, fileName);
  expect(row.size_bytes).toBe(SMALL_BYTES);
  expect(row.upload_complete, "单请求路径注册就该是完整包").toBe(true);
  expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  expectNoConsoleNoise(guard);
});

test("阈值以上走分片续传：浏览器里确实是 1 次 init + 9 片 + 1 次 complete", async ({ page, request }) => {
  test.setTimeout(240_000);
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);
  const seen = trackUploadRequests(page);
  const fileName = nameOf("chunked");
  created.packageNames.push(fileName);

  const row = await uploadThroughUi(page, fileName, fileOf(fileName, BIG_BYTES, "shipdesk-e2e-chunked"), true);
  await expect(row).toBeVisible();

  expect(seen, "分片路径的请求数与阈值/片长（64MB / 8MB）必须一致")
    .toMatchObject({ single: 0, init: 1, chunk: BIG_CHUNKS, complete: 1 });

  const pkg = await readPackageRow(request, fileName);
  expect(pkg.size_bytes, "合并后的字节数不是声明的总数，说明有片没落进去").toBe(BIG_BYTES);
  expect(pkg.uploaded_bytes).toBe(BIG_BYTES);
  expect(pkg.upload_complete).toBe(true);
  expect(pkg.checksum).toMatch(/^[0-9a-f]{64}$/);
  expectNoConsoleNoise(guard);
});

test("分片进行中给的是可取消与会话记录：单请求路径两样都不该有", async ({ page }) => {
  test.setTimeout(240_000);
  const guard = attachConsoleGuard(page);
  await stubFavicon(page);
  const fileName = nameOf("resumable");
  created.packageNames.push(fileName);

  await page.goto("/packages");
  await page.locator('input[type="file"]').setInputFiles(fileOf(fileName, BIG_BYTES, "shipdesk-e2e-resume"));

  const initDone = page.waitForResponse((r) => r.url().endsWith("/upload/init"));
  await page.getByRole("button", { name: "开始上传" }).click();
  const init = (await (await initDone).json()) as { upload_id: string; chunk_size: number; total_chunks: number };
  expect(init.chunk_size, "服务端建议的片长不是 8MB，客户端进度分母就会错").toBe(8 * MIB);
  expect(init.total_chunks).toBe(BIG_CHUNKS);

  // 进度条说「分片 x/9」而不是百分比猜：这一句只存在于分片路径（UploadZone.tsx:94-97）
  await expect(page.getByText(new RegExp(`分片 \\d+/${BIG_CHUNKS}`))).toBeVisible();
  // cancellable 只由分片路径点亮（useChunkedUpload.ts:213），按钮在才是真能取消
  await expect(page.getByRole("button", { name: "取消上传" })).toBeVisible();

  // 会话 id 记进 localStorage 才有下一次续传（键含文件名|字节数|修改时间）
  const stored = await page.evaluate((key) => {
    const hits = Object.keys(localStorage).filter((k) => k.startsWith("shipdesk.upload.") && localStorage.getItem(k)?.includes(key));
    return hits.length;
  }, init.upload_id);
  expect(stored, "upload_id 没有落进 localStorage，重传同名文件时无从续传").toBe(1);

  // 让它跑完，complete 成功后会话记录该被清掉
  await page.waitForResponse((r) => r.url().endsWith("/complete"), { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "开始上传" })).toBeVisible();
  const left = await page.evaluate((key) =>
    Object.keys(localStorage).filter((k) => k.startsWith("shipdesk.upload.") && localStorage.getItem(k)?.includes(key)).length,
  init.upload_id);
  expect(left, "会话还在 localStorage 里，下次重传会去续一个已经完成的包").toBe(0);
  expectNoConsoleNoise(guard);
});

test("服务端会话撑得住续传：已到片可查、重复片不重复计字节、认不出的 id 一律非 2xx", async ({ request }) => {
  const fileName = nameOf("resume-api");
  created.packageNames.push(fileName);
  const chunk = Buffer.alloc(MIB, "shipdesk-e2e-part");
  const total = 3 * MIB;

  const initRes = await request.post("/api/packages/upload/init", {
    data: { name: fileName, version: "", kind: "bundle", size_bytes: total, chunk_size: MIB, flow_id: "" },
  });
  expect(initRes.ok(), `init 返回 ${initRes.status()}`).toBe(true);
  const init = (await initRes.json()) as { upload_id: string; chunk_size: number; total_chunks: number };
  // 片长以服务端回的值为准（客户端会采纳它），这里按建议值继续，协议谈不拢就直接失败
  expect(init.chunk_size).toBe(MIB);
  expect(init.total_chunks).toBe(3);
  const id = init.upload_id;

  const send = async (index: number) => {
    const r = await request.post("/api/packages/upload/chunk", {
      multipart: {
        upload_id: id,
        chunk_index: String(index),
        file: { name: `${fileName}.part${index}`, mimeType: "application/octet-stream", buffer: chunk },
      },
    });
    expect(r.ok(), `第 ${index} 片返回 ${r.status()}`).toBe(true);
    return r.json() as Promise<{ received_bytes: number; progress: number }>;
  };

  await send(0);
  await send(1);

  const st = (await (await request.get(`/api/packages/upload/${id}`)).json()) as {
    uploaded_bytes: number; done_chunks: number[]; progress: number; complete: boolean;
  };
  expect([...st.done_chunks].sort()).toEqual([0, 1]);
  expect(st.uploaded_bytes).toBe(2 * MIB);
  expect(st.complete).toBe(false);

  // 幂等：续传时把已到的一片重发，字节数不能二次累加（UploadService.java:93-96）
  await send(1);
  const again = (await (await request.get(`/api/packages/upload/${id}`)).json()) as { uploaded_bytes: number; done_chunks: number[] };
  expect([...again.done_chunks].sort(), "重复片的下标在 done 集合里多出一份").toEqual([0, 1]);
  expect(again.uploaded_bytes, "重复片被当成新数据计进了已上传总量").toBe(2 * MIB);

  await send(2);
  const done = await request.post(`/api/packages/upload/${id}/complete`, { data: {} });
  expect(done.ok(), `complete 返回 ${done.status()}: ${await done.text()}`).toBe(true);

  const pkg = await readPackageRow(request, fileName);
  expect(pkg.size_bytes).toBe(total);
  expect(pkg.upload_complete).toBe(true);

  // 认不出的会话：服务端抛异常（不是 404），客户端据此作废本地记录 —— 断言的只是「非 2xx」这一层契约
  const ghost = await request.get(`/api/packages/upload/${id}deadbeef`);
  expect(ghost.status(), `未知 upload_id 返回 ${ghost.status()}，客户端无法按「会话没了」处理`).toBeGreaterThanOrEqual(400);
});
