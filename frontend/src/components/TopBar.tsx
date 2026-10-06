import { NavLink } from "react-router-dom";
import { ModeBadge } from "./ModeBadge";

const TABS = [
  { to: "/", label: "总览", end: true },
  { to: "/envs", label: "环境" },
  { to: "/flows", label: "流程" },
  { to: "/packages", label: "安装包" },
  { to: "/backups", label: "备份" },
];

export function TopBar() {
  return (
    <header className="sticky top-0 z-40 flex items-center gap-6 border-b border-line bg-panel px-6 py-3">
      <div className="flex items-center gap-2.5">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
          <rect x="1" y="1" width="24" height="24" rx="6" fill="#2563eb" />
          <path d="M7 16.5l4-7 4 7" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="18.5" cy="8.5" r="1.8" fill="#fff" />
        </svg>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink">ShipDesk Console</div>
          <div className="text-[11px] text-ink-mute">安装 / 升级 流程编排</div>
        </div>
      </div>
      <nav className="flex flex-1 items-center gap-1">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `rounded-btn px-3 py-1.5 text-sm transition-colors ${
                isActive ? "bg-brand-soft font-semibold text-brand" : "text-ink-soft hover:text-ink"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <ModeBadge />
    </header>
  );
}
