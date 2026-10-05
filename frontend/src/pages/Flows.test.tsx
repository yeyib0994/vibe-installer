import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import Flows from "./Flows";
import { ToastProvider } from "../components/ToastProvider";
import type { FlowSummary } from "../api/types";

// 每次调用现造 Response：复用同一 Response 会让顺序 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flow = (over: Partial<FlowSummary> = {}): FlowSummary => ({
  id: "f1", name: "生产-AZ1 安装", env_id: "e1", mode: "install", status: "running",
  stages: [], current_stage: 1, operator: "admin",
  created_at: "2026-10-04T09:30:00", updated_at: "2026-10-04T10:00:00",
  progress: { done: 1, total: 3 }, ...over,
});

const LIST = [
  flow(),
  flow({ id: "f2", name: "K8s 升级", env_id: "", mode: "upgrade_k8s", status: "succeeded", progress: { done: 6, total: 6 }, created_at: "2026-10-03T08:00:00" }),
];

let fetchMock: ReturnType<typeof vi.fn>;

const envRow = (id: string, name: string) => ({
  id, name, description: "", base_domain: "", ntp_server: "", dns_servers: [],
  timezone: "Asia/Shanghai", nodes: [], validated: false, validation_issues: [],
  created_at: "2026-10-01T08:00:00", updated_at: "2026-10-01T08:00:00",
});

function stubFetch(opts: { flows?: FlowSummary[]; listGate?: Promise<unknown>; status?: number; detail?: string } = {}) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/flows?limit=100" && method === "GET") {
      await opts.listGate;
      return json(200, opts.flows ?? LIST);
    }
    if (url === "/api/environments" && method === "GET") return json(200, [envRow("e1", "生产-AZ1"), envRow("e2", "预发-AZ2")]);
    if (url === "/api/flows" && method === "POST") {
      if (opts.status) return json(opts.status, { detail: opts.detail ?? "请先创建环境" });
      return json(200, flow({ id: "f9", name: "预发升级", mode: "install", env_id: "e2", status: "draft", progress: { done: 0, total: 7 } }));
    }
    if (url.startsWith("/api/flows/") && method === "DELETE") return json(200, { ok: true });
    throw new Error(`未 stub 的请求: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const LocationDump = () => <span data-testid="location">{`${useLocation().pathname}${useLocation().search}`}</span>;
const WizardStub = () => <div>向导页 {useParams().id}</div>;

function setup(initialEntry = "/flows") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/flows" element={<Flows />} />
            <Route path="/flows/:id" element={<WizardStub />} />
          </Routes>
          <LocationDump />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Flows 列表页", () => {
  it("渲染模式中文、env_id、进度与状态", async () => {
    stubFetch();
    setup();
    await screen.findByText("生产-AZ1 安装");
    // 首行是 thead 的 row，数据行从第二个开始
    const list = screen.getAllByRole("row");
    expect(list).toHaveLength(3);

    expect(within(list[1]).getByText("全新安装")).toBeInTheDocument();
    expect(within(list[1]).getByText("e1")).toBeInTheDocument();
    expect(within(list[1]).getByText("1/3")).toBeInTheDocument();
    expect(within(list[1]).getByText("进行中")).toBeInTheDocument();
    expect(within(list[1]).getByText("2026-10-04 09:30")).toBeInTheDocument();

    expect(within(list[2]).getByText("K8s / Helm 升级")).toBeInTheDocument();
    expect(within(list[2]).getByText("—")).toBeInTheDocument();
    expect(within(list[2]).getByText("成功")).toBeInTheDocument();
    expect(screen.getByText("按门禁顺序推进：上一阶段通过或跳过才会解锁下一阶段")).toBeInTheDocument();
  });

  it("进度条宽度按 done/total 计算，total=0 归零", async () => {
    stubFetch({ flows: [flow({ progress: { done: 2, total: 4 } }), flow({ id: "f0", name: "空流程", progress: { done: 0, total: 0 } })] });
    setup();
    await screen.findByText("生产-AZ1 安装");
    const bars = document.querySelectorAll<HTMLElement>(".w-24 > span");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveStyle({ width: "50%" });
    expect(bars[1]).toHaveStyle({ width: "0%" });
  });

  it("首屏加载显示占位行，不误报「还没有流程」", async () => {
    const d = deferred<void>();
    stubFetch({ flows: [], listGate: d.promise });
    setup();
    expect(await screen.findByText("加载流程…")).toBeInTheDocument();
    expect(screen.queryByText(/还没有流程/)).not.toBeInTheDocument();
    d.resolve();
    expect(await screen.findByText("还没有流程，点击右上角「新建流程」")).toBeInTheDocument();
    expect(screen.queryByText("加载流程…")).not.toBeInTheDocument();
  });

  it("列表加载失败：显示后端消息与重试，不伪装成「还没有流程」", async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/flows?limit=100") {
        listCalls += 1;
        return listCalls === 1
          ? json(503, { detail: "后端暂不可用" })
          : json(200, LIST);
      }
      if (url === "/api/environments") return json(200, []);
      throw new Error(`未 stub 的请求: ${url}`);
    }));
    setup();
    // 诚实规则回归位：失败既不能停在「加载流程…」，也不能落成「还没有流程」
    expect(await screen.findByText(/加载流程失败：后端暂不可用/)).toBeInTheDocument();
    expect(screen.queryByText("加载流程…")).not.toBeInTheDocument();
    expect(screen.queryByText(/还没有流程/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("生产-AZ1 安装")).toBeInTheDocument();
    expect(listCalls).toBe(2);
  });

  it("点「进入」跳到向导路由", async () => {
    const user = userEvent.setup();
    stubFetch();
    setup();
    await screen.findByText("生产-AZ1 安装");
    await user.click(within(screen.getAllByRole("row")[1]).getByRole("button", { name: "进入" }));
    expect(await screen.findByText("向导页 f1")).toBeInTheDocument();
  });

  it("删除：确认文案含流程名与创建日期，确认后发 DELETE", async () => {
    const user = userEvent.setup();
    stubFetch();
    setup();
    await screen.findByText("生产-AZ1 安装");
    await user.click(within(screen.getAllByRole("row")[1]).getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/将删除流程「生产-AZ1 安装」（2026-10-04 创建）/)).toBeInTheDocument();
    expect(within(dialog).getByText(/安装包与备份点不受影响/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    expect(await screen.findByText("流程已删除")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/flows/f1" && (i as RequestInit)?.method === "DELETE")).toBe(true);
  });

  it("删除失败：toast 后端消息，对话框收起，列表未被清空", async () => {
    const user = userEvent.setup();
    stubFetch();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/flows?limit=100") return json(200, LIST);
      if (String(url).startsWith("/api/flows/") && (init?.method ?? "GET") === "DELETE") return json(500, { detail: "数据库忙" });
      throw new Error(`未 stub 的请求: ${url}`);
    }));
    setup();
    await screen.findByText("生产-AZ1 安装");
    await user.click(within(screen.getAllByRole("row")[1]).getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    expect(await screen.findByText("删除失败")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("生产-AZ1 安装")).toBeInTheDocument();
  });
});

describe("Flows 新建入口", () => {
  it("点「新建流程」在 URL 上打 ?new=1 并打开对话框", async () => {
    const user = userEvent.setup();
    stubFetch();
    setup();
    await screen.findByText("生产-AZ1 安装");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "新建流程" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/flows?new=1");
  });

  it("?new=1&env=&mode= 打开并预填；取消后三个参数一起清掉", async () => {
    const user = userEvent.setup();
    stubFetch();
    setup("/flows?new=1&env=e2&mode=upgrade");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/编排模式/)).toHaveValue("upgrade");
    // 环境候选是异步查询，到齐后预填值才落在下拉上
    await waitFor(() => expect(within(dialog).getByLabelText(/目标环境/)).toHaveValue("e2"));

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/flows");
  });

  it("创建成功：POST name/env_id/mode 后关闭弹层并进向导", async () => {
    const user = userEvent.setup();
    stubFetch();
    setup("/flows?new=1&env=e2");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/流程名称/), "预发升级");
    await user.click(within(dialog).getByRole("button", { name: "创建并进入" }));

    expect(await screen.findByText("向导页 f9")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/flows" && (i as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post as [unknown, RequestInit])[1].body))).toEqual({ name: "预发升级", env_id: "e2", mode: "install" });
  });

  it("创建失败：停在列表页并显示后端消息", async () => {
    const user = userEvent.setup();
    stubFetch({ status: 400, detail: "请先创建环境" });
    setup("/flows?new=1&env=e2");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/流程名称/), "预发升级");
    await user.click(within(dialog).getByRole("button", { name: "创建并进入" }));
    expect(await screen.findByText("请先创建环境")).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/flows?new=1&env=e2");
  });
});
