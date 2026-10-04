import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ModeBadge } from "./ModeBadge";
import type { Capabilities } from "../api/types";

function setup(caps: Capabilities) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  qc.setQueryData(["capabilities"], caps);
  return render(
    <QueryClientProvider client={qc}>
      <ModeBadge />
    </QueryClientProvider>
  );
}

describe("ModeBadge (I1)", () => {
  it("effective_mode=real 显示真实模式", () => {
    setup({ ssh: true, rsync: true, force_mock: false, effective_mode: "real", mock_notice: "" });
    expect(screen.getByText("真实模式")).toBeInTheDocument();
  });

  it("ssh=true 但 force_mock=true 必须显示模拟（旧版 bug 回归点）", () => {
    setup({
      ssh: true,
      rsync: true,
      force_mock: true,
      effective_mode: "mock",
      mock_notice: "已设置 CLOUDOPS_FORCE_MOCK=1，节点操作全部以模拟模式执行",
    });
    expect(screen.getByText(/模拟模式/)).toBeInTheDocument();
    expect(screen.getByText(/已强制模拟/)).toBeInTheDocument();
  });

  it("effective_mode=mock 且 force_mock=false：模拟模式无「已强制模拟」后缀，tooltip 为 mock_notice", () => {
    const caps: Capabilities = {
      ssh: false,
      rsync: false,
      force_mock: false,
      effective_mode: "mock",
      mock_notice: "未检测到可用的 ssh 客户端，节点操作以模拟模式执行",
    };
    setup(caps);
    // 后缀缺失：文本恰为「模拟模式」，不带「（已强制模拟）」
    expect(screen.getByText("模拟模式")).toBeInTheDocument();
    expect(screen.queryByText(/已强制模拟/)).toBeNull();
    expect(screen.queryByText(/真实模式/)).toBeNull();
    // title 取 mock_notice
    expect(screen.getByTitle(caps.mock_notice)).toBeInTheDocument();
  });

  it("无缓存且 capabilities 尚未返回时显示检测中…", () => {
    // 真实首屏：没有预取缓存，请求挂起（永不 settle）即 isLoading 且 data 为 undefined
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <ModeBadge />
      </QueryClientProvider>
    );
    expect(screen.getByText("检测中…")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("capabilities 请求失败时显示模式未知，不停留在检测中…", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <ModeBadge />
      </QueryClientProvider>
    );
    expect(await screen.findByText("模式未知")).toBeInTheDocument();
    expect(screen.queryByText("检测中…")).toBeNull();
    vi.unstubAllGlobals();
  });
});
