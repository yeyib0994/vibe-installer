import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import Packages from "./Packages";
import { ToastProvider } from "../components/ToastProvider";
import type { PackageEntry } from "../api/types";

// 每次调用现造 Response：复用同一 Response 会让顺序 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const pkg = (over: Partial<PackageEntry> = {}): PackageEntry => ({
  id: "p1", name: "app.tar.gz", version: "1.0.0", kind: "bundle", size_bytes: 1024,
  checksum: "sha256:deadbeef", pieces: [], upload_complete: true, uploaded_bytes: 1024,
  path: "data/packages/app.tar.gz", storage: "local", target_env_id: null,
  created_at: "2026-10-04T12:00:00", note: "", progress: 100, ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

function stubList(list: PackageEntry[], gate?: Promise<unknown>) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/packages" && method === "GET") {
      await gate;
      return json(200, list);
    }
    if (url.startsWith("/api/packages/") && method === "DELETE") return json(200, { ok: true });
    throw new Error(`未 stub 的请求: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Packages />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

// jsdom 里 navigator.clipboard 缺省为 undefined（正是 http/LAN 非安全上下文的真实形态）。
// 用 defineProperty 覆盖，afterEach 复位回 undefined，保证用例互不影响。
function setClipboard(impl: { writeText: (s: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { value: impl, configurable: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setClipboard(undefined);
});

describe("Packages 页", () => {
  it("首屏加载显示占位行，不误报「仓库为空」", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubList([], gate);
    setup();
    expect(await screen.findByText("加载安装包…")).toBeInTheDocument();
    expect(screen.queryByText("仓库为空")).not.toBeInTheDocument();
    release();
    expect(await screen.findByText("仓库为空")).toBeInTheDocument();
    expect(screen.queryByText("加载安装包…")).not.toBeInTheDocument();
  });

  it("加载完成后空列表显示「仓库为空」", async () => {
    stubList([]);
    setup();
    expect(await screen.findByText("仓库为空")).toBeInTheDocument();
  });

  it("渲染列表行：名称、id、类型、版本、大小", async () => {
    stubList([pkg({ size_bytes: 2048, uploaded_bytes: 1024 })]);
    setup();
    expect(await screen.findByText("app.tar.gz")).toBeInTheDocument();
    expect(screen.getByText("p1")).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByText("1 KB")).toBeInTheDocument();
  });

  it("navigator.clipboard 不可用（http/LAN 非安全上下文）：给错误 toast，不抛异常", async () => {
    const user = userEvent.setup();
    setClipboard(undefined);
    stubList([pkg()]);
    setup();
    await user.click(await screen.findByRole("button", { name: "复制校验和" }));
    expect(await screen.findByText("浏览器不支持写入剪贴板")).toBeInTheDocument();
  });

  it("writeText 拒绝：给「浏览器不允许写入剪贴板」错误 toast", async () => {
    const user = userEvent.setup();
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    stubList([pkg()]);
    setup();
    await user.click(await screen.findByRole("button", { name: "复制校验和" }));
    expect(await screen.findByText("浏览器不允许写入剪贴板")).toBeInTheDocument();
  });

  it("复制成功：写入 checksum 并给成功 toast", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    stubList([pkg()]);
    setup();
    await user.click(await screen.findByRole("button", { name: "复制校验和" }));
    expect(await screen.findByText("校验和已复制")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("sha256:deadbeef");
  });
});
