import type { ReactNode } from "react";

export interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  tight?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Card({ title, sub, actions, tight, children, className = "" }: CardProps) {
  return (
    <section className={`rounded-card border border-line bg-panel shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>}
            {sub && <p className="mt-0.5 text-xs text-ink-mute">{sub}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={tight ? "" : "p-4"}>{children}</div>
    </section>
  );
}
