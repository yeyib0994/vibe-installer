import { useCapabilities } from "../hooks/useCapabilities";

/** I1：只依据 effective_mode / force_mock，绝不回落到 ssh 字段。 */
export function ModeBadge() {
  const { data: caps, isError } = useCapabilities();
  if (!caps) {
    const text = isError ? "模式未知" : "检测中…";
    return (
      <span
        title={isError ? "无法读取 /api/capabilities，运行模式未知" : undefined}
        className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink-mute"
      >
        {text}
      </span>
    );
  }
  const real = caps.effective_mode === "real";
  const why = caps.force_mock ? "（已强制模拟）" : "";
  const title = real
    ? "节点操作调用系统 ssh/scp/rsync"
    : caps.mock_notice || "节点操作以模拟模式执行";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        real ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${real ? "bg-ok" : "bg-warn"}`} />
      {real ? "真实模式" : `模拟模式${why}`}
    </span>
  );
}
