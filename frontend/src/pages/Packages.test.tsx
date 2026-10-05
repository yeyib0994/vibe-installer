import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import Packages from "./Packages";
import { ToastProvider } from "../components/ToastProvider";
import { json } from "../test/fixtures";
import type { PackageEntry } from "../api/types";

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

  it("加载失败：显示后端消息与重试，不伪装成「仓库为空」", async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/packages") {
        listCalls += 1;
        return listCalls === 1 ? json(500, { detail: "仓库索引读取失败" }) : json(200, [pkg()]);
      }
      throw new Error(`未 stub 的请求: ${url}`);
    }));
    setup();
    // 诚实规则回归位：失败既不是「仓库为空」，也不停在「加载安装包…」
    expect(await screen.findByText(/加载安装包失败：仓库索引读取失败/)).toBeInTheDocument();
    expect(screen.queryByText("仓库为空")).not.toBeInTheDocument();
    expect(screen.queryByText("加载安装包…")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("app.tar.gz")).toBeInTheDocument();
    expect(listCalls).toBe(2);
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

  it("checksum 为空：不写剪贴板，如实说这个包没有校验和", async () => {
    // 后端 PackageEntry.checksum 默认 ""（PackageEntry.java:18），空值写进剪贴板再报「已复制」是骗人
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    stubList([pkg({ checksum: "" })]);
    setup();
    await user.click(await screen.findByRole("button", { name: "复制校验和" }));
    expect(await screen.findByText("该安装包没有校验和")).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText("校验和已复制")).not.toBeInTheDocument();
  });

  it("分片说明带上「后端重启过则从头再传」的前提，不只承诺能跳过", async () => {
    stubList([]);
    setup();
    // 会话登记在 UploadService 的内存 Map 里（UploadService.java:37），重启后 upload_id 一律不认
    expect(await screen.findByText(/后端重启过则从头再传/)).toBeInTheDocument();
  });
});
