import { useEffect, useRef, useState } from "react";
import type { LogLevel } from "../api/types";

/**
 * 深底终端配色：项目 design tokens 全部面向浅色控制台，tailwind.config.ts 与 index.css
 * 里没有适配暗色终端的令牌，故此处按旧版 LogConsole 保留任意值，不新增全局 token。
 * 四档与 StageExecutor.java 的 log(key,msg,level) 词表一致：info / ok / warn / error。
 */
const FG: Record<LogLevel, string> = {
  info: "text-[#c9d1d9]",
  ok: "text-[#7ee2a8]",
  warn: "text-[#ffd166]",
  error: "text-[#ff8a80]",
};

/** 老服务端的 log 事件可能带未知 level，落到 info 色而不是 undefined 丢色。 */
const fgClass = (level: string): string => (FG as Record<string, string>)[level] ?? FG.info;

/** 距底不足 24px 视为「已在读最新输出」，此时才继续跟随。 */
const NEAR_BOTTOM_PX = 24;

export interface LogLine {
  ts?: string;
  level: LogLevel;
  message: string;
}

export interface LogConsoleProps {
  lines: LogLine[];
  height?: number;
  /**
   * 零行时的占位句，由调用方按读取态给：读取在途与「确实读到空」是两句话，
   * 读取失败则不走这个分支（StagePanel 用 QueryError 呈现）。
   */
  emptyText?: string;
}

export function LogConsole({ lines, height = 300, emptyText = "等待执行输出…" }: LogConsoleProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [lines.length, stick]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setStick(el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX);
  };

  return (
    <pre
      ref={ref}
      onScroll={onScroll}
      style={{ height }}
      role="log"
      aria-live="polite"
      aria-label="执行日志"
      className="overflow-auto rounded-card border border-line bg-[#12151a] px-3 py-2.5 font-mono text-[11px] leading-5"
    >
      {lines.length === 0 ? (
        <span className="text-white/35">{emptyText}</span>
      ) : (
        lines.map((l, i) => (
          <div key={i} className={fgClass(l.level)}>
            {l.message}
          </div>
        ))
      )}
    </pre>
  );
}
