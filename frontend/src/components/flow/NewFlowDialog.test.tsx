import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewFlowDialog } from "./NewFlowDialog";
import { ToastProvider } from "../ToastProvider";
import { json } from "../../test/fixtures";
import type { Environment, Flow, FlowMode } from "../../api/types";

const env = (over: Partial<Environment> = {}): Environment => ({
  id: "e1", name: "生产-AZ1", description: "", base_domain: "", ntp_server: "", dns_servers: [],
  timezone: "Asia/Shanghai", nodes: [], validated: true, validation_issues: [],
  created_at: "2026-10-01T08:00:00", updated_at: "2026-10-01T08:00:00", ...over,
});

const createdFlow = (over: Partial<Flow> = {}): Flow => ({
  id: "f9", name: "生产-AZ1 全新安装", env_id: "e1", mode: "install", status: "draft",
  stages: [], current_stage: 0, operator: "admin",
  created_at: "2026-10-04T12:00:00", updated_at: "2026-10-04T12:00:00", ...over,
});

interface Call { url: string; body: Record<string, unknown> }

function stubFetch(opts: { envs?: Environment[]; create?: Flow; status?: number; detail?: string; gate?: Promise<void> } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url === "/api/environments" && method === "GET") return json(200, opts.envs ?? [env(), env({ id: "e2", name: "预发-AZ2" })]);
    if (url === "/api/flows" && method === "POST") {
      await opts.gate;
      if (opts.status && opts.status !== 200) return json(opts.status, { detail: opts.detail ?? "请先创建环境" });
      return json(200, opts.create ?? createdFlow({ name: String(body.name), env_id: String(body.env_id), mode: body.mode as FlowMode }));
    }
    throw new Error(`未 stub 的请求: ${method} ${url}`);
  }));
  return calls;
}

function setup(over: { open?: boolean; presetEnv?: string; presetMode?: FlowMode } = {}) {
  const onCreated = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <NewFlowDialog
          open={over.open ?? true}
          onClose={() => {}}
          onCreated={onCreated}
          presetEnv={over.presetEnv}
          presetMode={over.presetMode}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  return { onCreated };
}

/** 挂起的 POST：先断言 pending 态，resolve 后再断言终态（禁用假定时器，React 19 下会死锁）。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const nameInput = () => screen.getByLabelText(/流程名称/);
const modeSelect = () => screen.getByLabelText(/编排模式/);
const envSelect = () => screen.getByLabelText(/目标环境/);
const submitBtn = () => screen.getByRole("button", { name: "创建并进入" });

afterEach(() => vi.unstubAllGlobals());

describe("NewFlowDialog", () => {
  it("编排模式二选一取自 MODE_OPTIONS，切换后 hint 跟随", async () => {
    const user = userEvent.setup();
    stubFetch();
    setup();
    const select = modeSelect();
    expect(within(select).getByRole("option", { name: "全新安装" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "K8s / Helm 升级" })).toBeInTheDocument();
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("7 阶段 · 环境登记到安装后验证")).toBeInTheDocument();

    await user.selectOptions(select, "upgrade_k8s");
    expect(screen.getByText("7 阶段 · 离线包驱动的 Helm 升级，含回滚预案")).toBeInTheDocument();
  });

  it("名称为空即拦下：只 toast 不发请求", async () => {
    const user = userEvent.setup();
    const calls = stubFetch();
    setup();
    await user.click(submitBtn());
    expect(await screen.findByText("流程名称必填")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/flows")).toHaveLength(0);
  });

  it("未选环境的拦截：install 拦下，只有 K8s 升级可以留空", async () => {
    const user = userEvent.setup();
    const calls = stubFetch();
    const { onCreated } = setup();
    await user.type(nameInput(), "预发升级");
    await user.click(submitBtn());
    expect(await screen.findByText("全新安装必须选择环境")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/flows")).toHaveLength(0);

    await user.selectOptions(modeSelect(), "upgrade_k8s");
    await user.click(submitBtn());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("f9"));
    expect(calls.filter((c) => c.url === "/api/flows")).toHaveLength(1);
  });

  it("提交 name/env_id/mode 三字段，名称去空格，成功后回传新流程 id", async () => {
    const user = userEvent.setup();
    const calls = stubFetch();
    const { onCreated } = setup();
    await user.type(nameInput(), "  生产-AZ1 全新安装  ");
    await user.selectOptions(envSelect(), "e2");
    await user.selectOptions(modeSelect(), "upgrade_k8s");
    await user.click(submitBtn());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("f9"));
    const post = calls.find((c) => c.url === "/api/flows");
    expect(post?.body).toEqual({ name: "生产-AZ1 全新安装", env_id: "e2", mode: "upgrade_k8s" });
    expect(screen.getByText("流程「生产-AZ1 全新安装」已创建")).toBeInTheDocument();
  });

  it("presetEnv / presetMode 预填下拉", async () => {
    stubFetch();
    setup({ presetEnv: "e2", presetMode: "upgrade_k8s" });
    expect(modeSelect()).toHaveValue("upgrade_k8s");
    // 环境列表是异步的：options 到齐后预填值必须仍然生效
    await screen.findByText("预发-AZ2");
    expect(envSelect()).toHaveValue("e2");
  });

  it("presetMode 不在 MODE_OPTIONS 里时回落 install，绝不把未知 mode 提交给后端", async () => {
    const user = userEvent.setup();
    const calls = stubFetch();
    setup({ presetMode: "rollback" as FlowMode });
    expect(modeSelect()).toHaveValue("install");
    await screen.findByText("生产-AZ1");
    await user.type(nameInput(), "生产-AZ1");
    await user.selectOptions(envSelect(), "e1");
    await user.click(submitBtn());
    const body = calls.find((c) => c.url === "/api/flows")?.body;
    expect(body).toMatchObject({ mode: "install" });
  });

  it("目标环境 hint 跟着模式改口：只有 K8s 升级说「可留空」", async () => {
    const user = userEvent.setup();
    stubFetch({ envs: [] });
    setup();
    expect(screen.getByText("还没有环境，请先到「环境」页创建")).toBeInTheDocument();

    await user.selectOptions(modeSelect(), "upgrade_k8s");
    expect(screen.getByText(/可留空/)).toBeInTheDocument();
  });

  it("后端 400：toast 显示后端消息，不导航", async () => {
    const user = userEvent.setup();
    stubFetch({ status: 400, detail: "请先创建环境" });
    const { onCreated } = setup();
    await user.type(nameInput(), "生产-AZ1");
    await user.selectOptions(envSelect(), "e1");
    await user.click(submitBtn());
    expect(await screen.findByText("请先创建环境")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("pending 期间按钮禁用，重复点击只发一次 POST", async () => {
    const user = userEvent.setup();
    const d = deferred<void>();
    const calls = stubFetch({ gate: d.promise });
    const { onCreated } = setup();
    await user.type(nameInput(), "生产-AZ1");
    await user.selectOptions(envSelect(), "e1");
    const btn = submitBtn();
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    await user.click(btn);
    expect(calls.filter((c) => c.url === "/api/flows")).toHaveLength(1);
    d.resolve();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("f9"));
  });

  it("open=false 不渲染对话框", () => {
    stubFetch();
    setup({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("取消后重开是干净表单：草稿与旧 preset 都不残留（对话框实例从不卸载）", async () => {
    const user = userEvent.setup();
    stubFetch();
    // 复刻 Flows.tsx：NewFlowDialog 常驻挂载，open/presetEnv/presetMode 只是随 URL 参数翻转的 props，
    // 关闭并不卸载它 —— 不重新播种，上一轮的 name 与 env/mode 就会跟着下一次打开回来。
    let flip: (next: { open: boolean; presetEnv?: string; presetMode?: FlowMode }) => void = () => {};
    type St = { open: boolean; presetEnv?: string; presetMode?: FlowMode };
    function Harness() {
      const [st, setSt] = useState<St>({ open: true, presetEnv: "e2", presetMode: "install" });
      flip = (next) => setSt(next);
      return (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } })}>
          <ToastProvider>
            <NewFlowDialog open={st.open} onClose={() => {}} onCreated={() => {}} presetEnv={st.presetEnv} presetMode={st.presetMode} />
          </ToastProvider>
        </QueryClientProvider>
      );
    }
    render(<Harness />);

    await user.type(nameInput(), "残留草稿");
    await user.selectOptions(modeSelect(), "upgrade_k8s");

    // 关闭 → 用不同的 preset 重开：必须按新 preset 重新播种，绝不带上一轮的 name 与 mode
    act(() => flip({ open: false }));
    act(() => flip({ open: true, presetEnv: "e1", presetMode: "install" }));

    await screen.findByText("生产-AZ1");
    expect(nameInput()).toHaveValue("");
    expect(modeSelect()).toHaveValue("install");
    expect(envSelect()).toHaveValue("e1");
  });
});
