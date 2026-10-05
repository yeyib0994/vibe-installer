import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: [["list"]],
  // 本机实测的重试预算，不是用来藏应用缺陷：同一台机器上新旧两个后端 jar、Vite 代理与 nginx 容器
  // 两条路径都会偶发「请求停滞数十秒」（nginx 记到 uct=35.7s —— TCP 连上游都要 35 秒）。
  // 这是宿主层（Docker Desktop 网络 + 3 个 headed Chromium + 两个 JVM）的争用，不是代码路径的差异，
  // 所以允许一次重试；失败的那次仍会留在报告里（trace + 截图），报告里能看到 flake 本身。
  retries: 1,
  use: {
    baseURL: process.env.SHIPDESK_WEB ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
