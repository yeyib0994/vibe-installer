import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Envs from "./Envs";
import { ToastProvider } from "../components/ToastProvider";
import type { Environment, NodeSpec } from "../api/types";

// 每次调用现造 Response：复用同一 Response 会让顺序 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// api.get 不带 init（fetch 第二参为 undefined），判 GET 需回退 method 缺省值
const hit = (calls: unknown[][], url: string, method = "GET") =>
  calls.some(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET") === method);

const node = (over: Partial<NodeSpec> = {}): NodeSpec => ({
  id: "n1", hostname: "ctrl-phy-01", ip: "10.10.0.11", role: "control", machine_type: "physical",
  ssh_port: 22, ssh_user: "root", status: "unknown", precheck_issues: [], ...over,
});

const baseEnv: Omit<Environment, "id" | "name"> = {
  description: "", base_domain: "saas.internal.com", ntp_server: "", dns_servers: [],
  timezone: "Asia/Shanghai", nodes: [], validated: true, validation_issues: [],
  created_at: "2026-10-01T08:00:00", updated_at: "2026-10-01T08:00:00",
};

const env1: Environment = {
  ...baseEnv, id: "e1", name: "生产-AZ1",
  nodes: [node()],
  summary: { total: 3, by_role: { control: 1, database: 1, worker: 1 }, by_type: { physical: 1, virtual: 2 }, physical: 1, virtual: 2 },
};

// 无 summary 的行：验证回退到 nodes.length
const env2: Environment = {
  ...baseEnv, id: "e2", name: "预发-AZ2", created_at: "2026-10-02T08:00:00",
  nodes: [node({ id: "n2", hostname: "worker-vm-01", machine_type: "virtual", role: "worker" }),
          node({ id: "n3", hostname: "worker-vm-02", machine_type: "virtual", role: "worker" })],
};

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(list: Environment[]) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/environments" && method === "GET") return json(200, list);
    if (url === "/api/environments/e1" && method === "GET") return json(200, {
      ...env1,
      nodes: [node(), node({ id: "n2", hostname: "worker-vm-01", machine_type: "virtual", role: "worker" })],
    });
    if (url === "/api/environments/e1/nodes" && method === "POST") return json(200, { ok: true, total: 10 });
    if (url === "/api/environments/e1" && method === "DELETE") return json(200, { ok: true });
    throw new Error(`未 stub 的请求: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Envs />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => vi.stubEnv("VITE_API_BASE", ""));
afterEach(() => vi.unstubAllGlobals());

describe("Envs 页", () => {
  it("渲染列表行：summary 优先，缺失时回退 nodes 数", async () => {
    stubFetch([env1, env2]);
    setup();
    expect(await screen.findByText("生产-AZ1")).toBeInTheDocument();
    expect(screen.getByText("预发-AZ2")).toBeInTheDocument();
    // e1 用 summary.total=3、physical/virtual=1/2；e2 无 summary 回退 nodes.length=2
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByText("2 套 · 节点矩阵决定组件分派")).toBeInTheDocument();
    expect(screen.getByText("2026-10-01")).toBeInTheDocument();
    expect(screen.getByText("2026-10-02")).toBeInTheDocument();
  });

  it("空列表显示占位文案", async () => {
    stubFetch([]);
    setup();
    expect(await screen.findByText("暂无环境，先创建一套再新建流程")).toBeInTheDocument();
  });

  it("点击「节点」打开详情 modal，走单环境查询渲染矩阵", async () => {
    const user = userEvent.setup();
    stubFetch([env1]);
    setup();
    await user.click(await screen.findByRole("button", { name: "节点" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("物理机节点 · 1 台")).toBeInTheDocument();
    expect(within(dialog).getByText("虚拟机节点 · 1 台")).toBeInTheDocument();
    expect(within(dialog).getByText("worker-vm-01")).toBeInTheDocument();
    // 列表里 e1 只有 1 台，详情 stub 返回 2 台：证明数据来自 GET /environments/e1
    expect(hit(fetchMock.mock.calls, "/api/environments/e1", "GET")).toBe(true);
  });

  it("校验提示卡仅在有 validation_issues 时出现", async () => {
    stubFetch([{ ...env2, validation_issues: ["NTP 服务器未配置"] }]);
    setup();
    expect(await screen.findByText("校验提示")).toBeInTheDocument();
    expect(screen.getByText("NTP 服务器未配置")).toBeInTheDocument();
    expect(screen.getAllByText("预发-AZ2")).toHaveLength(2); // 表格行 + 提示卡里的 Tag
  });

  it("全部环境校验通过时不渲染校验提示卡", async () => {
    stubFetch([env1, env2]);
    setup();
    await screen.findByText("生产-AZ1");
    expect(screen.queryByText("校验提示")).not.toBeInTheDocument();
  });

  it("删除：确认文案含节点数，确认后发 DELETE", async () => {
    const user = userEvent.setup();
    stubFetch([env1]);
    setup();
    await user.click(await screen.findByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/将删除环境「生产-AZ1」及其 1 台节点登记/)).toBeInTheDocument();
    expect(within(dialog).getByText(/已创建的流程不会被删除/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认" }));
    expect(await screen.findByText("环境已删除")).toBeInTheDocument();
    expect(hit(fetchMock.mock.calls, "/api/environments/e1", "DELETE")).toBe(true);
  });

  it("+演示节点：POST 的角色用 database 而非 db", async () => {
    const user = userEvent.setup();
    stubFetch([env1]);
    setup();
    await user.click(await screen.findByRole("button", { name: "+演示节点" }));
    expect(await screen.findByText(/已追加/)).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/environments/e1/nodes" && (i as RequestInit)?.method === "POST");
    expect(call).toBeDefined();
    const body = JSON.parse(String((call as [unknown, RequestInit])[1].body)) as Array<{ role: string; machine_type: string }>;
    expect(body).toHaveLength(9); // 3 控制 + 2 数据库 + 4 工作
    expect(body.filter((n) => n.role === "database")).toHaveLength(2);
    expect(body.filter((n) => n.machine_type === "physical")).toHaveLength(5);
    expect(JSON.stringify(body)).not.toContain('"db"');
  });
});
