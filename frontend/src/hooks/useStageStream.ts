import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "../api/client";
import { endpoints, qk } from "../api/endpoints";
import type { StageLogEvent } from "../api/endpoints";
import type { LogLine } from "../flow/LogConsole";
import type { StageStatus, StepState, StreamEvent } from "../api/types";

const POLL_MS = 1_200;

export interface UseStageStreamOptions {
  enabled: boolean;
  /** 仅在本连接首次收到（去重后）stage_done 时回调一次；历史重放/重连不会再触发。 */
  onDone?: (status: StageStatus, error?: string | null) => void;
}

export interface StageStreamState {
  logs: LogLine[];
  steps: StepState[];
  /**
   * 由事件推断：log/step 置 true（服务端每次 subscribe 先重放历史，StageExecutor 起跑即写开始行，
   * 故刷新页面/中途挂载同样能被 seed）；stage_done 与 close 置 false。
   */
  running: boolean;
  /** stage_done 的 error 字段（StageExecutor.java:233，可为 null）。 */
  error: string | null;
  /** true = SSE 传输层出错、已降级为 qk.flow 轮询；T4.6 可据此显示「实时连接中断，已转轮询」。 */
  degraded: boolean;
}

const EMPTY: StageStreamState = { logs: [], steps: [], running: false, error: null, degraded: false };

/**
 * 阶段实时流：SSE 主通道 + 轮询兜底。
 *
 * 不变量 I4：收到 stage_done / close 事件后绝不调用 es.close()。服务端（ApiController.java:418-437）
 * 发完 close 会 emitter.complete() 自行结束流；客户端提前 abort 会在控制台留下 net::ERR_ABORTED，
 * T7.x Playwright 对控制台错误零容忍。只有卸载才 close()。
 *
 * 双打防护（校正 3）：ApiController.java:410 每次订阅先重放 LogBus 全量历史，浏览器在流被服务端
 * 结束后又会自动重连、再收一遍。这里以 ts|level|message 为稳定键在连接内去重。
 * 取舍：同一秒内 level 与全文完全相同的两条真重复行会被合并 —— message 内嵌 [HH:mm:ss] 前缀
 * （StageExecutor.java:135），除此之外没有更稳定的键可用。
 *
 * T4.6 取数规则：running 时用本 hooks.logs（已含历史重放）；非 running 用 useStageLogs +
 * toLogLines，二者不可同时渲染，否则与 SSE 历史重放叠加双打。
 */
export function useStageStream(flowId: string, stageKey: string, opts: UseStageStreamOptions) {
  const qc = useQueryClient();
  const [state, setState] = useState<StageStreamState>(EMPTY);
  const doneRef = useRef(opts.onDone);
  doneRef.current = opts.onDone;
  const { enabled } = opts;

  useEffect(() => {
    setState(EMPTY);
    if (!enabled || !flowId || !stageKey) return;

    // 只在 step/stage_done/close 这类状态边界与轮询 tick 上刷新 flow 查询，
    // 不逐条 log 失效 —— 否则密集日志会把 flow 详情打成请求风暴。
    const refreshFlow = () => qc.invalidateQueries({ queryKey: qk.flow(flowId) });

    const seen = new Set<string>();

    const applyEvent = (d: StreamEvent) => {
      if (d.type === "log") {
        const key = `log|${d.ts}|${d.level}|${d.message}`;
        if (seen.has(key)) return;
        seen.add(key);
        setState((s) => ({ ...s, running: true, logs: [...s.logs, { ts: d.ts, level: d.level, message: d.message }] }));
      } else if (d.type === "step") {
        setState((s) => {
          const idx = s.steps.findIndex((x) => x.id === d.step.id);
          const steps = idx < 0 ? [...s.steps, d.step] : s.steps.map((x, i) => (i === idx ? d.step : x));
          return { ...s, running: true, steps };
        });
        refreshFlow();
      } else if (d.type === "stage_done") {
        const key = `done|${d.ts ?? ""}|${d.status}`;
        const firstTime = !seen.has(key);
        seen.add(key);
        setState((s) => ({ ...s, running: false, error: d.error ?? null }));
        if (firstTime) doneRef.current?.(d.status, d.error ?? null);
        refreshFlow();
      } else {
        // {type:"close", status}：控制器后台线程在终态后即时下发（不进 LogBus 历史）。
        // 见 I4：此处不 close()，服务端随即自行结束流。
        setState((s) => (s.running ? { ...s, running: false } : s));
        refreshFlow();
      }
    };

    if (typeof EventSource === "undefined") {
      const t = setInterval(refreshFlow, POLL_MS);
      return () => clearInterval(t);
    }

    const es = new EventSource(apiUrl(`/api/flows/${flowId}/stages/${stageKey}/stream`));
    // 服务端所有帧都是 SseEmitter.event().data(...)，从不 .name()（ApiController.java:404/411/429），
    // 即默认 message 事件，onmessage 单通道即可收齐四类 type；再叠 addEventListener("message")
    // 会同一事件收两遍。
    es.onmessage = (e) => {
      try {
        applyEvent(JSON.parse(String(e.data)) as StreamEvent);
      } catch {
        /* 非 JSON 帧（如代理注入的注释心跳）忽略 */
      }
    };

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const degradeToPolling = () => {
      // onerror 后不看 readyState：计划案只 gating CONNECTING 会漏掉 CLOSED（代理杀流/服务端拒绝），
      // 面板会永久冻结；降级轮询无条件启动且幂等。
      if (pollTimer === undefined) {
        setState((s) => (s.degraded ? s : { ...s, degraded: true }));
        pollTimer = setInterval(refreshFlow, POLL_MS);
      }
      // 同样不 es.close()：浏览器对 CONNECTING/CLOSED 重试期 close() 可留下 ERR_ABORTED（I4）。
    };
    es.onerror = degradeToPolling;

    return () => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      // 卸载断流是必须的（离开页面不能留悬挂连接）；这与 I4 不冲突 —— I4 约束的是收到
      // stage_done/close 后在组件内主动关闭。
      es.close();
    };
  }, [flowId, stageKey, enabled, qc]);

  return state;
}

/** 阶段历史日志（非 running 面板的数据源；SSE 启用期间不要用，避免与历史重放双打）。 */
export const useStageLogs = (flowId: string, stageKey: string) =>
  useQuery({
    queryKey: qk.stageLogs(flowId, stageKey),
    queryFn: () => endpoints.stageLogs(flowId, stageKey),
    enabled: Boolean(flowId && stageKey),
  });

/**
 * GET /logs 返回裸数组（ApiController.java:393-396，无 {events} 包装），
 * 元素与 SSE 同构、含 log/step/stage_done 混合事件且永不含 close —— 只取 type=log 的行。
 */
export function toLogLines(events?: StageLogEvent[]): LogLine[] {
  const out: LogLine[] = [];
  for (const e of events ?? []) {
    if (e.type === "log") out.push({ ts: e.ts, level: e.level, message: e.message });
  }
  return out;
}
