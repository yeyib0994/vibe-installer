const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
  return `${s.replace(/\.0$/, "")} ${UNITS[i]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 后端 LocalDateTime 无时区后缀，补 Z 会错 8 小时，故按本地时间解析。 */
function parse(ts: string): Date {
  const [d, t] = ts.split("T");
  const [y, mo, day] = (d ?? "").split("-").map(Number);
  const [h, mi, s] = (t ?? "0").split(":").map(Number);
  return new Date(y ?? 1970, (mo ?? 1) - 1, day ?? 1, h ?? 0, mi ?? 0, s ?? 0);
}

export function fmtTime(ts?: string | null): string {
  if (!ts) return "—";
  const dt = parse(ts);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function fmtDate(ts?: string | null): string {
  if (!ts) return "—";
  const dt = parse(ts);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function fmtDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}
