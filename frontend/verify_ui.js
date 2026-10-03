/* 前端端到端验证：真浏览器点击走完 7 个阶段，收集 console 报错。
 * 用 puppeteer-core + 本机 Chrome。默认模拟模式（CLOUDOPS_FORCE_MOCK=1）。 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const CHROME = "C:\\Users\\yyb\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe";
const URL = "http://127.0.0.1:8848/";
const OUT = process.argv[2] || "C:\\Users\\yyb\\AppData\\Local\\Temp\\cloudops-shots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1560, height: 1180 },
  });
  const page = await browser.newPage();
  const errors = [], warns = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    else if (m.type() === "warning") warns.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("requestfailed", (r) =>
    errors.push("REQFAIL: " + r.url() + " " + (r.failure()?.errorText || "")));

  let n = 0;
  const shot = async (name) => {
    n++;
    const f = String(n).padStart(2, "0") + "-" + name;
    await page.screenshot({ path: path.join(OUT, f + ".png") });
    console.log("  📷 " + f);
  };
  const click = async (sel, wait = 450) => {
    await page.waitForSelector(sel, { visible: true, timeout: 15000 });
    await page.click(sel); await sleep(wait);
  };
  // 等某阶段变为 passed / failed
  const waitStage = async (title, ms = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await page.evaluate((tt) => {
        const el = [...document.querySelectorAll(".step")].find((s) => s.textContent.includes(tt));
        if (!el) return "missing";
        if (el.classList.contains("passed")) return "passed";
        if (el.classList.contains("failed")) return "failed";
        if (el.classList.contains("running")) return "running";
        return "other";
      }, title);
      if (r === "passed" || r === "failed") return r;
      await sleep(600);
    }
    return "timeout";
  };
  const selStage = async (i) => {
    const els = await page.$$('div[data-act="selstage"]');
    if (!els[i]) return false;
    await els[i].click(); await sleep(600); return true;
  };
  // 等该阶段的「执行本阶段」按钮出现（自动前进 / 手动切阶段后都可能）
  const waitRunBtn = async (ms = 40000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const b = await page.$('button[data-act="runstage"]');
      if (b) return true;
      await sleep(500);
    }
    return false;
  };
  const runNow = async () => {
    if (!(await waitRunBtn())) throw new Error("未找到可执行的阶段按钮");
    await click('button[data-act="runstage"]', 800);
  };
  // 跳到第 i 个阶段并执行
  const runStageAt = async (i, title) => {
    await selStage(i);
    await sleep(400);
    await runNow();
    const s = await waitStage(title);
    return s;
  };

  await page.goto(URL, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(900);
  console.log("① 总览");
  await shot("overview");

  await click('button[data-tab="packages"]', 900); await shot("packages");
  await click('button[data-tab="backups"]', 800); await shot("backups-empty");
  await click('button[data-tab="envs"]', 900); await shot("envs");
  if (await page.$('button[data-act="viewenv"]')) {
    await page.click('button[data-act="viewenv"]'); await sleep(700);
    await shot("env-matrix"); await page.keyboard.press("Escape"); await sleep(300);
  }

  console.log("② 新建流程");
  await click('button[data-tab="flows"]', 700);
  await click('button[data-act="newflow"]', 800); await shot("newflow-modal");
  await click("#fOk", 1800); await shot("wizard-stage1");

  console.log("③ 阶段1 环境登记");
  await click('button[data-act="filldemo"][data-g="physical_nodes"]', 600);
  await click('button[data-act="filldemo"][data-g="virtual_nodes"]', 600);
  await shot("stage1-filled");
  await runNow();
  console.log("   →", await waitStage("环境登记"));
  await sleep(900); await shot("stage1-done");

  console.log("④ 阶段2 环境校验");
  console.log("   →", await runStageAt(1, "环境校验"));
  await sleep(700); await shot("stage2-done");

  console.log("⑤ 阶段3 上传安装包");
  await selStage(2); await sleep(600);
  const tmpPkg = path.join(OUT, "demo-bundle-v2.4.0.tar.gz");
  fs.writeFileSync(tmpPkg, Buffer.alloc(180 * 1024, "FAKE_INSTALL_BUNDLE_v2.4.0\n"));
  const fi = await page.$("#sFile");
  if (fi) { await fi.uploadFile(tmpPkg); await sleep(2800); }
  await shot("stage3-uploaded");
  await runNow();
  console.log("   →", await waitStage("上传安装包"));
  await sleep(700); await shot("stage3-done");

  console.log("⑥ 阶段4 包分发");
  console.log("   →", await runStageAt(3, "包分发"));
  await sleep(700); await shot("stage4-done");

  console.log("⑦ 阶段5 安装前备份");
  await selStage(4); await shot("stage5-form");
  await runNow();
  console.log("   →", await waitStage("安装前备份"));
  await sleep(700); await shot("stage5-done");

  console.log("⑧ 阶段6 执行安装");
  console.log("   →", await runStageAt(5, "执行安装"));
  await sleep(700); await shot("stage6-done");

  console.log("⑨ 阶段7 安装后验证");
  console.log("   →", await runStageAt(6, "安装后验证"));
  await sleep(1100); await shot("stage7-report");

  await click('button[data-tab="backups"]', 900); await shot("backups-filled");
  const vbtn = await page.$('button[data-act="verifybk"]');
  if (vbtn) { await vbtn.click(); await sleep(1400); await shot("backup-verify"); await page.keyboard.press("Escape"); await sleep(400); }
  await click('button[data-tab="packages"]', 900); await shot("packages-filled");
  await click('button[data-tab="overview"]', 1200); await shot("overview-filled");

  console.log("\n════════ 结果 ════════");
  console.log("console error: " + errors.length);
  errors.slice(0, 30).forEach((e) => console.log("  ✕ " + e));
  console.log("console warning: " + warns.length);
  warns.slice(0, 10).forEach((e) => console.log("  ! " + e));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
