import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { StatusTag } from "../components/StatusTag";
import { useStageLogs, useStageStream, toLogLines } from "../hooks/useStageStream";
import { DynamicForm } from "./DynamicForm";
import { LogConsole } from "./LogConsole";
import { StepList } from "./StepList";
import type { ReactNode } from "react";
import type { FlowStage, StageStatus, StepState } from "../api/types";

export interface StagePanelProps {
  flowId: string;
  stage: FlowStage;
  values: Record<string, unknown>;
  onChange: (k: string, v: unknown) => void;
  fieldErrors: string[];
  busy: boolean;
  onRun: () => void | Promise<boolean | void>;
  onSkip: () => void;
  onCancel: () => void;
  /** 流结束时回调：首参是这条流所属的阶段 key，据此忽略「上一个阶段」的在途终态帧。 */
  onStreamDone: (stageKey: string, status: StageStatus, error?: string | null) => void;
  /** 4.7 注入的上传区（仅 package_upload 阶段有值），原样插在表单与校验错误之间。 */
  uploadSlot?: ReactNode;
}

/**
 * 单个阶段的操作面板：参数表单 + 执行/跳过/终止 + 子步骤 + 日志。
 * 一切可执行性只看后端 stage.status（I2 的 panel 侧延伸），前端不推算门禁。
 */
export function StagePanel({
  flowId, stage, values, onChange, fieldErrors, busy,
  onRun, onSkip, onCancel, onStreamDone, uploadSlot,
}: StagePanelProps) {
  const running = stage.status === "running";
  const stream = useStageStream(flowId, stage.key, { enabled: running, onDone: onStreamDone });
  const { data: history } = useStageLogs(flowId, stage.key);
  // 降级后流不再是数据源：缓冲区停在断线那一刻，只有轮询到的历史与后端 steps 反映服务端现状
  // （日志恒取其一；mergeSteps(base, []) 原样返回 base，所以降级时步骤也退回后端状态）。
  const liveLogs = stream.degraded ? [] : stream.logs;
  const liveSteps = stream.degraded ? [] : stream.steps;
  const steps = running || liveSteps.length > 0 ? mergeSteps(stage.steps, liveSteps) : stage.steps;
  // 日志单一数据源（useStageStream 头注释的 T4.6 取数规则）：服务端每次订阅先重放全量历史，
  // 故 running 只渲染流的 logs；非 running 只渲染 GET /logs 历史。二者恒取其一，
  // 同时渲染会把每行打两遍。
  const logs = running && liveLogs.length > 0 ? liveLogs : toLogLines(history);
  const canRun = stage.status === "ready" || stage.status === "failed";

  return (
    <Card
      title={<span>{stage.index + 1}. {stage.title}</span>}
      sub={stage.description}
      actions={
        <div className="flex items-center gap-2">
          <StatusTag kind="stage" value={stage.status} />
          {running ? (
            <Button size="sm" variant="danger" onClick={onCancel}>终止</Button>
          ) : (
            <>
              {!stage.required && canRun && (
                <Button size="sm" variant="ghost" onClick={onSkip}>跳过此阶段</Button>
              )}
              <Button size="sm" onClick={onRun} disabled={!canRun || busy}>
                {busy ? "提交中…" : stage.status === "failed" ? "重试此阶段" : "校验并执行"}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {stage.error && (
          <div className="rounded-btn border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {stage.error}
          </div>
        )}

        {stage.form_fields.length > 0 && (
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-mute">阶段参数</h3>
            <DynamicForm fields={stage.form_fields} values={values} onChange={onChange} disabled={running} />
          </div>
        )}

        {uploadSlot}

        {fieldErrors.length > 0 && (
          <ul className="list-disc space-y-1 rounded-btn border border-warn/40 bg-warn/10 px-4 py-2.5 text-xs text-warn">
            {fieldErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-mute">执行步骤</h3>
          <StepList steps={steps} />
        </div>

        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-mute">执行日志</h3>
          {stream.degraded && (
            <p className="-mt-1.5 mb-2.5 text-[11px] text-warn">实时连接中断，已转轮询</p>
          )}
          <LogConsole lines={logs} />
        </div>
      </div>
    </Card>
  );
}

/** 流里的步骤状态覆盖 stage.steps 同 id 项（不追加），保证列表既全又新。 */
function mergeSteps(base: StepState[], live: StepState[]): StepState[] {
  if (live.length === 0) return base;
  const map = new Map<string, StepState>();
  for (const s of base) map.set(s.id, s);
  for (const s of live) map.set(s.id, s);
  return [...map.values()].sort((a, b) => a.index - b.index);
}
