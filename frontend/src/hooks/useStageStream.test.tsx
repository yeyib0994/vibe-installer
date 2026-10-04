import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../api/client";
import type { StageLogEvent } from "../api/endpoints";
import type { StepState, StepStatus } from "../api/types";
import { FakeEventSource, resetFakeES } from "../test/fakeEventSource";
import { toLogLines, useStageStream } from "./useStageStream";

/**
 * 事件形态全部取自 Java 真机：
 * - log：StageExecutor.java:134-141（type/level/message，message 内嵌 [HH:mm:ss] 前缀，ts 由 LogBus 补）
 * - step：StageExecutor.java:244-249（step 为 FlowStep 的 snake_case Map）
 * - stage_done：StageExecutor.java:229-234（stage/status/error，error 可为 null）
 * - close：ApiController.java:425-429（type/status，仅即时下发、不进 LogBus 历史）
 * 且服务端全部用 SseEmitter.event().data(...)（无名帧，ApiController.java:404），故一律走 onmessage 通道。
 */

const wrapperOf = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

const makeQc = () => new QueryClient({ defaultOptions: { queries: { retry: 0 } } });

const stepFixture = (status: StepStatus): StepState => ({
  id: "s0",
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
  it("四类事件经默认 message 通道全部落态；stage_done 与 close 均不 close()（I4），卸载才 close", () => {
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
    // I4：服务端发完 close 会自行结束流；此处 close() 会在控制台留下 ERR_ABORTED，E2E 必挂
    expect(es.closed).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("passed", null);

    act(() => es.emit({ type: "close", status: "passed" }));
    expect(es.closed).toBe(false);

    unmount();
    // 卸载时断流是必须的另一半
    expect(es.closed).toBe(true);
  });

  it("历史重放/断线重连不双打：重复 log 去重、step 幂等覆盖、stage_done 只触发一次 onDone", () => {
    const qc = makeQc();
    const onDone = vi.fn();
    const { result } = renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone }),
      { wrapper: wrapperOf(qc) },
    );
    const es = FakeEventSource.instances[0];

    // ApiController.java:410 每次 subscribe 先重放全量历史，浏览器重连后再来一遍 —— 同一事件会到两次
    act(() => es.emit(logEvent));
    act(() => es.emit(logEvent));
    expect(result.current.logs).toHaveLength(1);

    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("running") }));
    act(() => es.emit({ type: "step", stage: "env_precheck", step: stepFixture("done") }));
    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]?.status).toBe("done");

    act(() => es.emit(doneEvent));
    act(() => es.emit(doneEvent));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("无 EventSource 时轮询兜底刷新 flow", () => {
    vi.unstubAllGlobals();
    (globalThis as Record<string, unknown>).EventSource = undefined;
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(
      () => useStageStream("f1", "env_precheck", { enabled: true, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc) },
    );
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });
  });

  it("SSE onerror 后无条件降级轮询 flow；不 close 连接；卸载后定时器不泄漏", () => {
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
    // 错误 ≠ stage_done：不主动 close，浏览器自行重连
    expect(es.closed).toBe(false);

    spy.mockClear();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });

    unmount();
    spy.mockClear();
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
