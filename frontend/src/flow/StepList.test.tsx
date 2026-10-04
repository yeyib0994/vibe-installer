import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepList } from "./StepList";
import type { StepState, StepStatus } from "../api/types";

// StepState 必填键多，工厂补缺省，用例里只写关心的键（与 FieldRenderer.test.tsx 同构）。
const mk = (over: Partial<StepState> = {}): StepState => ({
  id: over.id ?? "s1",
  index: 0,
  title: "分发安装包",
  detail: "",
  action: "package.distribute",
  args: {},
  status: "pending",
  output: "",
  duration_ms: 0,
  ...over,
});

const GLYPHS: Record<StepStatus, string> = {
  pending: "○", running: "◐", done: "✔", partial: "◑", failed: "✕", skipped: "–",
};
const CN: Record<StepStatus, string> = {
  pending: "待执行", running: "执行中", done: "已完成", partial: "部分完成", failed: "失败", skipped: "已跳过",
};
const TONE: Record<StepStatus, string> = {
  pending: "text-ink-mute", running: "text-brand", done: "text-ok",
  partial: "text-warn", failed: "text-danger", skipped: "text-ink-mute",
};

describe("StepList 状态表意", () => {
  it("六种 StepStatus 各自渲染字形、配色与中文状态", () => {
    const statuses = Object.keys(GLYPHS) as StepStatus[];
    render(<StepList steps={statuses.map((s, i) => mk({ id: `k-${s}`, status: s, index: i, title: `步骤${i}` }))} />);
    for (const s of statuses) {
      const glyph = screen.getByText(GLYPHS[s]);
      expect(glyph).toHaveClass(TONE[s]);
      expect(glyph).toHaveAttribute("title", CN[s]);
      expect(screen.getByText(CN[s])).toBeInTheDocument();
    }
  });

  it("序号取 index+1，绝不用数组下标当 React key", () => {
    const { container } = render(
      <StepList steps={[mk({ id: "a", index: 4, title: "校验版本" }), mk({ id: "b", index: 5, title: "滚动重启" })]} />
    );
    expect(screen.getByText("5. 校验版本")).toBeInTheDocument();
    expect(screen.getByText("6. 滚动重启")).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("running 显示执行中…，其余状态不显示", () => {
    render(<StepList steps={[mk({ id: "r", status: "running" }), mk({ id: "d", status: "done", index: 1, duration_ms: 65_000 })]} />);
    expect(screen.getByText("执行中…")).toBeInTheDocument();
    expect(screen.getByText("1m5s")).toBeInTheDocument();
  });

  it("终态 0 毫秒渲染 0s，未执行/跳过渲染破折号，老载荷缺字段也不出错", () => {
    render(
      <StepList
        steps={[
          mk({ id: "fast", status: "done", duration_ms: 0 }),
          mk({ id: "p", status: "pending", index: 1, duration_ms: 0 }),
          mk({ id: "sk", status: "skipped", index: 2, duration_ms: 0 }),
          mk({ id: "legacy", status: "failed", index: 3, duration_ms: undefined as unknown as number }),
        ]}
      />
    );
    expect(screen.getByText("0s")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(3);
  });
});

describe("StepList 可选区块", () => {
  it("detail / output / error 齐备时按序渲染", () => {
    render(<StepList steps={[mk({ detail: "向 3 台节点分发", output: "rsync ok\n耗时 12s", error: "节点 worker-03 超时" })]} />);
    expect(screen.getByText("向 3 台节点分发")).toBeInTheDocument();
    expect(screen.getByText(/rsync ok/)).toBeInTheDocument();
    expect(screen.getByText("节点 worker-03 超时")).toBeInTheDocument();
  });

  it("后端下发的空串与 null 不渲染任何占位区块", () => {
    render(<StepList steps={[mk({ detail: "", output: "", error: null })]} />);
    expect(screen.queryByText("向 3 台节点分发")).not.toBeInTheDocument();
    expect(document.querySelectorAll("pre")).toHaveLength(0);
  });

  it("空步骤列表回落到提示文案", () => {
    const { container } = render(<StepList steps={[]} />);
    expect(screen.getByText("本阶段没有编排步骤。")).toBeInTheDocument();
    expect(container.querySelector("li")).toBeNull();
  });
});
