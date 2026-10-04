import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogConsole } from "./LogConsole";
import type { LogLine } from "./LogConsole";
import type { LogLevel } from "../api/types";

const line = (message: string, level: LogLevel = "info"): LogLine => ({ level, message, ts: "2026-10-04T09:00:00" });

const pre = () => screen.getByRole("log") as HTMLPreElement;

/** jsdom 没有排版：滚动几何要逐元素打桩，否则 scrollHeight 恒为 0。 */
function stubScroll(el: HTMLElement, over: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const geo = { ...over };
  for (const key of ["scrollHeight", "clientHeight"] as const) {
    Object.defineProperty(el, key, { configurable: true, value: geo[key] });
  }
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => geo.scrollTop,
    set: (v: number) => {
      geo.scrollTop = v;
    },
  });
  return geo;
}

describe("LogConsole 着色", () => {
  it("四档 LogLevel 各有自己的颜色", () => {
    const cases: [LogLevel, string][] = [
      ["info", "text-[#c9d1d9]"],
      ["ok", "text-[#7ee2a8]"],
      ["warn", "text-[#ffd166]"],
      ["error", "text-[#ff8a80]"],
    ];
    render(<LogConsole lines={cases.map(([lv], i) => line(`第${i + 1}行`, lv))} />);
    cases.forEach(([, cls], i) => {
      const el = screen.getByText(`第${i + 1}行`);
      expect(el).toHaveClass(cls);
      for (const other of cases.map(([, c]) => c)) if (other !== cls) expect(el).not.toHaveClass(other);
      expect(el.textContent).toBe(`第${i + 1}行`);
    });
  });

  it("老服务端的未知档位退回 info 色而不是丢色", () => {
    render(<LogConsole lines={[line("未知档位", "trace" as unknown as LogLevel), line("正常档位")]} />);
    expect(screen.getByText("未知档位")).toHaveClass("text-[#c9d1d9]");
    expect(screen.getByText("正常档位")).toHaveClass("text-[#c9d1d9]");
  });

  it("空日志给提示，且带无障碍属性", () => {
    render(<LogConsole lines={[]} />);
    expect(screen.getByText("等待执行输出…")).toBeInTheDocument();
    expect(pre()).toHaveAttribute("aria-live", "polite");
    expect(pre()).toHaveAttribute("aria-label", "执行日志");
  });
});

describe("LogConsole 跟随底部", () => {
  it("新行到达时用户贴着底部，视口跟到最新", () => {
    const { rerender } = render(<LogConsole lines={[line("一")]} />);
    const geo = stubScroll(pre(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    rerender(<LogConsole lines={[line("一"), line("二"), line("三")]} />);
    expect(geo.scrollTop).toBe(1000);
  });

  it("用户往上翻看历史时，新行不再把视口拽回底部", () => {
    const { rerender } = render(<LogConsole lines={[line("一")]} />);
    const geo = stubScroll(pre(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 });
    fireEvent.scroll(pre());
    rerender(<LogConsole lines={[line("一"), line("二")]} />);
    expect(geo.scrollTop).toBe(100);

    geo.scrollTop = 900;
    fireEvent.scroll(pre());
    rerender(<LogConsole lines={[line("一"), line("二"), line("三")]} />);
    expect(geo.scrollTop).toBe(1000);
  });
});
