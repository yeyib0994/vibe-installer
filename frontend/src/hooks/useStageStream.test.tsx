import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../api/client";
import type { StageLogEvent } from "../api/endpoints";
import type { StepState, StepStatus } from "../api/types";
import { FakeEventSource, resetFakeES } from "../test/fakeEventSource";
import { toLogLines, useStageLogs, useStageStream } from "./useStageStream";

/**
 * 事件形态全部取自 Java 真机：
 * - log：StageExecutor.java:134-141（type/level/message，message 内嵌 [HH:mm:ss] 前缀，ts 由 LogBus 补）
 * - step：StageExecutor.java:244-249（step 为 FlowStep 的 snake_case Map）
 * - stage_done：StageExecutor.java:229-234（stage/status/error，error 可为 null）
 * - close：ApiController.java:426-434（type/status，仅即时下发、不进 LogBus 历史）
 * 建连重放的每一帧额外带 `replay: true`（ApiController.java:410-415）。
 * 服务端全部用 SseEmitter.event().data(...)（无名帧），故一律走 onmessage 通道。
 */

const wrapperOf = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

const makeQc = () => new QueryClient({ defaultOptions: { queries: { retry: 0 } } });

const stepFixture = (status: StepStatus, id = "s0"): StepState => ({
  id,
  index: 0,
  title: "连通性检查",
  detail: "",
  action: "check_ssh",
  args: {},
  status,
  output: "",
  error: null,
  duration_ms: 0,
});

const logEvent = {
  type: "log",
  level: "info",
  message: "[12:00:00] ━━━ 阶段「环境预检」开始 ━━━",
  ts: "2026-10-04T12:00:00",
};

const doneEvent = {
  type: "stage_done",
  stage: "env_precheck",
  status: "passed",
  error: null,
  ts: "2026-10-04T12:01:00",
};

const closeEvent = { type: "close", status: "passed" };

beforeEach(() => {
  resetFakeES();
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useStageStream", () => {
  it("四类事件经默认 message 通道全部落态；close 事件即断流，onDone 由实时 stage_done 触发一次", () => {
    const qc = makeQc();
    const onDone = vi.fn();
    const { result, unmount } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone }),
      { wrapper: wrapperOf(qc) },
    );

    const es = FakeEventSource.instances[0];
    // 校正 2：URL 必须由 apiUrl() 组装（SSE 不过 fetch，需自行带 VITE_API_BASE 前缀）
    expect(es.url).toBe(apiUrl("/api/flows/f1/stages/env_precheck/stream"));

    act(() => es.emit(logEvent));
    expect(result.current.logs).toEqual([
      { ts: "2026-10-04T12:00:00", level: "info", message: "[12:00:00] ━━━ 阶段「环境预检」开始 ━━━" },
    ]);
    expect(result.current.running).toBe(true);

    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("running") }));
    expect(result.current.steps[0]?.status).toBe("running");

    act(() => es.emit(doneEvent));
    expect(result.current.running).toBe(false);
    expect(result.current.error).toBe(null);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("env_precheck", "passed", null);
    // I4：stage_done 只置终态，断流必须等 close 帧——提前 close 会让浏览器重连并重放全量历史
    expect(es.closed).toBe(false);
    // 服务端 complete() 之后浏览器必然重连，所以收到 close 就要主动断开
    act(() => es.emit(closeEvent));
    expect(es.closed).toBe(true);

    unmount();
  });

  it("未知帧类型不断流：只有 close 帧能终止连接（契约校正 9）", () => {
    const qc = makeQc();
    const onDone = vi.fn();
    const { result, unmount } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    // 先发一帧真实 step 把 running 置真（logs 仍空）；否则未知帧若误置 terminal，
    // commit() 得到的 running=!terminal=false 与初值相同，断言会变得毫无区分度
    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("running") }));
    expect(result.current.running).toBe(true);
    expect(result.current.logs).toHaveLength(0);

    // 代理心跳注释被解析成对象、未来新增的事件类型、字段拼写错误都不能断流
    act(() => es.emit({ type: "heartbeat", note: "ping" }));
    expect(es.closed).toBe(false);
    expect(result.current.running).toBe(true);
    expect(result.current.logs).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();

    // 真正的 close 帧仍要照常终止
    act(() => es.emit(closeEvent));
    expect(result.current.running).toBe(false);
    expect(es.closed).toBe(true);
    unmount();
  });

  it("终态帧失效历史日志：面板改读 GET /logs 后必须重取，否则尾部日志丢失", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];
    const logsKey = { queryKey: ["flows", "f1", "stages", "env_precheck", "logs"] };

    // 运行中的 step 不重取历史：面板此时只读流，逐步骤重取会把 /logs 打成请求风暴
    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("done") }));
    expect(spy).not.toHaveBeenCalledWith(logsKey);

    // stage_done 一到，running 转 false、面板数据源切到历史；此刻不重取就停在旧快照上
    spy.mockClear();
    act(() => es.emit(doneEvent));
    expect(result.current.running).toBe(false);
    expect(spy).toHaveBeenCalledWith(logsKey);

    spy.mockClear();
    act(() => es.emit(closeEvent));
    expect(spy).toHaveBeenCalledWith(logsKey);
  });

  it("不按内容去重：同一秒同文案的两行都保留（StageExecutor 按行发事件 + 多节点同文案）", () => {
    const qc = makeQc();
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    const twin = { ...logEvent, message: "[12:00:02]   ✔ ctrl-01 10.0.0.11 可达", ts: "2026-10-04T12:00:02" };
    act(() => es.emit(twin));
    act(() => es.emit(twin));
    expect(result.current.logs).toHaveLength(2);
  });

  it("断线重连：onopen 重建缓冲区，重放帧恢复完整日志且不双打", () => {
    const qc = makeQc();
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    act(() => {
      es.emit({ ...logEvent, replay: true });
      es.emit({ ...logEvent, message: "[12:00:01] 第二行", replay: true });
      es.emit({ type: "step", stage: "env_precheck", step: stepFixture("running"), replay: true });
    });
    expect(result.current.logs).toHaveLength(2);
    expect(result.current.steps[0]?.status).toBe("running");

    // 浏览器自动重连：服务端重新重放同一段历史（这次包含第三行）
    act(() => es.reopen());
    expect(result.current.logs).toHaveLength(0);

    act(() => {
      es.emit({ ...logEvent, replay: true });
      es.emit({ ...logEvent, message: "[12:00:01] 第二行", replay: true });
      es.emit({ ...logEvent, message: "[12:00:02] 第三行", replay: true });
    });
    expect(result.current.logs.map((l) => l.message)).toEqual([
      "[12:00:00] ━━━ 阶段「环境预检」开始 ━━━",
      "[12:00:01] 第二行",
      "[12:00:02] 第三行",
    ]);

    act(() => es.emit({ ...logEvent, message: "[12:00:03] 实时行" }));
    expect(result.current.logs).toHaveLength(4);
    expect(result.current.logs[3]?.message).toBe("[12:00:03] 实时行");
  });

  it("step 同 id 幂等覆盖，不同 id 追加", () => {
    const qc = makeQc();
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("running") }));
    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("done") }));
    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]?.status).toBe("done");

    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("pending", "s1") }));
    expect(result.current.steps.map((s) => s.id)).toEqual(["s0", "s1"]);
  });

  it("重放的 stage_done（旧运行/刷新页面）不触发 onDone，但终态照常落定", () => {
    const qc = makeQc();
    const onDone = vi.fn();
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    act(() => es.emit({ ...doneEvent, replay: true }));
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.running).toBe(false);

    act(() => es.emit({ ...doneEvent, status: "failed", error: "端口不通", replay: true }));
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.error).toBe("端口不通");
  });

  it("实时 stage_done 重复到达只回调一次 onDone", () => {
    const qc = makeQc();
    const onDone = vi.fn();
    renderHook(() => useStageStream("f1", "env_precheck", { enabled: true, onDone }), {
      wrapper: wrapperOf(qc),
    });
    const es = FakeEventSource.instances[0];

    act(() => {
      es.emit(doneEvent);
      es.emit(doneEvent);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("阶段结束前 onerror → 降级轮询 flow；卸载后定时器不泄漏", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result, unmount } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    expect(result.current.degraded).toBe(false);
    act(() => es.fail());
    expect(result.current.degraded).toBe(true);
    // 错误 ≠ 终态：不主动 close，让浏览器自行重连
    expect(es.closed).toBe(false);

    spy.mockClear();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });

    unmount();
    // 卸载必须真的断开连接：留着不关就是泄漏一条在听的流（cleanup 里少一句 es.close() 也要能被抓住）
    expect(es.closed).toBe(true);
    spy.mockClear();
    act(() => {
      vi.advanceTimersByTime(4800);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("断线后重连成功：degraded 回落为 false，降级轮询一并停掉", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result, unmount } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    act(() => es.fail());
    expect(result.current.degraded).toBe(true);
    spy.mockClear();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });

    // 浏览器重连成功：主通道重新成为数据源，横幅与兜底轮询都得撤下，
    // 否则「已转轮询」会挂到阶段结束，且与实时流并行每 1.2s 打一次刷新
    spy.mockClear();
    act(() => es.reopen());
    expect(result.current.degraded).toBe(false);
    act(() => {
      vi.advanceTimersByTime(4800);
    });
    expect(spy).not.toHaveBeenCalled();

    unmount();
  });

  it("终态之后的 onerror 不再降级、不再轮询（服务端 complete 的副产物）", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    act(() => es.emit(closeEvent));
    spy.mockClear();
    act(() => es.fail());
    expect(result.current.degraded).toBe(false);

    act(() => {
      vi.advanceTimersByTime(4800);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("onDone/opts 引用变化不重启流：全程只有一个 EventSource 实例", () => {
    const qc = makeQc();
    const { rerender } = renderHook(
      ({ cb }: { cb: (status: string) => void }) =>
        useStageStream("f1", "env_precheck", { enabled: true, onDone: cb }),
      { wrapper: wrapperOf(qc), initialProps: { cb: vi.fn() } },
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    rerender({ cb: vi.fn() });
    rerender({ cb: vi.fn() });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(false);
  });

  it("切换 stageKey：旧连接被关闭、每 key 一条连接，新连接未产帧时返回空态", () => {
    const qc = makeQc();
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.emit(logEvent));
    expect(result.current.logs).toHaveLength(1);

    rerender({ key: "package_upload" });

    // 清理必须真的断开上一条流：不关就是同时挂着两条在听的连接
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("/stages/package_upload/stream");
    expect(FakeEventSource.instances[1].closed).toBe(false);
    // 新连接一帧未发（连 onopen 都没有），此时返回的只能是空态而不是上一阶段的日志
    expect(result.current).toEqual({
      logs: [],
      steps: [],
      running: false,
      error: null,
      degraded: false,
    });
  });

  it("切换 key 后旧流的 stage_done 仍带来源 key 回调，消费者据此忽略", () => {
    const qc = makeQc();
    const onDone = vi.fn();
    const { rerender } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true, onDone }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];

    rerender({ key: "package_upload" });
    expect(first.closed).toBe(true);

    // FakeEventSource 的 close() 只置标记、仍会派发已入队的帧，正好模拟「切换已提交、
    // 清理未跑完」这段窗口里到达的 A 阶段终态帧。onDone 的闭包此刻属于 B，
    // 所以回调必须把来源 key 一起交出去，否则 B 会被 A 的完成推进。
    act(() => first.emit(doneEvent));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("env_precheck", "passed", null);
  });

  it("enabled=false 时不建流、不轮询", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: false, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc) },
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(4800);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.current).toEqual({
      logs: [],
      steps: [],
      running: false,
      error: null,
      degraded: false,
    });
  });

  it("无 EventSource 时轮询兜底刷新 flow", () => {
    vi.unstubAllGlobals();
    (globalThis as Record<string, unknown>).EventSource = undefined;
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useStageStream("f1", "env_precheck", { enabled: true, onDone: vi.fn() }), {
      wrapper: wrapperOf(qc),
    });
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
  });
});

describe("useStageLogs", () => {
  it("flowId/stageKey 齐备才启用查询", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useStageLogs("f1", ""), { wrapper: wrapperOf(qc) });
    expect(result.current.isEnabled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("toLogLines", () => {
  it("只保留 /logs 历史（裸数组）中 type=log 的行，level 四档原样映射", () => {
    // 与 LogBus.history 落盘形态一致：log/step/stage_done 混在一个数组里，无 {events} 包装
    const events: StageLogEvent[] = [
      { type: "log", level: "info", message: "[12:00:00] ━━━ 阶段「环境预检」开始 ━━━", ts: "2026-10-04T12:00:00" },
      { type: "step", stage: "env_precheck", step: stepFixture("done"), ts: "2026-10-04T12:00:02" },
      { type: "log", level: "ok", message: "[12:00:03] ✔ 连通性检查 完成", ts: "2026-10-04T12:00:03" },
      { type: "log", level: "warn", message: "[12:00:04] NTP 偏移 1.2s", ts: "2026-10-04T12:00:04" },
      { type: "log", level: "error", message: "[12:00:05] ✘ 端口 6443 不可达", ts: "2026-10-04T12:00:05" },
      { type: "stage_done", stage: "env_precheck", status: "failed", error: "端口 6443 不可达", ts: "2026-10-04T12:00:06" },
    ];
    expect(toLogLines(events)).toEqual([
      { ts: "2026-10-04T12:00:00", level: "info", message: "[12:00:00] ━━━ 阶段「环境预检」开始 ━━━" },
      { ts: "2026-10-04T12:00:03", level: "ok", message: "[12:00:03] ✔ 连通性检查 完成" },
      { ts: "2026-10-04T12:00:04", level: "warn", message: "[12:00:04] NTP 偏移 1.2s" },
      { ts: "2026-10-04T12:00:05", level: "error", message: "[12:00:05] ✘ 端口 6443 不可达" },
    ]);
  });

  it("undefined / 空数组返回空列表", () => {
    expect(toLogLines(undefined)).toEqual([]);
    expect(toLogLines([])).toEqual([]);
  });
});
