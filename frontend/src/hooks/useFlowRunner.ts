import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { endpoints, qk } from "../api/endpoints";
import { useToast } from "../components/ToastProvider";
import { collect, initialValues } from "../flow/formValue";
import type { FlowDetail, FlowStage, StageStatus } from "../api/types";

const isDone = (s: StageStatus) => s === "passed" || s === "skipped";

/**
 * 激活阶段与其表单草稿同处一个 state：切换阶段必然重新播种，二者不可能背离
 * （两个阶段字段名完全相同是目录里的常态 —— operator / chunk_size ——，
 *  按 keys() 比对来判断「是不是同一份表单」会把 A 阶段的草稿带进 B 阶段）。
 */
interface Active {
  key: string;
  values: Record<string, unknown>;
}

const seedOf = (stages: FlowStage[], key: string): Record<string, unknown> => {
  const st = stages.find((s) => s.key === key);
  return st ? initialValues(st) : {};
};

/**
 * 向导页的执行编排：validate → submit inputs → run，外加 skip / cancel / 流结束推进。
 * 表单草稿的唯一写入点是 select（切阶段）与 run 成功后按实收 inputs 重播种。
 */
export function useFlowRunner(flow: FlowDetail) {
  const qc = useQueryClient();
  const toast = useToast();
  const [active, setActive] = useState<Active>(() => {
    const key = pickInitial(flow);
    return { key, values: seedOf(flow.stages, key) };
  });
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // flow.stages 为空时 stage 运行时为 undefined（后端目录保证非空，兜底渲染归 4.7 页面）；
  // 本 hook 自身不留崩溃路径，全部经 stageKey / 显式判空取值。
  const stage = useMemo(
    () => flow.stages.find((s) => s.key === active.key) ?? flow.stages[0],
    [flow, active.key],
  );
  const stageKey = stage ? stage.key : "";

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.flow(flow.id) });
    // 阶段转入非 running 态后，面板改读 GET /logs 历史（useStageStream 的取数规则）。
    // 该查询在流期间不会被任何事件刷新，不一起失效就会把刚跑完的日志退回挂载时的旧结果。
    if (stageKey) qc.invalidateQueries({ queryKey: qk.stageLogs(flow.id, stageKey) });
  }, [qc, flow.id, stageKey]);

  // 重新播种只认「阶段变了」这一个信号：flow 详情在有阶段执行时每 1.2s 轮询一次，
  // 每次都产出全新的 inputs 对象；若按 stage.inputs 引用变化来重置，操作员正在敲的字会被抹掉。
  const goTo = useCallback((key: string, stages: FlowStage[]) => {
    setActive({ key, values: seedOf(stages, key) });
    setFieldErrors([]);
  }, []);

  const select = useCallback(
    (key: string) => {
      // 点当前阶段（侧栏整行都可点）不算切换：不能丢弃正在写的草稿。
      if (key === active.key) return;
      goTo(key, flow.stages);
    },
    [active.key, flow.stages, goTo],
  );

  const setValue = useCallback((k: string, v: unknown) => {
    setActive((cur) => ({ ...cur, values: { ...cur.values, [k]: v } }));
    setFieldErrors([]);
  }, []);

  const run = useCallback(async () => {
    if (!stage) return false;
    const key = stage.key;
    setBusy(true);
    setFieldErrors([]);
    const inputs = collect(stage, active.values); // I3：{...stage.inputs, ...collected}
    try {
      const v = await endpoints.validateStage(flow.id, key, inputs);
      if (!v.valid) {
        setFieldErrors(v.errors);
        toast(v.errors[0] ?? "表单校验未通过", "warn");
        return false;
      }
      await endpoints.submitStageInputs(flow.id, key, inputs);
      await endpoints.runStage(flow.id, key, { operator: flow.operator || "admin" });
      // 提交成功：表单按实际被收下的那份 inputs 回显，所见即服务端所存（含服务端下划线键）。
      // 只在阶段未被中途切换时写入，否则会把 A 的实收值灌进 B 的表单。
      setActive((cur) => (cur.key === key ? { key, values: { ...inputs } } : cur));
      toast(`阶段「${stage.title}」开始执行`);
      refresh();
      return true;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.fieldErrors.length) setFieldErrors(e.fieldErrors);
        toast(e.message, "error");
      } else {
        toast("执行失败", "error");
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [flow, stage, active.values, toast, refresh]);

  const skip = useCallback(async () => {
    if (!stage) return;
    try {
      await endpoints.skipStage(flow.id, stage.key, flow.operator || "admin");
      toast(`阶段「${stage.title}」已跳过`);
      refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "跳过失败", "error");
    }
  }, [flow, stage, toast, refresh]);

  const cancel = useCallback(async () => {
    if (!stage) return;
    try {
      const r = await endpoints.cancelStage(flow.id, stage.key);
      toast(r.ok ? "已请求终止" : "当前阶段无法终止", r.ok ? "ok" : "warn");
      refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "终止失败", "error");
    }
  }, [flow.id, stage, toast, refresh]);

  const onStreamDone = useCallback(
    (key: string, status: StageStatus, error?: string | null) => {
      // 回调只在本阶段还是用户眼前这个时才成立：切阶段到旧流被关掉之间有窗口，
      // 那期间 doneRef 已经指向 B —— A 的终态帧不能给 B 弹「通过」、更不能把向导从 B 推进走。
      if (key !== active.key) return;
      if (!stage) return;
      if (status === "passed") toast(`阶段「${stage.title}」通过`);
      else if (status === "failed") toast(error ?? `阶段「${stage.title}」失败`, "error");
      // 推进目标只认查询缓存里的 flow：闭包中的 flow.stages 是本次渲染的快照，阶段刚结束时
      // 后端算好的解锁还没进来，据此推进会落到仍标着 running/locked 的旧状态。
      // 缓存里没有更新（或找不到下一个可执行阶段）就原地不动，让 refresh() 把新状态带回来。
      const fresh = qc.getQueryData<FlowDetail>(qk.flow(flow.id));
      if (fresh) {
        const idx = fresh.stages.findIndex((s) => s.key === stage.key);
        const next = idx < 0 ? undefined : fresh.stages.slice(idx + 1).find((s) => s.status === "ready" || s.status === "failed");
        if (next) goTo(next.key, fresh.stages);
      }
      refresh();
    },
    [qc, flow.id, stage, active.key, toast, goTo, refresh],
  );

  const nextReady = useMemo(() => {
    const idx = flow.stages.findIndex((s) => s.key === stageKey);
    if (idx < 0) return undefined;
    return flow.stages.slice(idx + 1).find((s) => s.status === "ready" || s.status === "failed");
  }, [flow.stages, stageKey]);

  return {
    stage,
    activeKey: active.key,
    select,
    values: active.values,
    setValue,
    fieldErrors,
    busy,
    run,
    skip,
    cancel,
    onStreamDone,
    nextReady,
  };
}

/**
 * 默认落点按 running > failed > ready 优先，最后一档兜底取「第一个还没结束的阶段」。
 * 前三档都落空时（例如流程被中止，剩下的只有 locked 与已通过项）兜底档可以返回一个 locked
 * 阶段的 key —— 这不是前端推算门禁：面板仍按后端 status 渲染成禁用态（canRun 只看 status，I2）。
 */
function pickInitial(flow: FlowDetail): string {
  const first =
    flow.stages.find((s) => s.status === "running") ??
    flow.stages.find((s) => s.status === "failed") ??
    flow.stages.find((s) => s.status === "ready") ??
    flow.stages.find((s) => !isDone(s.status)) ??
    flow.stages[0];
  return first?.key ?? "";
}
