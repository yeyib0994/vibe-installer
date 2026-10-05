import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryError } from "./QueryError";
import { ApiError } from "../../api/client";

describe("QueryError", () => {
  it("ApiError：原样端出后端消息", () => {
    render(<QueryError label="加载失败" error={new ApiError(500, "备份目录读取失败", [], {})} onRetry={vi.fn()} />);
    expect(screen.getByText("加载失败：备份目录读取失败")).toBeInTheDocument();
  });

  it("网络层 Error：端出浏览器消息", () => {
    render(<QueryError label="加载失败" error={new TypeError("Failed to fetch")} onRetry={vi.fn()} />);
    expect(screen.getByText("加载失败：Failed to fetch")).toBeInTheDocument();
  });

  it("没有可用消息（非 Error 抛出物）：退化为通用文案，不显示 undefined", () => {
    render(<QueryError label="加载失败" error={"oops"} onRetry={vi.fn()} />);
    expect(screen.getByText("加载失败：网络异常或后端未响应")).toBeInTheDocument();
  });

  it("重试：点击回调一次，retrying 期间禁用", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<QueryError label="加载失败" onRetry={onRetry} />);
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<QueryError label="加载失败" onRetry={onRetry} retrying />);
    expect(screen.getByRole("button", { name: "重试" })).toBeDisabled();
  });
});
