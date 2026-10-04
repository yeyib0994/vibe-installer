import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { StageRail } from "./StageRail";
import type { FlowStage } from "../api/types";

const st = (over: Partial<FlowStage>): FlowStage => ({
  key: "k", index: 0, title: "T", description: "", form_fields: [], inputs: {},
  required: true, status: "locked", steps: [], ...over,
});

describe("StageRail (I2)", () => {
  const stages = [
    st({ key: "a", index: 0, title: "环境登记", status: "passed" }),
    st({ key: "b", index: 1, title: "环境校验", status: "ready" }),
    st({ key: "c", index: 2, title: "上传安装包", status: "locked" }),
  ];

  it("locked 阶段不可选中，点击不触发 onSelect", async () => {
    const onSelect = vi.fn();
    render(<StageRail stages={stages} activeKey="a" onSelect={onSelect} />);
    await userEvent.click(screen.getByText(/上传安装包/));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("passed 阶段可回看", async () => {
    const onSelect = vi.fn();
    render(<StageRail stages={stages} activeKey="b" onSelect={onSelect} />);
    await userEvent.click(screen.getByText(/环境登记/));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("必经阶段标注「必经」，非必经标注「可跳过」", () => {
    render(
      <StageRail
        stages={[st({ key: "x", status: "ready", title: "回滚预案", required: false })]}
        activeKey="x"
        onSelect={() => {}}
      />
    );
    expect(screen.getByText(/可跳过/)).toBeInTheDocument();
  });

  it("必经阶段仅显示「必经」字样", () => {
    render(
      <StageRail
        stages={[st({ key: "y", status: "ready", title: "环境登记", required: true })]}
        activeKey="y"
        onSelect={() => {}}
      />
    );
    expect(screen.getByText(/必经/)).toHaveTextContent("待执行 · 必经");
    expect(screen.queryByText(/可跳过/)).not.toBeInTheDocument();
  });

  it("running/failed/skipped 阶段均可点，onSelect 收到对应 key", async () => {
    const onSelect = vi.fn();
    render(
      <StageRail
        stages={[
          st({ key: "r", index: 0, title: "执行中阶段", status: "running" }),
          st({ key: "f", index: 1, title: "失败阶段", status: "failed" }),
          st({ key: "s", index: 2, title: "跳过阶段", status: "skipped" }),
        ]}
        activeKey="r"
        onSelect={onSelect}
      />
    );
    await userEvent.click(screen.getByText(/失败阶段/));
    await userEvent.click(screen.getByText(/跳过阶段/));
    expect(onSelect).toHaveBeenNthCalledWith(1, "f");
    expect(onSelect).toHaveBeenNthCalledWith(2, "s");
  });

  it("locked 阶段渲染 disabled 按钮，其余按钮可交互", () => {
    render(<StageRail stages={stages} activeKey="b" onSelect={() => {}} />);
    const buttonOf = (title: RegExp) =>
      screen.getByText(title).closest("button");
    expect(buttonOf(/上传安装包/)).toBeDisabled();
    expect(buttonOf(/环境登记/)).toBeEnabled();
    expect(buttonOf(/环境校验/)).toBeEnabled();
  });

  it("按钮 title：locked 行提示「未解锁」，其余行显示各自的 description", () => {
    render(
      <StageRail
        stages={[
          st({ key: "a", index: 0, title: "环境登记", status: "passed", description: "环境登记说明" }),
          st({ key: "b", index: 1, title: "环境校验", status: "ready", description: "环境校验说明" }),
          st({ key: "c", index: 2, title: "上传安装包", status: "locked", description: "上传安装包说明" }),
        ]}
        activeKey="b"
        onSelect={() => {}}
      />
    );
    const titleOf = (t: RegExp) => screen.getByText(t).closest("button")?.getAttribute("title");
    // 可点行：title 就是本行自己的 description，不掺状态字样
    expect(titleOf(/环境登记/)).toBe("环境登记说明");
    expect(titleOf(/环境校验/)).toBe("环境校验说明");
    // locked 行：不显示 description，而是「未解锁：<STAGE_CN.locked>」提示（STAGE_CN.locked === "未解锁"）
    expect(titleOf(/上传安装包/)).toBe("未解锁：未解锁");
  });

  it("activeKey 命中行加边框高亮，未命中行不加", () => {
    render(<StageRail stages={stages} activeKey="b" onSelect={() => {}} />);
    const active = screen.getByText(/环境校验/).closest("button");
    const inactive = screen.getByText(/环境登记/).closest("button");
    expect(active).toHaveClass("border-brand");
    expect(inactive).not.toHaveClass("border-brand");
  });

  it("空 stages 不渲染任何按钮", () => {
    render(<StageRail stages={[]} activeKey="" onSelect={() => {}} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
