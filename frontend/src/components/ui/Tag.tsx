import type { ReactNode } from "react";
import type { Tone } from "../../lib/labels";

const T: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  brand: "bg-brand/10 text-brand",
  purple: "bg-purple/10 text-purple",
  mute: "bg-line/70 text-ink-mute",
};

export function Tag({ tone = "mute", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${T[tone]}`}>
      {children}
    </span>
  );
}
