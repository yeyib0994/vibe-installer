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
  /**
   * 本次阶段真正完成时回调一次；重放帧（replay）与自动重连不会再触发。
   * 首参是**这条流所属的阶段 key**：切阶段的清理与帧到达之间有窗口，回调此刻消费的可能是另一个阶段，
   * 不带来源就会让 A 的完成去推进 B。
   */
  onDone?: (stageKey: string, status: StageStatus, error?: string | null) => void;
}

export interface StageStreamState {
  logs: LogLine[];
  steps: StepState[];
  running: boolean;
  /** stage_done 的 error 字段（StageExecutor.java:233，可为 null）。 */
  error: string | null;
  /** true = 阶段结束前 SSE 传输层出错，已降级为 qk.flow 轮询；重连成功后回落 false，主通道重新成为数据源。 */
  degraded: boolean;
}

const EMPTY: StageStreamState = { logs: [], steps: [], running: false, error: null, degraded: false };

/**
 * 阶段实时流：SSE 主通道 + 轮询兜底。
 *
 * 服务端契约（ApiController.java:399-452）：
 * - 建连时先重放 LogBus 历史，每帧标记 `replay: true`；随后的实时帧不带该标记。
 * - 阶段进入终态后由轮询线程下发 `{type:"close", status}`（不进历史），然后 complete()。
 *
 * 收到 close 必须主动 es.close()：否则浏览器在服务端正常结束后自动重连，每轮重连都重放全量历史，
 * onerror 还会把已成功的阶段标成 degraded。
 *
 * 日志不做内容去重：StageExecutor 按行发事件（:168-169）且多节点同文案（:497），ts 只到秒
 * （LogBus.java:20），按 ts|level|message 去重会真丢行。改为「每代连接重建缓冲区」——
 * onopen 时清空，重放帧自然重建本代完整日志，实时帧在其后追加。
 */
export function useStageStream(flowId: string, stageKey: string, opts: UseStageStreamOptions) {
  const qc = useQueryClient();
  const [state, setState] = useState<StageStreamState>(EMPTY);
  const activeKeyRef = useRef("");
  const doneRef = useRef(opts.onDone);
  doneRef.current = opts.onDone;
  const { enabled } = opts;

  useEffect(() => {
    if (!enabled || !flowId || !stageKey) {
      activeKeyRef.current = "";
      setState(EMPTY);
      return;
    }
    activeKeyRef.current = stageKey;
    setState(EMPTY);

    // 只在状态边界与轮询 tick 上刷新 flow 查询，逐条 log 失效会把详情打成请求风暴。
    const refreshFlow = () => qc.invalidateQueries({ queryKey: qk.flow(flowId) });
    // 终态一到，面板的数据源就从流切到 GET /logs 历史（StagePanel 的单源规则）：
    // 历史不一起失效就停在挂载时的旧快照上，最后几行（步骤输出 + 「阶段通过」）凭空消失。
    const refreshHistory = () => {
      refreshFlow();
      qc.invalidateQueries({ queryKey: qk.stageLogs(flowId, stageKey) });
    };

    let logs: LogLine[] = [];
    let steps = new Map<string, StepState>();
    let error: string | null = null;
    let terminal = false;
    let doneFired = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const commit = () => {
      setState((s) => ({ ...s, logs, steps: [...steps.values()], error, running: !terminal }));
    };

    const applyEvent = (d: StreamEvent) => {
      if (d.type === "log") {
        logs = [...logs, { ts: d.ts, level: d.level, message: d.message }];
        commit();
      } else if (d.type === "step") {
        steps.set(d.step.id, d.step);
        commit();
        refreshFlow();
      } else if (d.type === "stage_done") {
        error = d.error ?? null;
        terminal = true;
        commit();
        // 重放的 stage_done 属于上一次运行（或刷新页面时已完成），不能推进向导
        if (!d.replay && !doneFired) {
          doneFired = true;
          doneRef.current?.(stageKey, d.status, d.error ?? null);
        }
        refreshHistory();
      } else if (d.type === "close") {
        // 只有 close 帧能终止流（契约校正 9）：未知帧类型（代理心跳/未来事件/拼写错误）一律忽略，
        // 否则会误关连接触发浏览器重连、重放全量历史并把成功阶段错标为 degraded
        terminal = true;
        commit();
        es.close();
        refreshHistory();
      }
    };

    if (typeof EventSource === "undefined") {
      pollTimer = setInterval(refreshHistory, POLL_MS);
      return () => clearInterval(pollTimer);
    }

    const es = new EventSource(apiUrl(`/api/flows/${flowId}/stages/${stageKey}/stream`));
    es.onopen = () => {
      // 新连接（含异常重连）：重放帧会重建本代完整日志，缓冲区必须从零开始
      logs = [];
      steps = new Map();
      error = null;
      // 重连成功就回到主通道：降级标记与兜底轮询都得撤下。漏掉这一步的话
      // 「实时连接中断，已转轮询」会挂到阶段结束，还每 1.2s 与实时流并行刷新一次、永不停歇
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      setState((s) => (s.degraded ? { ...s, degraded: false } : s));
      if (!terminal) commit();
    };
    // 服务端所有帧都是 SseEmitter.event().data(...) 无名帧（ApiController.java:407/418/440），
    // 即默认 message 事件；再叠 addEventListener("message") 会同一事件收两遍。
    es.onmessage = (e) => {
      try {
        applyEvent(JSON.parse(String(e.data)) as StreamEvent);
      } catch {
        /* 非 JSON 帧（如代理注入的注释心跳）忽略 */
      }
    };
    es.onerror = () => {
      // 终态之后的 onerror 是服务端正常结束流的副产物：不降级、不再轮询
      if (terminal) return;
      if (pollTimer === undefined) {
        setState((s) => (s.degraded ? s : { ...s, degraded: true }));
        pollTimer = setInterval(refreshHistory, POLL_MS);
      }
    };

    return () => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      es.close();
    };
  }, [flowId, stageKey, enabled, qc]);

  // 换阶段的当次渲染先给空态：缓冲区与日志都属于上一个阶段，泄漏出去会串台
  return activeKeyRef.current === stageKey ? state : EMPTY;
}

/** 阶段历史日志（非 running 面板的数据源；SSE 启用期间不要用，避免与历史重放双打）。 */
export const useStageLogs = (flowId: string, stageKey: string) =>
  useQuery({
    queryKey: qk.stageLogs(flowId, stageKey),
    queryFn: () => endpoints.stageLogs(flowId, stageKey),
    enabled: Boolean(flowId && stageKey),
  });

/**
 * GET /logs 返回裸数组（ApiController.java:394-397，无 {events} 包装），
 * 元素与 SSE 同构、含 log/step/stage_done 混合事件且永不含 close —— 只取 type=log 的行。
 */
export function toLogLines(events?: StageLogEvent[]): LogLine[] {
  const out: LogLine[] = [];
  for (const e of events ?? []) {
    if (e.type === "log") out.push({ ts: e.ts, level: e.level, message: e.message });
  }
  return out;
}
