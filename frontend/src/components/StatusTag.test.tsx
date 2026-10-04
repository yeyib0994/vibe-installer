import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusTag } from "./StatusTag";

describe("StatusTag", () => {
  it("阶段状态用中文标签与色调", () => {
    render(<StatusTag kind="stage" value="passed" />);
    expect(screen.getByText("已通过")).toBeInTheDocument();
  });
  it("流程状态", () => {
    render(<StatusTag kind="flow" value="succeeded" />);
    expect(screen.getByText("成功")).toBeInTheDocument();
  });
  it("未知值原样显示，不崩溃", () => {
    render(<StatusTag kind="flow" value="archived" />);
    expect(screen.getByText("archived")).toBeInTheDocument();
  });
});
