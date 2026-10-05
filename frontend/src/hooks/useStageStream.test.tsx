import { act, render, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../api/client";
import type { StageLogEvent } from "../api/endpoints";
import type { StepState, StepStatus } from "../api/types";
import { FakeEventSource, resetFakeES } from "../test/fakeEventSource";
import { makeQc, wrapperOf } from "../test/fixtures";
import { toLogLines, useStageLogs, useStageStream } from "./useStageStream";

/**
 * 事件形态全部取自 Java 真机：
 * - log：StageExecutor.java:134-141（type/level/message，message 内嵌 [HH:mm:ss] 前缀，ts 由 LogBus 补）
 * - step：StageExecutor.java:245-250（step 为 FlowStep 的 snake_case Map）
 * - stage_done：StageExecutor.java:230-235（stage/status/error，error 可为 null）
 * - close：ApiController.java:444-447（type/status，仅即时下发、不进 LogBus 历史），
 *   服务端发完这一帧才 break→detach→complete()（:448-455），所以 complete 落在客户端的下一个 error 上
 * 建连重放的每一帧额外带 `replay: true`（ApiController.java:420-426）。
 * 服务端全部用 SseEmitter.event().data(...)（无名帧），故一律走 onmessage 通道。
 */

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
  it("四类事件经默认 message 通道全部落态；close 只落终态、断流交给随后的 error，onDone 由实时 stage_done 触发一次", () => {
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
      { level: "info", message: "[12:00:00] ━━━ 阶段「环境预检」开始 ━━━" },
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
    act(() => es.emit(closeEvent));
    expect(result.current.running).toBe(false);
    // 但 close 帧自己也不断流：服务端是发完 close 才 complete() 的，在这一帧上 close()
    // 掐断的就是还没落地完的响应，控制台会留下 net::ERR_ABORTED
    expect(es.closed).toBe(false);
    // 响应走完了（浏览器随即要重连）：这才是断开的时候
    act(() => es.fail());
    expect(es.closed).toBe(true);
    expect(result.current.degraded).toBe(false);

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

    // 真正的 close 帧照常终止：终态落定，连接留给 complete() 之后的 error 断开
    act(() => es.emit(closeEvent));
    expect(result.current.running).toBe(false);
    expect(es.closed).toBe(false);
    act(() => es.fail());
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
    // 卸载必须真的断开连接：留着不关就是泄漏一条在听的流（cleanup 里少一句 es.close() 也要能被抓住）。
    // 断开推迟一个宏任务，所以先到点再断。
    act(() => {
      vi.advanceTimersByTime(1);
    });
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

  it("切换 stageKey：每 key 一条连接，旧流留给 close 帧收尾，新连接未产帧时返回空态", () => {
    const qc = makeQc();
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.emit(logEvent));
    expect(result.current.logs).toHaveLength(1);

    rerender({ key: "package_upload" });

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

    // I4：换阶段不能替上一条流收尾（向导就是在 stage_done 上推进的，此刻 close 还在路上），
    // 而它收到自己的 close + complete 后就得真的断开并把自己从会话表里摘掉，不能挂着
    act(() => first.emit(closeEvent));
    expect(first.closed).toBe(false);
    act(() => first.fail());
    expect(first.closed).toBe(true);
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

    // A 的流换走后仍在听（close 未到，I4），所以「切换已提交、A 的终态帧才到」这段窗口照常存在。
    // onDone 的闭包此刻属于 B，回调必须把来源 key 一起交出去，否则 B 会被 A 的完成推进。
    act(() => first.emit(doneEvent));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("env_precheck", "passed", null);
  });

  it("换流程：遗留连接真断（它重放的是另一条 flow 的日志，留着没有任何意义）", () => {
    const qc = makeQc();
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useStageStream(id, "env_precheck", { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { id: "f1" } },
    );
    const first = FakeEventSource.instances[0];

    rerender({ id: "f2" });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("/api/flows/f2/stages/env_precheck/stream");
  });

  it("enabled 落下不断流：缓冲先撤、连接留给 close 帧收尾（I4）", () => {
    const qc = makeQc();
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useStageStream("f1", "env_precheck", { enabled, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc), initialProps: { enabled: true } },
    );
    const es = FakeEventSource.instances[0];
    act(() => es.emit(logEvent));
    expect(result.current.logs).toHaveLength(1);

    // 真实时序：stage_done 一到就刷新 flow，轮询抢在服务端 close 帧（下一轮 ~300ms tick）之前
    // 把 stage.status 推到 passed → enabled 落下。此刻 abort 就是一条 net::ERR_ABORTED。
    rerender({ enabled: false });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es.closed).toBe(false);
    // 面板此刻的数据源是 GET /logs 历史，缓冲必须交出空态
    expect(result.current).toEqual({ logs: [], steps: [], running: false, error: null, degraded: false });

    act(() => es.emit(closeEvent));
    expect(es.closed).toBe(false);
    act(() => es.fail());
    expect(es.closed).toBe(true);
  });

  it("换阶段不断旧流：旧流仍会收到 close 并自行断开（I4）", () => {
    const qc = makeQc();
    const onDone = vi.fn();
    const { rerender } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true, onDone }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];

    // 向导在 stage_done 上就推进了：B 开始被观察时，A 的 close 帧还在路上
    act(() => first.emit(doneEvent));
    rerender({ key: "package_upload" });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(false);

    act(() => first.emit(closeEvent));
    expect(first.closed).toBe(false);
    act(() => first.fail());
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });

  it("enabled 落下前已降级：兜底轮询撤下，弃用连接上的后续错误不再开轮询", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useStageStream("f1", "env_precheck", { enabled, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc), initialProps: { enabled: true } },
    );
    const es = FakeEventSource.instances[0];

    act(() => es.fail());
    act(() => { vi.advanceTimersByTime(1200); });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });

    rerender({ enabled: false });
    spy.mockClear();
    act(() => { vi.advanceTimersByTime(4800); });
    expect(spy).not.toHaveBeenCalled();

    // 浏览器还在重连这条已被放弃的流：再出错既不能挂横幅也不能重开轮询
    act(() => es.fail());
    act(() => { vi.advanceTimersByTime(4800); });
    expect(spy).not.toHaveBeenCalled();
  });

  it("enabled 回来（同一阶段重试）：另起一条新流重放本轮历史，但旧流不 close（I4）", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useStageStream("f1", "env_precheck", { enabled, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc), initialProps: { enabled: true } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.emit(logEvent));

    rerender({ enabled: false });
    expect(first.closed).toBe(false);

    // 新一轮运行必须重放本轮历史：旧流的那块缓冲区属于上一轮，视图不能再续用它
    rerender({ enabled: true });
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1];
    expect(second.closed).toBe(false);
    expect(result.current.logs).toHaveLength(0);

    // 但旧流一条都不许 close：它可能还活着（上一轮的 close 帧仍在路上），掐断就是 net::ERR_ABORTED。
    // 它剩下的只是自己收尾——后续帧不再写视图、不再失效查询、不再回调 onDone
    act(() => first.emit(logEvent));
    act(() => first.emit(doneEvent));
    act(() => first.emit(closeEvent));
    expect(result.current.logs).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();

    // 旧流的 error 只用来把自己摘掉
    act(() => first.fail());
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it("A→B→A 切回：接管同一条连接，既不新建也不 close，缓冲区原样回来", () => {
    const qc = makeQc();
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.emit(logEvent));
    expect(result.current.logs).toHaveLength(1);

    rerender({ key: "package_upload" });
    expect(FakeEventSource.instances).toHaveLength(2);

    // 切回 A = 同一轮运行：adopt 必须接管原来那条流。
    // 新建一条并对旧的 close() 抢的是活流（I4），还要让服务端把全量历史重放第二遍。
    rerender({ key: "env_precheck" });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(false);
    expect(result.current.logs).toHaveLength(1);

    // 接管的还是那条连接：它的帧继续进当前视图
    act(() => first.emit({ ...logEvent, message: "[12:00:01] 第二行" }));
    expect(result.current.logs).toHaveLength(2);
    // B 那条流被静默后仍要把自己的收尾走完，不影响 A
    act(() => first.emit(closeEvent));
    expect(first.closed).toBe(false);
    act(() => first.fail());
    expect(first.closed).toBe(true);
  });

  it("A→B→A 且 A 在离开期间降级：切回来把兜底轮询与降级标记一起接回来", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.fail());
    expect(result.current.degraded).toBe(true);

    rerender({ key: "package_upload" });
    // 被换走的会话没资格驱动当前视图：兜底轮询撤下
    spy.mockClear();
    act(() => { vi.advanceTimersByTime(4800); });
    expect(spy).not.toHaveBeenCalled();

    rerender({ key: "env_precheck" });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(false);
    expect(result.current.degraded).toBe(true);
    act(() => { vi.advanceTimersByTime(1200); });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["flows", "detail", "f1"] });

    // 重连成功回到主通道：轮询撤下、横幅熄灭
    act(() => first.reopen());
    expect(result.current.degraded).toBe(false);
    spy.mockClear();
    act(() => { vi.advanceTimersByTime(4800); });
    expect(spy).not.toHaveBeenCalled();
  });

  it("StrictMode 双挂载：既不新建第二条流，也不把第一条掐在半路", () => {
    const qc = makeQc();
    const seen: Array<ReturnType<typeof useStageStream>> = [];
    function Viewer() {
      seen.push(useStageStream("f1", "env_precheck", { enabled: true }));
      return null;
    }
    // 必须用 render：main.tsx:10 的 StrictMode 就挂在根上，而 renderHook 的 callback
    // 只是被调用取返回值，复现不出这套 mount→unmount→mount
    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <Viewer />
        </QueryClientProvider>
      </StrictMode>
    );

    // enabled 从未落下 = 同一轮运行：第二次挂载必须接管第一条流。
    // 停掉重建就是 net::ERR_ABORTED，而 dev 模式每次进向导都会走这一步（I4）
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(false);

    act(() => FakeEventSource.instances[0].emit(logEvent));
    expect(seen[seen.length - 1].logs).toHaveLength(1);
  });

  it("卸载断开所有在听的流，包括已经换走阶段的那条", () => {
    const qc = makeQc();
    const { rerender, unmount } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];

    rerender({ key: "package_upload" });
    const second = FakeEventSource.instances[1];
    expect(first.closed).toBe(false);

    unmount();
    // 断开推迟一个宏任务（StrictMode 的重挂要在这一帧里取消它）：真实卸载则是到点就断
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
  });

  it("换阶段后旧流的帧不再进 state：A 的日志不会串到 B 的视图", () => {
    const qc = makeQc();
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.emit(logEvent));
    expect(result.current.logs).toHaveLength(1);

    rerender({ key: "package_upload" });
    act(() => first.emit({ ...logEvent, message: "[12:00:09] 迟到的 A 行" }));
    expect(result.current.logs).toHaveLength(0);
  });

  it("换阶段会放弃旧流：旧流随后断线既不挂横幅，也不留下没人撤的兜底轮询", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true, onDone: vi.fn() }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.emit({ type: "step", stage: "env_precheck", step: stepFixture("running") }));

    rerender({ key: "package_upload" });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(false);

    // A 的流换走后断了：面板在读 B，此时降级横幅与 1.2s 轮询都属于没人认领的残留
    spy.mockClear();
    act(() => first.fail());
    expect(result.current.degraded).toBe(false);
    act(() => { vi.advanceTimersByTime(4800); });
    expect(spy).not.toHaveBeenCalled();
  });

  it("旧流的 onerror/onopen 都无权动当前视图的降级横幅", () => {
    const qc = makeQc();
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useStageStream("f1", key, { enabled: true }),
      { wrapper: wrapperOf(qc), initialProps: { key: "env_precheck" } },
    );
    const first = FakeEventSource.instances[0];
    rerender({ key: "package_upload" });
    const second = FakeEventSource.instances[1];

    // 当前在看的 B 降级了：横幅属于 B
    act(() => second.fail());
    expect(result.current.degraded).toBe(true);

    // 被换走的 A 稍后重连成功，缓冲区照旧重建，但状态是 B 的
    act(() => first.reopen());
    expect(result.current.degraded).toBe(true);

    act(() => second.reopen());
    expect(result.current.degraded).toBe(false);
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
      { level: "info", message: "[12:00:00] ━━━ 阶段「环境预检」开始 ━━━" },
      { level: "ok", message: "[12:00:03] ✔ 连通性检查 完成" },
      { level: "warn", message: "[12:00:04] NTP 偏移 1.2s" },
      { level: "error", message: "[12:00:05] ✘ 端口 6443 不可达" },
    ]);
  });

  it("undefined / 空数组返回空列表", () => {
    expect(toLogLines(undefined)).toEqual([]);
    expect(toLogLines([])).toEqual([]);
  });
});
