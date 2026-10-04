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
 * 一条已建立的会话：
 * - hush：放弃（清空归属、撤兜底轮询、不再挂降级横幅），连接留着等自己那句 close；
 * - adopt：重挂后接管仍然活着的那一条（同一轮运行），不接受则返回 false 让调用方另起；
 * - stop：真的断开连接。
 */
interface Session {
  hush: () => void;
  adopt: () => boolean;
  stop: () => void;
}

/** 会话归属目标（流程 + 阶段）：同一个 hook 可能同时挂着「正在看的」和「刚换走、还差一句再见的」。 */
const SEP = "\u0000";
const targetOf = (flowId: string, stageKey: string) => `${flowId}${SEP}${stageKey}`;

/**
 * 阶段实时流：SSE 主通道 + 轮询兜底。
 *
 * 服务端契约（ApiController.java:399-452）：
 * - 建连时先重放 LogBus 历史，每帧标记 `replay: true`；随后的实时帧不带该标记。
 * - 阶段进入终态后由轮询线程下发 `{type:"close", status}`（不进历史），然后 complete()。
 *
 * 收尾只认 close 帧，而 close 帧只落终态、不断流：服务端是发完 close 才 break→detach→complete() 的，
 * 在这一帧上 close() 掐断的是还没落地完的响应，控制台就留下 net::ERR_ABORTED（I4）。
 * 断流交给紧随其后的 onerror —— 那时响应已自己走完，关掉它只阻止浏览器自动重连与二次全量重放。
 *
 * close 帧之前谁都不能替这条流收尾：轮询到的 stage.status 与向导推进都比 close（最迟下一轮
 * ~300ms tick）先走一步，那时 abort 同样留下 ERR_ABORTED。所以连接由 controller 按目标持有，
 * 真断只有三种情况：流自己走完（close+error）、被放弃过又重开（新一轮运行）、卸载/换流程。
 * enabled 落下与换阶段只是「放弃」（缓冲清空、兜底轮询撤下），连接继续等自己那句再见；
 * 没被放弃过的重挂（StrictMode 的 mount→unmount→mount）则接管原连接，既不新建也不掐断。
 * 卸载的断开推迟一个宏任务，就是为了给这次重挂留出取消它的机会。
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
  const sessionsRef = useRef(new Map<string, Session>());
  const pendingStopRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { enabled } = opts;

  // 卸载：所有在听的流都撤下，包括已经换走阶段、还等着 close 帧的那条（页面都没了，再见也不必等）。
  // 断开推迟一个宏任务：StrictMode 开发模式会 mount→unmount→mount，同步断开正好掐在刚建好的流上，
  // 留下一句 net::ERR_ABORTED（I4）。重挂时这句 effect 会再跑一遍并把定时器取消掉，真卸载则到点就断。
  useEffect(() => {
    const sessions = sessionsRef.current;
    if (pendingStopRef.current !== undefined) {
      clearTimeout(pendingStopRef.current);
      pendingStopRef.current = undefined;
    }
    return () => {
      pendingStopRef.current = setTimeout(() => {
        pendingStopRef.current = undefined;
        for (const s of sessions.values()) s.stop();
        sessions.clear();
      }, 0);
    };
  }, []);

  // 换流程：遗留连接重放的是另一条 flow 的日志，帧与兜底轮询都再无意义，只能真断。
  // 用 effect 体而不是清理函数：清理拿到的是旧 flowId，要断的恰好属于它。
  useEffect(() => {
    const sessions = sessionsRef.current;
    const prefix = `${flowId}${SEP}`;
    for (const [target, s] of sessions) {
      if (!target.startsWith(prefix)) {
        s.stop();
        sessions.delete(target);
      }
    }
  }, [flowId]);

  useEffect(() => {
    const sessions = sessionsRef.current;
    const target = targetOf(flowId, stageKey);
    // 目标一换，上一条流就再也走不到「放弃」那一步（enabled 落下只查得到当前目标）：
    // 这里把不属于当前目标的会话一律收掉。缓冲区有 activeKeyRef 挡着，兜底轮询与降级标记可挡不住。
    for (const [t, s] of sessions) if (t !== target) s.hush();

    if (!enabled || !flowId || !stageKey) {
      activeKeyRef.current = "";
      setState(EMPTY);
      sessions.get(target)?.hush();
      return;
    }
    activeKeyRef.current = stageKey;
    setState(EMPTY);

    const existing = sessions.get(target);
    // 接管成功（enabled 从未落下 = 同一轮运行，例如 StrictMode 的重挂）：连接原样继续听，
    // 它新建时那句 close() 就是 net::ERR_ABORTED，而视图由 adopt 的 commit 如实补回
    if (existing?.adopt()) return;
    // 接管不了（已被放弃，那是新一轮运行）：旧连接必须真断，否则两轮的重放写进同一个缓冲区
    existing?.stop();

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
    let ended = false;
    let doneFired = false;
    let hushed = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    // 没有 EventSource 的环境（SSR/测试）只留轮询兜底，null 表示这条会话根本没有连接可断
    const es = typeof EventSource === "undefined" ? null : new EventSource(apiUrl(`/api/flows/${flowId}/stages/${stageKey}/stream`));

    const stopPoll = () => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const sess: Session = {
      hush: () => {
        hushed = true;
        stopPoll();
      },
      adopt: () => {
        // 放弃过的会话缓冲区属于上一轮运行，视图不能再续用它
        if (hushed) return false;
        patchDegraded(pollTimer !== undefined);
        commit();
        return true;
      },
      stop: () => {
        stopPoll();
        es?.close();
        if (sessions.get(target) === sess) sessions.delete(target);
      },
    };
    sessions.set(target, sess);

    const commit = () => {
      // 换阶段/放弃之后这条流不再是当前视图的数据源：它还得收 close 帧，但缓冲不再进 state，
      // 否则 A 迟到的日志会串进 B 的面板
      if (activeKeyRef.current !== stageKey) return;
      setState((s) => ({ ...s, logs, steps: [...steps.values()], error, running: !terminal }));
    };

    // 「实时连接中断，已转轮询」属于当前在看的那条流：被换走的会话既没资格点亮它，也没资格熄灭它
    const patchDegraded = (degraded: boolean) => {
      if (activeKeyRef.current !== stageKey) return;
      setState((s) => (s.degraded === degraded ? s : { ...s, degraded }));
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
        // 否则会把成功阶段错标成中断。
        // 但 close 帧不断流（I4）：服务端发完 close 才 break→detach→complete()（ApiController.java:441-449），
        // 在这一帧上 close() 抢的就是那句 complete()，浏览器留下的是 net::ERR_ABORTED 而不是干净收尾。
        // 真正的断开交给紧随其后的 onerror —— 那时响应已经自己走完了。
        terminal = true;
        ended = true;
        commit();
        refreshHistory();
      }
    };

    if (es === null) {
      pollTimer = setInterval(refreshHistory, POLL_MS);
      return;
    }

    es.onopen = () => {
      // 新连接（含异常重连）：重放帧会重建本代完整日志，缓冲区必须从零开始
      logs = [];
      steps = new Map();
      error = null;
      // 重连成功就回到主通道：降级标记与兜底轮询都得撤下。漏掉这一步的话
      // 「实时连接中断，已转轮询」会挂到阶段结束，还每 1.2s 与实时流并行刷新一次、永不停歇
      stopPoll();
      patchDegraded(false);
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
      // close 帧之后服务端就 complete()：这条 error 是「流自己走完了」的通知，必须在此断开，
      // 否则浏览器自动重连、每轮重连重放全量历史（响应已终结，此刻 close 不再产生 ERR_ABORTED）
      if (ended) {
        sess.stop();
        return;
      }
      // 终态之后、close 之前的 error 是真实断线：不降级也不轮询，等它自己重连把 close 补回来。
      // 已放弃（hushed）的流则直接断开——面板改读历史了，留着重连只会把全量重放打进幽灵缓冲区。
      if (terminal) return;
      if (hushed) {
        sess.stop();
        return;
      }
      if (pollTimer === undefined) {
        patchDegraded(true);
        pollTimer = setInterval(refreshHistory, POLL_MS);
      }
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
