import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StagePanel, type StagePanelProps } from "./StagePanel";
import { FakeEventSource, resetFakeES } from "../test/fakeEventSource";
import { json, makeQc } from "../test/fixtures";
import type { ReactElement, ReactNode } from "react";
import type { StageLogEvent } from "../api/endpoints";
import type { FlowStage, StepState } from "../api/types";

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

/** 只 stub 阶段历史日志：GET /logs 是裸数组（ApiController.java:401-404）。 */
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

/** 每个测试一套新 QueryClient。 */
function renderPanel(node: ReactNode) {
  render(<QueryClientProvider client={makeQc()}>{node}</QueryClientProvider>);
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

describe("StagePanel 历史日志的读取态", () => {
  it("读取失败：给后端原话与重试，不端出「等待执行输出…」的空控制台", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(503, { detail: "日志存储没应答" })));
    renderPanel(panel());

    expect(await screen.findByText("读取本阶段历史日志失败：日志存储没应答")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeEnabled();
    expect(screen.queryByText(/等待执行输出/)).toBeNull();
  });

  it("首次读取在途：控制台明说正在读取，而不是替后端断言「等待执行输出」", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderPanel(panel());

    expect(await screen.findByText("正在读取本阶段的历史日志…")).toBeInTheDocument();
    expect(screen.queryByText(/等待执行输出/)).toBeNull();
  });

  it("已经读到空才是「等待执行输出…」", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, [])));
    renderPanel(panel());

    expect(await screen.findByText("等待执行输出…")).toBeInTheDocument();
    expect(screen.queryByText(/正在读取本阶段的历史日志/)).toBeNull();
  });

  it("running 且流已有行时，流的输出就是数据源，历史读取失败不占面板", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(503, { detail: "日志存储没应答" })));
    renderPanel(panel({ stage: { ...stage, status: "running" } }));
    // 流还没重放到行：此刻确实没有任何日志来源，错误必须说出来
    expect(await screen.findByText("读取本阶段历史日志失败：日志存储没应答")).toBeInTheDocument();

    act(() => FakeEventSource.instances[0].emit({ type: "log", level: "info", message: STREAM, ts: "2026-10-04T12:00:01" }));
    expect(screen.getByText(STREAM)).toBeInTheDocument();
    expect(screen.queryByText(/读取本阶段历史日志失败/)).toBeNull();
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
