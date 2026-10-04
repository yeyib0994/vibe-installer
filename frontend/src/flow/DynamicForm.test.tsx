import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DynamicForm } from "./DynamicForm";
import type { FormField } from "../api/types";

/** 安装流程阶段 0「环境登记」的目录节选（Workflow.java:128-143）。 */
const baseDomain: FormField = { key: "base_domain", label: "基础域名", type: "text", required: false, placeholder: "", help: "用于生成各服务的访问域名，可留空", hint: "" };
const dns: FormField = { key: "dns_servers", label: "DNS 服务器", type: "textarea", required: false, placeholder: "每行一个，如 10.0.0.10", help: "", hint: "", multiline_list: true };
const controlCount: FormField = { key: "control_count", label: "控制节点数", type: "number", required: false, placeholder: "", help: "建议 3 或 5 台以保证高可用", hint: "", default: 3 };
const strict: FormField = { key: "strict_mode", label: "严格模式", type: "boolean", required: false, placeholder: "", help: "", hint: "" };
const roles: FormField = {
  key: "target_roles", label: "分发到哪些角色", type: "multiselect", required: true, placeholder: "", help: "", hint: "",
  options: [{ value: "control", label: "control" }, { value: "worker", label: "worker" }],
};
const phys: FormField = {
  key: "physical_nodes", label: "物理机列表", type: "node_table", required: false,
  placeholder: "逐台填写", help: "", hint: "",
  groups: [{ key: "physical_nodes", title: "物理机节点", fields: [{ key: "hostname", label: "主机名", width: 130 }, { key: "role", label: "角色", type: "role", width: 104 }] }],
};

const labelBox = (name: RegExp) => screen.getByRole("textbox", { name }).closest("label") as HTMLElement;

describe("DynamicForm", () => {
  it("无字段阶段给一行说明，不渲染任何控件", () => {
    render(<DynamicForm fields={[]} values={{}} onChange={vi.fn()} />);
    expect(screen.getByText("本阶段无需填写参数，直接执行即可。")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("按目录顺序渲染每个字段的标签", () => {
    render(<DynamicForm fields={[baseDomain, dns, controlCount, strict]} values={{}} onChange={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /基础域名/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /DNS 服务器/ })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /控制节点数/ })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /严格模式/ })).toBeInTheDocument();
  });

  it("onChange 带的是字段自身的 key，值形状交给控件", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DynamicForm fields={[baseDomain, controlCount, strict, roles]} values={{ base_domain: "saas.com", control_count: 3, strict_mode: false, target_roles: [] }} onChange={onChange} />);
    await user.type(screen.getByRole("textbox", { name: /基础域名/ }), "x");
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("checkbox", { name: "control" }));
    const keys = onChange.mock.calls.map((c) => c[0]);
    expect(keys).toContain("base_domain");
    expect(keys).toContain("strict_mode");
    expect(keys).toContain("target_roles");
    expect(onChange.mock.lastCall).toEqual(["target_roles", ["control"]]);
  });

  it("只为 form_fields 建模：values 里多出来的服务端键不产生控件，也不被回吐", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const values = { base_domain: "", _package_id: "pk1", _package_ids: ["pk1"], _distribution_id: "d1" };
    render(<DynamicForm fields={[baseDomain]} values={values} onChange={onChange} />);
    expect(screen.queryByRole("textbox", { name: /_package/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "a");
    expect(onChange.mock.calls.every((c) => c[0] === "base_domain")).toBe(true);
  });

  it("复合与长文本字段占满整行，普通字段不占", () => {
    const { container } = render(
      <DynamicForm fields={[baseDomain, dns, roles, phys]} values={{ dns_servers: ["/etc"], target_roles: [], physical_nodes: [] }} onChange={vi.fn()} />
    );
    expect(labelBox(/DNS 服务器/)).toHaveClass("col-span-full");
    expect(screen.getByRole("group", { name: /分发到哪些角色/ })).toHaveClass("col-span-full");
    expect(screen.getByRole("group", { name: "物理机列表" })).toHaveClass("col-span-full");
    expect(labelBox(/基础域名/)).not.toHaveClass("col-span-full");
    expect(container.querySelector(".grid.md\\:grid-cols-3")).not.toBeNull();
  });

  it("values 缺键时按空值渲染，不崩", () => {
    render(<DynamicForm fields={[phys, roles, strict]} values={{}} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "物理机列表" })).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("checkbox", { name: "control" })).not.toBeChecked();
  });

  it("disabled 一路传到矩阵的按钮与单元格", () => {
    render(
      <DynamicForm
        fields={[baseDomain, phys]}
        values={{ base_domain: "a", physical_nodes: [{ hostname: "h1" }] }}
        onChange={vi.fn()}
        disabled
      />
    );
    for (const el of screen.getAllByRole("textbox")) expect(el).toBeDisabled();
    for (const el of screen.getAllByRole("button")) expect(el).toBeDisabled();
  });
});
