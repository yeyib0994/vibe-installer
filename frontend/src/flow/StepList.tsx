import { Tag } from "../components/ui/Tag";
import { fmtDuration } from "../lib/format";
import { STEP_CN, statusTone } from "../lib/labels";
import type { StepState, StepStatus } from "../api/types";

/**
 * 词表与 StepStatus.java（pending/running/done/partial/failed/skipped）逐值对齐；
 * partial 由 StageExecutor.java:825 在分发作业「部分记录失败」时置位，必须有独立字形。
 */
const GLYPH: Record<StepStatus, string> = {
  pending: "○",
  running: "◐",
  done: "✔",
  partial: "◑",
  failed: "✕",
  skipped: "–",
};
const CLS: Record<StepStatus, string> = {
  pending: "text-ink-mute",
  running: "text-brand",
  done: "text-ok",
  partial: "text-warn",
  failed: "text-danger",
  skipped: "text-ink-mute",
};

const isTerminal = (s: StepStatus) => s === "done" || s === "partial" || s === "failed";

/**
 * FlowStep.durationMs 是 Java int，缺省 0：未执行与「快于一个时钟刻度就执行完」都是 0。
 * 故 0 毫秒按状态区分 —— 终态回 0s（确实跑过），未跑完/跳过回破折号；
 * nullish 只可能来自老载荷，交给 fmtDuration 兜底为破折号。
 */
function durationText(step: StepState): string {
  if (step.status === "running") return "执行中…";
  if (step.duration_ms === 0) return isTerminal(step.status) ? "0s" : "—";
  return fmtDuration(step.duration_ms);
}

export interface StepListProps {
  steps: StepState[];
}

/** 阶段子步骤的只读列表：字形 + 中文状态双通道表意，纯展示，不含交互。 */
export function StepList({ steps }: StepListProps) {
  if (steps.length === 0) return <p className="text-xs text-ink-mute">本阶段没有编排步骤。</p>;
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((s) => (
        <li key={s.id} className="rounded-card border border-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`font-mono text-sm ${CLS[s.status]}`} aria-hidden="true" title={STEP_CN[s.status]}>
              {GLYPH[s.status]}
            </span>
            <span className="text-xs font-medium text-ink">
              {s.index + 1}. {s.title}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <Tag tone={statusTone(s.status)}>{STEP_CN[s.status]}</Tag>
              <span className="font-mono text-[11px] text-ink-mute">{durationText(s)}</span>
            </span>
          </div>
          {s.detail && <p className="mt-1 pl-6 text-[11px] text-ink-mute">{s.detail}</p>}
          {s.output && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-btn bg-canvas px-2.5 py-2 font-mono text-[11px] leading-4 text-ink-soft">
              {s.output}
            </pre>
          )}
          {s.error && (
            <pre className="mt-2 whitespace-pre-wrap rounded-btn bg-danger/10 px-2.5 py-2 font-mono text-[11px] leading-4 text-danger">
              {s.error}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
