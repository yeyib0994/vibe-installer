import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FieldRenderer } from "./FieldRenderer";
import { coerce } from "./formValue";
import type { FieldOption, FieldType, FormField } from "../api/types";

const OPTS: FieldOption[] = [
  { value: "control", label: "control" },
  { value: "worker", label: "worker" },
  { value: "database", label: "database" },
];

// FormField 必填键较多，用工厂补缺省，用例里只写关心的键（与 formValue.test.ts 同构）。
const mk = (type: FieldType, over: Partial<FormField> = {}): FormField => ({
  key: "f",
  label: "字段",
  type,
  required: false,
  placeholder: "",
  help: "",
  hint: "",
  ...over,
});

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.lastCall?.[0];

/** 真受控渲染：值回流后重渲染，用来验多选的状态与顺序。 */
function Box({ field, initial }: { field: FormField; initial: unknown }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <FieldRenderer field={field} value={v} onChange={setV} />
      <span data-testid="emitted">{JSON.stringify(v)}</span>
    </>
  );
}
const emitted = () => JSON.parse(screen.getByTestId("emitted").textContent ?? "null");

describe("FieldRenderer 单控件分支", () => {
  it("text：文本框，回传原始字符串", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FieldRenderer field={mk("text", { key: "ssh_user", label: "统一 SSH 用户" })} value="root" onChange={onChange} />);
    const el = screen.getByRole("textbox", { name: "统一 SSH 用户" });
    expect(el).toHaveValue("root");
    await user.type(el, "s");
    expect(last(onChange)).toBe("roots");
  });

  it("text 携带数组值（smoke_endpoints）时按逗号串接展示，绝不回写字符串", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const field = mk("text", { key: "smoke_endpoints", label: "冒烟测试接口（逗号分隔）", default: ["/healthz", "/api/v1/version"] });
    render(<FieldRenderer field={field} value={["/healthz", "/api/v1/version"]} onChange={onChange} />);
    expect(screen.getByRole("textbox", { name: "冒烟测试接口（逗号分隔）" })).toHaveValue("/healthz, /api/v1/version");
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("textbox"));
    expect(last(onChange)).toBe("");
    expect(coerce(field, ["/healthz", "/version"])).toEqual(["/healthz", "/version"]);
  });

  it("number：spinbutton，回传原始串（含空串），不做数值转换", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const field = mk("number", { key: "ssh_port", label: "SSH 端口" });
    render(<FieldRenderer field={field} value={22} onChange={onChange} />);
    const el = screen.getByRole("spinbutton", { name: "SSH 端口" });
    expect(el).toHaveValue(22);
    await user.clear(el);
    expect(last(onChange)).toBe("");
    expect(coerce(field, "")).toBe("");
  });

  it("select：下拉且回传字符串（后端以 s(...) 取串）", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const field = mk("select", {
      key: "mode", label: "传输方式",
      options: [{ value: "rsync", label: "rsync" }, { value: "scp", label: "scp" }],
    });
    render(<FieldRenderer field={field} value="rsync" onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "传输方式" }), "scp");
    expect(last(onChange)).toBe("scp");
    expect(typeof last(onChange)).toBe("string");
  });

  it("select 已存值不在候选里时补一个候选项，显示与提交保持一致", () => {
    const field = mk("select", { key: "mode", label: "传输方式", options: [{ value: "rsync", label: "rsync" }] });
    render(<FieldRenderer field={field} value="sftp" onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("sftp");
  });

  it("select 无候选（source_env_id 的空 List，Workflow.java:279）退化为可输入文本框", () => {
    const field = mk("select", { key: "source_env_id", label: "从已有环境导入", options: [] });
    render(<FieldRenderer field={field} value="" onChange={vi.fn()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "从已有环境导入" })).toBeInTheDocument();
  });

  it("boolean：role=switch 且回传真布尔", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FieldRenderer field={mk("boolean", { key: "strict_mode", label: "严格模式" })} value={false} onChange={onChange} />);
    const el = screen.getByRole("switch", { name: "严格模式" });
    expect(el).toHaveAttribute("aria-checked", "false");
    await user.click(el);
    expect(last(onChange)).toBe(true);
    render(<FieldRenderer field={mk("boolean", { key: "keep_backup", label: "保留备份" })} value="yes" onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "保留备份" }));
    expect(last(onChange)).toBe(false);
  });

  it("textarea + multiline_list：数组按行展示，回传用户原串交给 coerce 切分", async () => {
    const user = userEvent.setup();
    const field = mk("textarea", { key: "dns_servers", label: "DNS 服务器", multiline_list: true, placeholder: "每行一个，如 10.0.0.10" });
    render(<Box field={field} initial={["10.0.0.10", "10.0.0.11"]} />);
    const el = screen.getByRole("textbox", { name: "DNS 服务器" });
    expect(el).toHaveValue("10.0.0.10\n10.0.0.11");
    expect(el).toHaveAttribute("placeholder", "每行一个，如 10.0.0.10");
    await user.clear(el);
    expect(emitted()).toBe("");
    await user.type(el, "1.1.1.1\n\n8.8.8.8");
    expect(emitted()).toBe("1.1.1.1\n\n8.8.8.8");
    expect(coerce(field, emitted())).toEqual(["1.1.1.1", "8.8.8.8"]);
  });
});

describe("FieldRenderer multiselect", () => {
  const field = mk("multiselect", {
    key: "target_roles", label: "分发到哪些角色", required: true, options: OPTS,
    default: ["control", "worker"],
  });

  it("按数组标记选中态", () => {
    render(<FieldRenderer field={field} value={["control", "worker"]} onChange={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "control" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "worker" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "database" })).not.toBeChecked();
  });

  it("勾选/取消都回传字符串数组，且按候选顺序排列", async () => {
    const user = userEvent.setup();
    render(<Box field={field} initial={["worker"]} />);
    await user.click(screen.getByRole("checkbox", { name: "database" }));
    expect(emitted()).toEqual(["worker", "database"]);
    expect(screen.getByRole("checkbox", { name: "database" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "worker" }));
    expect(emitted()).toEqual(["database"]);
    expect(screen.getByRole("checkbox", { name: "worker" })).not.toBeChecked();
  });

  it("保留不在候选里的历史值，不被静默丢弃", async () => {
    const user = userEvent.setup();
    render(<Box field={field} initial={["legacy-role"]} />);
    await user.click(screen.getByRole("checkbox", { name: "control" }));
    expect(emitted()).toEqual(["control", "legacy-role"]);
  });

  it("服务端历史值可能是逗号串，照样识别为已选", async () => {
    const user = userEvent.setup();
    render(<Box field={field} initial="control，database" />);
    expect(screen.getByRole("checkbox", { name: "control" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "database" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "worker" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "worker" }));
    expect(emitted()).toEqual(["control", "worker", "database"]);
  });

  it("无候选时给一行提示而不是空块", () => {
    render(<FieldRenderer field={mk("multiselect", { label: "角色", options: [] })} value={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "角色" })).toBeInTheDocument();
    expect(screen.getByText("目录未下发可选项")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("disabled 关掉每个复选框", () => {
    render(<FieldRenderer field={field} value={[]} onChange={vi.fn()} disabled />);
    for (const el of screen.getAllByRole("checkbox")) expect(el).toBeDisabled();
  });
});

describe("FieldRenderer 复合与装饰", () => {
  it("node_table 不套 <label>，以 group + 可见标题命名", () => {
    const field = mk("node_table", {
      key: "physical_nodes", label: "物理机列表",
      groups: [{ key: "physical_nodes", title: "物理机节点", fields: [{ key: "hostname", label: "主机名", width: 130 }] }],
    });
    const { container } = render(<FieldRenderer field={field} value={[{ __id: "r1", hostname: "h1" }]} onChange={vi.fn()} />);
    expect(container.querySelector("label")).toBeNull();
    expect(screen.getByRole("group", { name: "物理机列表" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "主机名" })).toHaveValue("h1");
  });

  it("node_table 回传行对象数组", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const field = mk("node_table", {
      key: "virtual_nodes", label: "虚拟机列表",
      groups: [{ key: "virtual_nodes", title: "虚拟机节点", fields: [{ key: "hostname", label: "主机名", width: 130 }] }],
    });
    render(<FieldRenderer field={field} value={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "+ 添加一台" }));
    expect(Array.isArray(last(onChange))).toBe(true);
    expect(last(onChange)).toHaveLength(1);
  });

  it("脏值（非数组）按空矩阵渲染，不报错", () => {
    const field = mk("node_table", {
      key: "physical_nodes", label: "物理机列表",
      groups: [{ key: "physical_nodes", title: "物理机节点", fields: [{ key: "hostname", label: "主机名" }] }],
    });
    render(<FieldRenderer field={field} value="oops" onChange={vi.fn()} />);
    expect(screen.getByText(/暂无节点/)).toBeInTheDocument();
  });

  it("required 加红星，help 加提示，placeholder 上控件", () => {
    const field = mk("text", { key: "remote_dir", label: "节点目标目录", required: true, placeholder: "/opt/packages", help: "所有节点统一目录" });
    const { container } = render(<FieldRenderer field={field} value="" onChange={vi.fn()} />);
    expect(container.textContent).toContain("节点目标目录 *");
    expect(screen.getByText("*")).toHaveClass("text-danger");
    expect(screen.getByText("所有节点统一目录")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "/opt/packages");
  });

  it("help 为空时不渲染提示节点", () => {
    const { container } = render(<FieldRenderer field={mk("text", { label: "时区" })} value="" onChange={vi.fn()} />);
    expect(container.textContent).toBe("时区");
  });

  it("每种单控件类型都接受 disabled", () => {
    const cases: FormField[] = [
      mk("text", { label: "a1" }),
      mk("number", { label: "a2" }),
      mk("select", { label: "a3", options: OPTS }),
      mk("boolean", { label: "a4" }),
      mk("textarea", { label: "a5" }),
      mk("multiselect", { label: "a6", options: OPTS }),
      mk("node_table", { label: "a7", groups: [{ key: "a7", title: "t", fields: [{ key: "hostname", label: "主机名" }] }] }),
    ];
    for (const f of cases) {
      const { unmount } = render(<FieldRenderer field={f} value="" onChange={vi.fn()} disabled />);
      const controls = [
        ...screen.queryAllByRole("textbox"),
        ...screen.queryAllByRole("spinbutton"),
        ...screen.queryAllByRole("combobox"),
        ...screen.queryAllByRole("checkbox"),
        ...screen.queryAllByRole("switch"),
        ...screen.queryAllByRole("button"),
      ];
      expect(controls.length).toBeGreaterThan(0);
      for (const el of controls) expect(el).toBeDisabled();
      unmount();
    }
  });
});
