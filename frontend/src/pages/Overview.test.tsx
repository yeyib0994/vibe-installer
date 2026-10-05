import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import Overview from "./Overview";
import { json } from "../test/fixtures";
import type { AuditRecord, FlowSummary, Overview as OverviewData } from "../api/types";

const flow = (over: Partial<FlowSummary> = {}): FlowSummary & { env_name: string } => ({
  id: "f1", name: "生产-AZ1 安装", env_id: "e1", mode: "install", status: "running",
  stages: [], current_stage: 1, operator: "admin",
  created_at: "2026-10-04T09:30:00", updated_at: "2026-10-04T10:00:00",
  progress: { done: 1, total: 3 }, env_name: "生产-AZ1", ...over,
});

const ov = (over: Partial<OverviewData> = {}): OverviewData => ({
  environments: 2, flows_total: 3, flows_by_status: { running: 1, failed: 1 },
  packages: 4, packages_bytes: 2048, backups: 5, backups_bytes: 1024, backups_restorable: 3,
  nodes_total: 9, nodes_physical: 5, nodes_virtual: 4,
  recent_flows: [flow()], environments_detail: [], ...over,
});

const audit = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: 1, ts: "2026-10-05T09:00:00", operator: "admin", action: "flow.run",
  target: "f1", result: "ok", detail: "", ...over,
});

let listCalls = 0;
let auditCalls = 0;

function stub(ovRes: () => Response, auditRes: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/overview") {
      listCalls += 1;
      return listCalls === 1 ? ovRes() : json(200, ov());
    }
    if (url.startsWith("/api/audit")) {
      auditCalls += 1;
      return auditCalls === 1 ? auditRes() : json(200, [audit()]);
    }
    throw new Error(`未 stub 的请求: ${url}`);
  }));
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  listCalls = 0;
  auditCalls = 0;
});

describe("总览页", () => {
  it("总览加载失败：显示后端消息与重试，不停在「加载总览…」", async () => {
    const user = userEvent.setup();
    stub(() => json(500, { detail: "统计读取失败" }), () => json(200, []));
    setup();
    // 诚实规则回归位：error 分支必须排在 pending 分支前面，否则整页永远停在加载文案
    expect(await screen.findByText(/加载总览失败：统计读取失败/)).toBeInTheDocument();
    expect(screen.queryByText("加载总览…")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("生产-AZ1 安装")).toBeInTheDocument();
    expect(listCalls).toBe(2);
  });

  it("审计加载失败：错误行取代「暂无审计记录」，重试后端出记录", async () => {
    const user = userEvent.setup();
    stub(() => json(200, ov()), () => json(502, { detail: "审计日志读取失败" }));
    setup();
    await screen.findByText("生产-AZ1 安装");
    // 诚实规则回归位：查询失败不能伪装成「没有记录」
    expect(await screen.findByText(/加载审计记录失败：审计日志读取失败/)).toBeInTheDocument();
    expect(screen.queryByText("暂无审计记录")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("flow.run")).toBeInTheDocument();
    expect(auditCalls).toBe(2);
  });

  it("审计成功且为空：才显示「暂无审计记录」", async () => {
    stub(() => json(200, ov()), () => json(200, []));
    setup();
    expect(await screen.findByText("暂无审计记录")).toBeInTheDocument();
  });
});
