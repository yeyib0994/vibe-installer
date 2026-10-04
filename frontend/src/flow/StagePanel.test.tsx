import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StagePanel, type StagePanelProps } from "./StagePanel";
import { useFlowRunner } from "../hooks/useFlowRunner";
import { qk } from "../api/endpoints";
import { FakeEventSource, resetFakeES } from "../test/fakeEventSource";
import type { ReactElement, ReactNode } from "react";
import type { StageLogEvent } from "../api/endpoints";
import type { EnvSummary, FlowDetail, FlowStage, FormField, StepState } from "../api/types";

/**
 * 夹具取自目录真形：package_upload 的可选 number 字段 + 服务端写进 inputs 的下划线键
 * （_package_id / _package_ids 只经 collect 的 I3 合并存活，面板本身不渲染它们）。
 */
const stage: FlowStage = {
  key: "package_upload", index: 2, title: "上传安装包", description: "",
  form_fields: [{ key: "chunk_size", label: "分片大小 MB", type: "number", required: false, placeholder: "", help: "", hint: "", default: 8 }],
  inputs: { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 8 },
  required: true, status: "ready", steps: [],
};

const HISTORY = "历史行-HISTORY";
const STREAM = "实时行-STREAM";

const step = (over: Partial<StepState> = {}): StepState => ({
  id: "s1", index: 0, title: "校验包完整性", detail: "", action: "verify_package", args: {},
  status: "pending", output: "", error: null, duration_ms: 0, ...over,
});

// 每次调用现造 Response：复用同一 Response 会让后续 fetch 抛 Body is unusable。
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 只 stub 阶段历史日志：GET /logs 是裸数组（ApiController.java:393-396）。 */
function stubLogsFetch(events?: StageLogEvent[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/flows/f1/stages/package_upload/logs") {
      return json(200, events ?? [{ type: "log", level: "info", message: HISTORY, ts: "2026-10-04T12:00:00" }]);
    }
    throw new Error(`未 stub 的请求: ${url}`);
  }));
}

const noop = () => {};

/** 统一给必填入参，测试只覆写自己关心的那几个（props 漂移交给 tsc 拦）。 */
function panel(over: Partial<StagePanelProps> = {}): ReactElement {
  const base: StagePanelProps = {
    flowId: "f1", stage, values: { chunk_size: 8 }, onChange: noop, fieldErrors: [], busy: false,
    onRun: noop, onSkip: noop, onCancel: noop, onStreamDone: noop,
  };
  return <StagePanel {...base} {...over} />;
}

/** 每个测试一套新 QueryClient，且 retry 必须为 0 —— 失败请求会重投到未 stub 的 fetch 上。 */
function renderPanel(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  return qc;
}

beforeEach(() => {
  resetFakeES();
  stubLogsFetch();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StagePanel 按钮门禁（只看后端 status）", () => {
  it("ready 阶段可执行，非必经不显示跳过（此阶段 required=true）", async () => {
    const onRun = vi.fn();
    renderPanel(panel({ onRun }));
    expect(screen.queryByText("跳过此阶段")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /校验并执行/ }));
    expect(onRun).toHaveBeenCalled();
  });

  it("locked 阶段禁用执行", () => {
    renderPanel(panel({ stage: { ...stage, status: "locked" }, values: {} }));
    expect(screen.getByRole("button", { name: /校验并执行/ })).toBeDisabled();
  });

  it("passed 阶段只能回看：执行按钮存在但禁用", () => {
    renderPanel(panel({ stage: { ...stage, status: "passed" } }));
    expect(screen.getByRole("button", { name: /校验并执行/ })).toBeDisabled();
  });

  it("required=false 的 ready 阶段显示跳过此阶段，点击回调 onSkip", async () => {
    const onSkip = vi.fn();
    renderPanel(panel({ stage: { ...stage, required: false }, onSkip }));
    await userEvent.click(screen.getByRole("button", { name: "跳过此阶段" }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("failed 阶段主按钮文案为重试此阶段且可点", async () => {
    const onRun = vi.fn();
    renderPanel(panel({ stage: { ...stage, status: "failed" }, onRun }));
    const btn = screen.getByRole("button", { name: /重试此阶段/ });
    expect(btn).toBeEnabled();
    expect(screen.queryByText(/校验并执行/)).toBeNull();
    await userEvent.click(btn);
    expect(onRun).toHaveBeenCalled();
  });

  it("busy 时禁用主按钮并显示提交中", () => {
    renderPanel(panel({ busy: true }));
    const btn = screen.getByRole("button", { name: /提交中…/ });
    expect(btn).toBeDisabled();
  });

  it("running 阶段只给终止按钮，不给执行/跳过，表单控件禁用", () => {
    renderPanel(panel({ stage: { ...stage, status: "running", required: false }, values: { chunk_size: 8 } }));
    expect(screen.getByRole("button", { name: "终止" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /校验并执行|重试此阶段/ })).toBeNull();
    expect(screen.queryByText("跳过此阶段")).toBeNull();
    expect(screen.getByRole("spinbutton", { name: /分片大小/ })).toBeDisabled();
  });
});

describe("StagePanel 错误与插槽", () => {
  it("stage.error 与 fieldErrors 同时渲染", () => {
    renderPanel(panel({
      stage: { ...stage, status: "failed", error: "端口 6443 不可达" },
      fieldErrors: ["chunk_size 必须是数字", "target_roles 为必填项"],
    }));
    expect(screen.getByText("端口 6443 不可达")).toBeInTheDocument();
    expect(screen.getByText("chunk_size 必须是数字")).toBeInTheDocument();
    expect(screen.getByText("target_roles 为必填项")).toBeInTheDocument();
  });

  it("无错误时不渲染错误块", () => {
    renderPanel(panel());
    expect(screen.queryByText("阶段参数")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("uploadSlot 原样渲染在表单之下（4.7 注入的上传区）", () => {
    renderPanel(panel({ uploadSlot: <p>拖拽文件到此处上传</p> }));
    expect(screen.getByText("拖拽文件到此处上传")).toBeInTheDocument();
  });
});

describe("StagePanel 日志单一数据源（useStageStream 取数规则）", () => {
  it("非 running 渲染 GET /logs 历史，且不建 SSE 连接", async () => {
    renderPanel(panel());
    expect(await screen.findByText(HISTORY)).toBeInTheDocument();
    expect(screen.queryByText(STREAM)).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("running 且流有行时只渲染流的 logs，历史行整行撤下（不双打）", async () => {
    renderPanel(panel({ stage: { ...stage, status: "running" } }));
    // 流尚未重放到行时先取历史；一旦流有行即改取流，二者恒取其一
    expect(await screen.findByText(HISTORY)).toBeInTheDocument();

    const es = FakeEventSource.instances[0];
    expect(es).toBeDefined();
    act(() => es.emit({ type: "log", level: "ok", message: STREAM, ts: "2026-10-04T12:00:01" }));

    expect(screen.getByText(STREAM)).toBeInTheDocument();
    expect(screen.queryByText(HISTORY)).not.toBeInTheDocument();
  });

  it("SSE 降级为轮询时提示「实时连接中断，已转轮询」", () => {
    renderPanel(panel({ stage: { ...stage, status: "running" } }));
    expect(screen.queryByText(/实时连接中断/)).toBeNull();
    act(() => FakeEventSource.instances[0].fail());
    expect(screen.getByText("实时连接中断，已转轮询")).toBeInTheDocument();
  });

  it("降级后流不再是数据源：控制台改显轮询到的历史，步骤也不被冻结的缓冲区覆盖", async () => {
    renderPanel(panel({
      stage: { ...stage, status: "running", steps: [step({ status: "done", duration_ms: 1200 })] },
    }));
    const es = FakeEventSource.instances[0];
    act(() => es.emit({ type: "log", level: "info", message: STREAM, ts: "2026-10-04T12:00:01" }));
    act(() => es.emit({ type: "step", stage: "package_upload", step: step({ status: "running" }) }));
    expect(screen.getByText(STREAM)).toBeInTheDocument();
    expect(screen.getByText("执行中…")).toBeInTheDocument();
    expect(screen.queryByText(HISTORY)).not.toBeInTheDocument();

    // 断线后缓冲区停在断线那一刻：只有轮询到的历史与服务端 steps 反映现状
    act(() => es.fail());
    expect(await screen.findByText(HISTORY)).toBeInTheDocument();
    expect(screen.queryByText(STREAM)).toBeNull();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("执行中…")).toBeNull();
  });
});

describe("StagePanel 步骤合并", () => {
  it("流的步骤状态覆盖 stage.steps 同 id 项，不重复追加", () => {
    renderPanel(panel({
      stage: {
        ...stage,
        status: "running",
        steps: [step(), step({ id: "s2", index: 1, title: "分发包到节点" })],
      },
    }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    act(() => FakeEventSource.instances[0].emit({
      type: "step",
      stage: "package_upload",
      step: step({ status: "done", duration_ms: 1200 }),
    }));

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText(/校验包完整性/)).toBeInTheDocument();
  });

  it("非 running 且无流数据时按 stage.steps 原样渲染", () => {
    // status 用 passed 而不是 ready：STAGE_CN.ready 与 STEP_CN.pending 同为「待执行」，会串味
    renderPanel(panel({ stage: { ...stage, status: "passed", steps: [step(), step({ id: "s2", index: 1, title: "分发包到节点" })] } }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByText("待执行")).toHaveLength(2);
  });
});

/* ============ useFlowRunner：草稿重播种与 validate→inputs→run 编排 ============ */

const numField = (over: Partial<FormField> = {}): FormField => ({
  key: "chunk_size", label: "分片大小 MB", type: "number", required: false,
  placeholder: "", help: "", hint: "", ...over,
});

const stageOf = (over: Partial<FlowStage> = {}): FlowStage => ({
  key: "upload", index: 1, title: "上传安装包", description: "",
  form_fields: [numField({ default: 8 })],
  inputs: { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 8 },
  required: true, status: "ready", steps: [], ...over,
});

const summary: EnvSummary = { total: 0, by_role: {}, by_type: {}, physical: 0, virtual: 0 };

const flowDetail = (stages: FlowStage[]): FlowDetail => ({
  id: "f1", name: "生产-AZ1 安装", env_id: "e1", mode: "install", status: "running",
  stages, current_stage: 0, operator: "admin",
  created_at: "2026-10-04T12:00:00", updated_at: "2026-10-04T12:00:00",
  progress: { done: 0, total: stages.length },
  env_name: "生产-AZ1", env_summary: summary, nodes: [],
});

const makeQc = () => new QueryClient({ defaultOptions: { queries: { retry: 0 } } });

const wrapperOf = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

const hookOf = (flow: FlowDetail, qc = makeQc()) =>
  renderHook((f: FlowDetail) => useFlowRunner(f), { wrapper: wrapperOf(qc), initialProps: flow });

/** 让在途请求跑进 pending：真实 macrotask（禁用假定时器 —— React 19 下会死锁 await）。 */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

interface Call { url: string; method: string; body: Record<string, unknown> }

/**
 * stub validate/inputs/run/skip/cancel 五个写端点。
 * 每次调用现造 Response —— 复用同一 Response 会让第二次读体抛 Body is unusable。
 */
function stubRunnerFetch(opts: { valid?: boolean; errors?: string[]; inputsStatus?: number; gate?: Promise<void> } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, method, body });
    if (url.endsWith("/validate")) return json(200, { valid: opts.valid ?? true, errors: opts.errors ?? [] });
    if (url.endsWith("/inputs")) {
      await opts.gate;
      const status = opts.inputsStatus ?? 200;
      return status === 200
        ? json(200, { ok: true, inputs: body.inputs ?? {}, nodes: 1 })
        : json(status, { errors: opts.errors ?? [], message: "数据校验未通过" });
    }
    if (url.endsWith("/run")) return json(200, { ok: true, stage: "upload", status: "running" });
    if (url.endsWith("/skip")) return json(200, { ok: true, stage: stageOf() });
    if (url.endsWith("/cancel")) return json(200, { ok: true });
    throw new Error(`未 stub 的请求: ${method} ${url}`);
  }));
  return calls;
}

const inputsOf = (calls: Call[], suffix: string) => calls.find((c) => c.url.endsWith(suffix))?.body.inputs;

describe("useFlowRunner 草稿归属：只在切阶段时重播种", () => {
  it("切走再切回不保留废弃草稿，同名字段的两阶段互不串值", () => {
    const upload = stageOf();
    const distribute = stageOf({
      key: "distribute", index: 2, title: "分发安装包",
      form_fields: [numField({ default: 16 })], inputs: { _distribution_id: "d0" },
    });
    const { result } = hookOf(flowDetail([upload, distribute]));

    expect(result.current.activeKey).toBe("upload");
    expect(result.current.values).toEqual({ chunk_size: 8 });

    act(() => result.current.setValue("chunk_size", "99"));
    expect(result.current.values.chunk_size).toBe("99");

    // 侧栏整行都能点：再点当前阶段不算切换，草稿不能被抹掉
    act(() => result.current.select("upload"));
    expect(result.current.values.chunk_size).toBe("99");

    // 切到字段名完全相同的另一阶段：只拿到它自己的 default，绝不带 upload 的草稿
    act(() => result.current.select("distribute"));
    expect(result.current.values).toEqual({ chunk_size: 16 });

    // 切回来按 upload 的 inputs 重新播种，废弃草稿不复活
    act(() => result.current.select("upload"));
    expect(result.current.values).toEqual({ chunk_size: 8 });
  });

  it("轮询刷新产出全新 inputs 对象时不抹掉正在输入的值", () => {
    const { result, rerender } = hookOf(flowDetail([stageOf()]));
    act(() => result.current.setValue("chunk_size", "99"));
    // useFlow 在有 running 阶段时每 1.2s 轮询：整棵 flow 树（含 stage.inputs）都是新引用
    rerender(flowDetail([stageOf({ inputs: { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 8 } })]));
    expect(result.current.values.chunk_size).toBe("99");
    expect(result.current.activeKey).toBe("upload");
  });

  it("setValue 清掉上一轮的 fieldErrors", async () => {
    const calls = stubRunnerFetch({ valid: false, errors: ["分片大小 MB 必须是数字"] });
    const { result } = hookOf(flowDetail([stageOf()]));
    await act(async () => {
      await result.current.run();
    });

    expect(result.current.fieldErrors).toEqual(["分片大小 MB 必须是数字"]);
    expect(calls.some((c) => c.url.endsWith("/inputs"))).toBe(false);

    act(() => result.current.setValue("chunk_size", 9));
    expect(result.current.fieldErrors).toEqual([]);
  });
});

describe("useFlowRunner 初始落点", () => {
  const initialKey = (stages: FlowStage[]) => hookOf(flowDetail(stages)).result.current.activeKey;

  it("running > failed > ready > 未完成，全部通过则兜底首阶段", () => {
    expect(initialKey([stageOf({ key: "a" }), stageOf({ key: "b", index: 2, status: "running" }), stageOf({ key: "c", index: 3, status: "ready" })])).toBe("b");
    expect(initialKey([stageOf({ key: "a", status: "passed" }), stageOf({ key: "b", index: 2, status: "failed" }), stageOf({ key: "c", index: 3, status: "ready" })])).toBe("b");
    expect(initialKey([stageOf({ key: "a", status: "passed" }), stageOf({ key: "b", index: 2, status: "locked" }), stageOf({ key: "c", index: 3, status: "ready" })])).toBe("c");
    // 全通过：没有任何未完成阶段时兜底回首阶段
    expect(initialKey([stageOf({ key: "a", status: "passed" }), stageOf({ key: "b", index: 2, status: "skipped" })])).toBe("a");
  });

  it("空 stages 不崩：activeKey 回空串、无下一步", () => {
    const { result } = hookOf(flowDetail([]));
    expect(result.current.activeKey).toBe("");
    expect(result.current.values).toEqual({});
    expect(result.current.nextReady).toBeUndefined();
  });

  it("nextReady 只认当前阶段之后的 ready/failed，跳过已通过与未解锁", () => {
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "passed" }),
      stageOf({ key: "c", index: 3, status: "locked" }),
      stageOf({ key: "d", index: 4, status: "failed" }),
    ]));
    // 起点是 running 的 a；passed 已完成、locked 不可执行，第一个可推进的是 failed 的 d
    expect(result.current.activeKey).toBe("a");
    expect(result.current.nextReady?.key).toBe("d");
  });
});

describe("useFlowRunner run：validate → submit inputs → run", () => {
  it("提交 {...stage.inputs, ...collected}（I3），成功后按实收值回显", async () => {
    const calls = stubRunnerFetch();
    const { result } = hookOf(flowDetail([stageOf()]));
    act(() => result.current.setValue("chunk_size", "99"));

    await act(async () => {
      await expect(result.current.run()).resolves.toBe(true);
    });

    const merged = { _package_id: "pk1", _package_ids: ["pk1"], chunk_size: 99 };
    expect(inputsOf(calls, "/validate")).toEqual(merged);
    expect(inputsOf(calls, "/inputs")).toEqual(merged);
    expect(calls.find((c) => c.url.endsWith("/run"))?.body).toEqual({ operator: "admin" });
    // 所见即所存：表单按刚被收下的那份 inputs 回显（含服务端下划线键）
    expect(result.current.values).toEqual(merged);
    expect(result.current.busy).toBe(false);
  });

  it("留空的可选 number 提交 null 而不是空串（契约校正 8）", async () => {
    const calls = stubRunnerFetch();
    const { result } = hookOf(flowDetail([stageOf()]));
    act(() => result.current.setValue("chunk_size", "   "));

    await act(async () => {
      await result.current.run();
    });

    expect(inputsOf(calls, "/inputs")).toEqual({ _package_id: "pk1", _package_ids: ["pk1"], chunk_size: null });
  });

  it("validate 不过：不提交 inputs、不启动执行，错误进 fieldErrors", async () => {
    const calls = stubRunnerFetch({ valid: false, errors: ["分片大小 MB 必须是数字"] });
    const { result } = hookOf(flowDetail([stageOf()]));

    await act(async () => {
      await expect(result.current.run()).resolves.toBe(false);
    });

    expect(result.current.fieldErrors).toEqual(["分片大小 MB 必须是数字"]);
    expect(calls.map((c) => c.url)).toEqual(["/api/flows/f1/stages/upload/validate"]);
    expect(result.current.busy).toBe(false);
  });

  it("inputs 回 422：后端字段错误落地，run 端点不被调用", async () => {
    const calls = stubRunnerFetch({ inputsStatus: 422, errors: ["目标角色为必填项"] });
    const { result } = hookOf(flowDetail([stageOf()]));

    await act(async () => {
      await expect(result.current.run()).resolves.toBe(false);
    });

    expect(result.current.fieldErrors).toEqual(["目标角色为必填项"]);
    expect(calls.some((c) => c.url.endsWith("/run"))).toBe(false);
  });

  it("在途提交返回时若已切走，不把上一阶段的实收值灌进新阶段", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls = stubRunnerFetch({ gate });
    const { result } = hookOf(flowDetail([
      stageOf(),
      stageOf({ key: "distribute", index: 2, form_fields: [numField({ default: 16 })], inputs: { _distribution_id: "d0" } }),
    ]));

    let runPromise: Promise<boolean> | undefined;
    act(() => {
      runPromise = result.current.run();
    });
    await flush();
    expect(calls.some((c) => c.url.endsWith("/inputs"))).toBe(true);
    expect(result.current.busy).toBe(true);

    act(() => result.current.select("distribute"));
    expect(result.current.values).toEqual({ chunk_size: 16 });

    release();
    await act(async () => {
      await runPromise;
    });

    expect(result.current.activeKey).toBe("distribute");
    expect(result.current.values).toEqual({ chunk_size: 16 });
    expect(result.current.busy).toBe(false);
  });
});

describe("useFlowRunner skip / cancel", () => {
  it("两个写操作都打到对应端点并刷新 flow 与阶段日志", async () => {
    const calls = stubRunnerFetch();
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([stageOf()]), qc);

    await act(async () => {
      await result.current.skip();
    });
    const skipCall = calls.find((c) => c.url.endsWith("/skip"));
    expect(skipCall?.method).toBe("POST");
    expect(skipCall?.body).toEqual({ operator: "admin" });

    await act(async () => {
      await result.current.cancel();
    });
    expect(calls.some((c) => c.url === "/api/flows/f1/stages/upload/cancel")).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "f1", "stages", "upload", "logs"] });
  });

  it("cancel 返回 ok=false 时不崩，仍刷新 flow", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/cancel") ? json(200, { ok: false }) : json(200, {})));
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([stageOf()]), qc);

    await act(async () => {
      await result.current.cancel();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
  });
});

describe("useFlowRunner onStreamDone：只认缓存里的 flow", () => {
  it("缓存里没有更新就不推进，留在已结束的阶段", () => {
    // props 快照里下一阶段已是 ready：若照闭包里的旧数据推进就违反了规则
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
    ]));
    act(() => result.current.onStreamDone("a", "passed", null));
    expect(result.current.activeKey).toBe("a");
  });

  it("缓存里的下一个 ready 命中就推进，并按缓存中该阶段的 inputs 播种", () => {
    const qc = makeQc();
    qc.setQueryData(qk.flow("f1"), flowDetail([
      stageOf({ key: "a", status: "passed" }),
      stageOf({
        key: "b", index: 2, title: "分发安装包", status: "ready",
        form_fields: [numField({ default: 16 })], inputs: { _distribution_id: "d9", chunk_size: 4 },
      }),
    ]));
    // props 快照仍旧：b 在快照里是 locked（据此推进推不到），只有缓存里才是 ready
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "locked" }),
    ]), qc);
    expect(result.current.activeKey).toBe("a");

    act(() => result.current.onStreamDone("a", "passed", null));
    expect(result.current.activeKey).toBe("b");
    expect(result.current.values).toEqual({ chunk_size: 4 });
  });

  it("failed 不推进，但仍刷新 flow", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
    ]), qc);

    act(() => result.current.onStreamDone("a", "failed", "端口 6443 不可达"));
    expect(result.current.activeKey).toBe("a");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
  });

  it("来源 key 不是当前阶段就整个忽略：A 的完成不能作用于 B", () => {
    // 用户点了已通过的 A 切到 B，A 那条还没关的流在此期间下发 stage_done ——
    // 回调闭包里的 stage 已是 B，不认来源就会给 B 弹「通过」并把向导从 B 推进走。
    const qc = makeQc();
    qc.setQueryData(qk.flow("f1"), flowDetail([
      stageOf({ key: "a", status: "passed" }),
      stageOf({ key: "b", index: 2, status: "ready", form_fields: [numField({ default: 16 })], inputs: { chunk_size: 4 } }),
      stageOf({ key: "c", index: 3, status: "ready" }),
    ]));
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
      stageOf({ key: "c", index: 3, status: "locked" }),
    ]), qc);

    act(() => result.current.select("b"));
    expect(result.current.activeKey).toBe("b");

    spy.mockClear();
    act(() => result.current.onStreamDone("a", "passed", null));
    expect(result.current.activeKey).toBe("b");
    expect(result.current.values).toEqual({ chunk_size: 8 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("来源 key 与当前阶段一致时照常处理（守卫不能把正常回调一起拦掉）", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = hookOf(flowDetail([
      stageOf({ key: "a", status: "running" }),
      stageOf({ key: "b", index: 2, status: "ready" }),
    ]), qc);

    act(() => result.current.select("b"));
    spy.mockClear();
    act(() => result.current.onStreamDone("b", "failed", "端口 6443 不可达"));
    expect(result.current.activeKey).toBe("b");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
  });
});
