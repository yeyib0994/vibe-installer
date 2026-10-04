import { STAGE_CN } from "../lib/labels";
import type { FlowStage, StageStatus } from "../api/types";

const BADGE: Record<StageStatus, string> = {
  locked: "border-line bg-canvas text-ink-mute",
  ready: "border-brand bg-brand-soft text-brand",
  running: "border-brand bg-brand text-white",
  passed: "border-ok bg-ok/10 text-ok",
  failed: "border-danger bg-danger/10 text-danger",
  skipped: "border-line bg-canvas text-ink-mute",
};

const GLYPH: Record<StageStatus, string> = {
  locked: "🔒", ready: "◇", running: "◐", passed: "✔", failed: "✕", skipped: "–",
};

/** I2：可点性完全由后端 status 决定，不做前端推算。 */
const selectable = (s: StageStatus) => s !== "locked";

export interface StageRailProps {
  stages: FlowStage[];
  activeKey: string;
  onSelect: (key: string) => void;
}

export function StageRail({ stages, activeKey, onSelect }: StageRailProps) {
  return (
    <ol className="flex flex-col gap-1.5">
      {stages.map((s) => {
        const active = s.key === activeKey;
        const clickable = selectable(s.status);
        return (
          <li key={s.key}>
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onSelect(s.key)}
              title={clickable ? s.description : `未解锁：${STAGE_CN[s.status]}`}
              className={`flex w-full items-center gap-2.5 rounded-card border px-3 py-2.5 text-left transition-colors ${
                active ? "border-brand bg-panel shadow-card" : "border-transparent"
              } ${clickable ? "hover:border-line hover:bg-panel" : "cursor-not-allowed opacity-70"}`}
            >
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${BADGE[s.status]}`}>
                {GLYPH[s.status]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {s.index + 1}. {s.title}
                </span>
                <span className="mt-0.5 block text-[11px] text-ink-mute">
                  {STAGE_CN[s.status]}
                  {s.required ? " · 必经" : " · 可跳过"}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
