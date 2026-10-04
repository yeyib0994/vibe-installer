import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FlowWizard from "./FlowWizard";
import { ToastProvider } from "../components/ToastProvider";
import { qk } from "../api/endpoints";
import { FakeEventSource, resetFakeES } from "../test/fakeEventSource";
import type { EnvSummary, FlowDetail, FlowStage, FormField, NodeSpec } from "../api/types";

// 每次调用现造 Response：复用同一 Response 会让顺序 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const field = (over: Partial<FormField>): FormField => ({
  key: "k", label: "L", type: "text", required: false, placeholder: "", help: "", hint: "", ...over,
});

const stage = (over: Partial<FlowStage>): FlowStage => ({
  key: "k", index: 0, title: "T", description: "", form_fields: [], inputs: {},
  required: true, status: "locked", steps: [], ...over,
});

const node = (over: Partial<NodeSpec> = {}): NodeSpec => ({
  id: "n1", hostname: "ctrl-phy-01", ip: "10.10.0.11", role: "control", machine_type: "physical",
  ssh_port: 22, ssh_user: "root", status: "reachable", precheck_issues: [], ...over,
});

const summary: EnvSummary = {
  total: 2, by_role: { control: 1, worker: 1 }, by_type: { physical: 1, virtual: 1 }, physical: 1, virtual: 1,
};

/** 目录真形：阶段 1 已通过并留下 base_domain，阶段 2 待执行，阶段 3 仍被后端锁着。 */
const stages: FlowStage[] = [
  stage({
    key: "env_register", index: 0, title: "环境登记", status: "passed",
    form_fields: [field({ key: "base_domain", label: "基础域名" })],
    inputs: { base_domain: "saas.internal.com" },
  }),
  stage({
    key: "env_precheck", index: 1, title: "环境校验", status: "ready",
    form_fields: [field({ key: "ssh_port", label: "SSH 端口", type: "number", default: 22 })],
    inputs: { ssh_port: 22 },
  }),
  stage({ key: "package_upload", index: 2, title: "上传安装包", status: "locked", required: false }),
];

const flow = (over: Partial<FlowDetail> = {}): FlowDetail => ({
  id: "f1", name: "生产-AZ1 安装", env_id: "e1", mode: "install", status: "running",
  stages, current_stage: 1, operator: "admin",
  created_at: "2026-10-04T12:00:00", updated_at: "2026-10-04T12:05:00",
  progress: { done: 1, total: 3 },
  env_name: "生产-AZ1", env_summary: summary, nodes: [node(), node({ id: "n2", hostname: "worker-vm-01", machine_type: "virtual", role: "worker" })],
  ...over,
});

function stubFetch(detail: FlowDetail, opts: { failFirst?: boolean } = {}) {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/logs")) return json(200, []);
    if (url === "/api/flows/f1") {
      calls += 1;
      if (opts.failFirst && calls === 1) return json(500, { detail: "流程不存在" });
      return json(200, detail);
    }
    throw new Error(`未 stub 的请求: ${url}`);
  }));
  return () => calls;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/flows/f1"]}>
          <Routes>
            <Route path="/flows/:id" element={<FlowWizard />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** 面板标题（Card 的 h2）与侧栏行同名，用 role 区分。 */
const panelTitle = (name: string | RegExp) => screen.getByRole("heading", { name });
const railButton = (name: RegExp) => screen.getByRole("button", { name });

/** 多条流程详情的 fetch stub：跨流程跳转的测试要同时服务 f1 与 f2。 */
function stubFlows(...details: FlowDetail[]) {
  const byUrl = new Map<string, FlowDetail>(details.map((d) => [`/api/flows/${d.id}`, d]));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/logs")) return json(200, []);
    const hit = byUrl.get(url);
    if (hit) return json(200, hit);
    throw new Error(`未 stub 的请求: ${url}`);
  }));
}

/**
 * 走真实路由跳转（同一路由树会复用元素实例），并把目标流程预先写进查询缓存：
 * useFlow(f2) 首渲染即有数据，`if (!flow)` 不触发，Wizard 全程不被卸载 —— 这正是
 * 「useState 初始值不再重跑」的复现条件；若放任 Wizard 因加载态卸载，测试就打不到这个 bug。
 */
function setupNav(prefill: FlowDetail[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
  for (const d of prefill) qc.setQueryData(qk.flow(d.id), d);
  let navigate!: (to: string) => void;
  function Navigator() {
    navigate = useNavigate();
    return null;
  }
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/flows/f1"]}>
          <Navigator />
          <Routes>
            <Route path="/flows/:id" element={<FlowWizard />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
  return { go: (to: string) => act(() => navigate(to)) };
}

beforeEach(() => resetFakeES());
afterEach(() => vi.unstubAllGlobals());

describe("FlowWizard 页头与落点", () => {
  it("渲染流程名、模式/环境/阶段数、进度，并把页面标题带上流程名", async () => {
    stubFetch(flow());
    setup();
    await screen.findByText("生产-AZ1 安装");
    expect(panelTitle("2. 环境校验")).toBeInTheDocument();
    expect(screen.getByText("全新安装 · 环境 生产-AZ1 · 3 阶段 · 更新于 2026-10-04 12:05")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(document.title).toBe("生产-AZ1 安装 · ShipDesk Console");
  });

  it("默认停在第一个 ready 阶段，locked 阶段不可进入（I2：只认后端 status）", async () => {
    const user = userEvent.setup();
    stubFetch(flow());
    setup();
    await screen.findByText("生产-AZ1 安装");
    expect(panelTitle("2. 环境校验")).toBeInTheDocument();

    const locked = railButton(/上传安装包/);
    expect(locked).toBeDisabled();
    await user.click(locked);
    expect(panelTitle("2. 环境校验")).toBeInTheDocument();
  });

  it("点已通过的阶段回看：表单按该阶段 inputs 回填", async () => {
    const user = userEvent.setup();
    stubFetch(flow());
    setup();
    await screen.findByText("生产-AZ1 安装");

    await user.click(railButton(/环境登记/));
    expect(panelTitle("1. 环境登记")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /基础域名/ })).toHaveValue("saas.internal.com");
  });

  it("passed 阶段下方出现「下一步」入口，点击切到刚解锁的阶段", async () => {
    const user = userEvent.setup();
    stubFetch(flow());
    setup();
    await screen.findByText("生产-AZ1 安装");

    await user.click(railButton(/环境登记/));
    const card = await screen.findByText("下一步");
    const box = card.closest("section");
    expect(within(box as HTMLElement).getByText("已解锁「环境校验」，可继续推进。")).toBeInTheDocument();

    await user.click(within(box as HTMLElement).getByRole("button", { name: "进入下一阶段 →" }));
    expect(panelTitle("2. 环境校验")).toBeInTheDocument();
    expect(screen.queryByText("下一步")).toBeNull();
  });

  it("无 nodes 时不渲染环境节点折叠区", async () => {
    stubFetch(flow({ nodes: [] }));
    setup();
    await screen.findByText("生产-AZ1 安装");
    expect(screen.queryByText(/环境节点 ·/)).toBeNull();
  });

  it("节点折叠区展开后是只读矩阵", async () => {
    stubFetch(flow());
    setup();
    await screen.findByText("生产-AZ1 安装");
    await userEvent.click(screen.getByText("环境节点 · 2 台"));
    expect(screen.getByText("物理机节点 · 1 台")).toBeInTheDocument();
    expect(screen.getByText("虚拟机节点 · 1 台")).toBeInTheDocument();
    expect(screen.getByText("ctrl-phy-01")).toBeInTheDocument();
    expect(screen.getByText("worker-vm-01")).toBeInTheDocument();
  });
});

describe("FlowWizard 回滚入口", () => {
  it("只有 upgrade_k8s 流程给 Helm 回滚按钮", async () => {
    stubFetch(flow({ mode: "upgrade_k8s" }));
    setup();
    await screen.findByText("生产-AZ1 安装");
    expect(screen.getByRole("button", { name: "Helm 回滚" })).toBeEnabled();
  });

  it("install 流程不显示 Helm 回滚", async () => {
    stubFetch(flow());
    setup();
    await screen.findByText("生产-AZ1 安装");
    expect(screen.queryByRole("button", { name: "Helm 回滚" })).toBeNull();
  });
});

describe("FlowWizard 跨流程隔离", () => {
  it("跳到已缓存的流程：向导按流程重挂载，f1 的草稿不会灌进 f2 的表单", async () => {
    const user = userEvent.setup();
    // 两条流程用同一批目录阶段键与同名字段：active.key 在 f2 里照样解析得出，
    // 于是「草稿属于哪条流程」只能从表单回显的值上区分。
    const f2 = flow({
      id: "f2",
      name: "测试-AZ2 安装",
      stages: [
        stage({
          key: "env_register", index: 0, title: "环境登记", status: "passed",
          form_fields: [field({ key: "base_domain", label: "基础域名" })],
          inputs: { base_domain: "az2.internal.com" },
        }),
        stage({
          key: "env_precheck", index: 1, title: "环境校验", status: "ready",
          form_fields: [field({ key: "ssh_port", label: "SSH 端口", type: "number", default: 22 })],
          inputs: { ssh_port: 2200 },
        }),
        stage({ key: "package_upload", index: 2, title: "上传安装包", status: "locked", required: false }),
      ],
    });
    stubFlows(flow(), f2);
    const { go } = setupNav([f2]);
    await screen.findByText("生产-AZ1 安装");

    const port = () => screen.getByRole("spinbutton", { name: /SSH 端口/ });
    expect(port()).toHaveValue(22);
    await user.clear(port());
    await user.type(port(), "999");
    expect(port()).toHaveValue(999);

    go("/flows/f2");
    await screen.findByText("测试-AZ2 安装");
    // f2 自己的 inputs 播种值，而不是 f1 残留的 999
    expect(port()).toHaveValue(2200);
  });
});

describe("FlowWizard 异常与不崩", () => {
  it("首次加载失败：显示后端消息，点重试渲染向导", async () => {
    const user = userEvent.setup();
    stubFetch(flow(), { failFirst: true });
    setup();
    expect(await screen.findByText(/加载流程失败：流程不存在/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("生产-AZ1 安装")).toBeInTheDocument();
  });

  it("stages 为空时不崩，给出可重建的提示", async () => {
    stubFetch(flow({ stages: [] }));
    setup();
    expect(await screen.findByText(/该流程没有阶段/)).toBeInTheDocument();
  });

  it("running 阶段挂载 SSE 并只给终止按钮（门禁仍只看后端 status）", async () => {
    stubFetch(flow({
      stages: [
        stage({ key: "env_register", index: 0, title: "环境登记", status: "running", steps: [] }),
        stage({ key: "env_precheck", index: 1, title: "环境校验", status: "locked" }),
      ],
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    setup();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toContain("/api/flows/f1/stages/env_register/stream");
    expect(panelTitle("1. 环境登记")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "终止" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /校验并执行/ })).toBeNull();
    // 未解锁的阶段依然不可点
    expect(railButton(/环境校验/)).toBeDisabled();
  });
});
