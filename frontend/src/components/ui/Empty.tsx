import type { ReactNode } from "react";

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-mute">{children}</div>;
}
