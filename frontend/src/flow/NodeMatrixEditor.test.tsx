import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NodeMatrixEditor } from "./NodeMatrixEditor";
import { ROLE_CN } from "../lib/labels";
import type { ColumnDef, FieldGroup, FormField, NodeRole } from "../api/types";

/** 列定义逐字段抄自后端 PHYSICAL_COLUMNS / VIRTUAL_COLUMNS（Workflow.java:105-122）。 */
const PHYS_COLS: ColumnDef[] = [
  { key: "hostname", label: "主机名", width: 130 },
  { key: "ip", label: "IP", width: 118 },
  { key: "role", label: "角色", type: "role", width: 104 },
  { key: "vendor", label: "厂商", width: 92 },
  { key: "model", label: "型号", width: 158 },
  { key: "idc", label: "机房", width: 104 },
  { key: "rack", label: "机柜", width: 78 },
  { key: "nic_speed", label: "网卡", width: 78 },
  { key: "raid_level", label: "RAID", width: 78 },
  { key: "ssh_key_path", label: "SSH 私钥", width: 168 },
];
const VIRT_COLS: ColumnDef[] = [
  { key: "hostname", label: "主机名", width: 130 },
  { key: "ip", label: "IP", width: 118 },
  { key: "role", label: "角色", type: "role", width: 104 },
  { key: "host_platform", label: "虚拟化平台", width: 160 },
  { key: "vcpu", label: "vCPU", type: "number", width: 68 },
  { key: "memory_gb", label: "内存 GB", type: "number", width: 80 },
  { key: "disk_gb", label: "磁盘 GB", type: "number", width: 80 },
  { key: "image_template", label: "镜像模板", width: 148 },
  { key: "ssh_key_path", label: "SSH 私钥", width: 168 },
];

const group = (key: string, title: string, fields: ColumnDef[]): FieldGroup => ({
  key, title, fields,
});

const physField = (over: Partial<FormField> = {}): FormField => ({
  key: "physical_nodes",
  label: "物理机列表",
  type: "node_table",
  required: false,
  placeholder: "",
  help: "逐台填写：主机名 / IP / 角色 / 品牌型号 / 机房机架 / 网卡 / RAID",
  hint: "逐台填写",
  default: [],
  groups: [group("physical_nodes", "物理机节点", PHYS_COLS)],
  ...over,
});
const virtField = (): FormField => ({
  key: "virtual_nodes",
  label: "虚拟机列表",
  type: "node_table",
  required: false,
  placeholder: "",
  help: "",
  hint: "",
  default: [],
  groups: [group("virtual_nodes", "虚拟机节点", VIRT_COLS)],
});

const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.lastCall?.[0] as Record<string, unknown>[];
const ROLES = Object.keys(ROLE_CN) as NodeRole[];

/** 值由外部持有的真实受控渲染，用来验证多次编辑与重渲染后的 DOM 复用。 */
function Box({ field, initial = [] }: { field: FormField; initial?: Record<string, unknown>[] }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>(initial);
  return (
    <>
      <NodeMatrixEditor field={field} value={rows} onChange={setRows} />
      <span data-testid="emitted">{JSON.stringify(rows)}</span>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId("emitted").textContent ?? "null") as Record<string, unknown>[];

describe("NodeMatrixEditor", () => {
  it("空矩阵显示占位文案，不渲染表格", () => {
    render(<NodeMatrixEditor field={physField()} value={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/暂无节点/)).toBeInTheDocument();
    expect(screen.getByText("物理机节点 · 0 台")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("列缺失时不渲染表格也不给添加按钮", () => {
    render(<NodeMatrixEditor field={physField({ groups: [] })} value={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/未下发该字段的列定义/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("表头按目录列序渲染，末列为删除", () => {
    render(<NodeMatrixEditor field={virtField()} value={[{ hostname: "vm1", role: "worker" }]} onChange={vi.fn()} />);
    const head = Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(head).toEqual(["主机名", "IP", "角色", "虚拟化平台", "vCPU", "内存 GB", "磁盘 GB", "镜像模板", "SSH 私钥", ""]);
  });

  it("添加一台：新行含全部列键、角色回退 worker、带稳定标识", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NodeMatrixEditor field={physField()} value={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "+ 添加一台" }));
    const rows = lastCall(onChange);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...PHYS_COLS.map((c) => c.key), "__id"].sort());
    expect(rows[0].role).toBe("worker");
    expect(rows[0].hostname).toBe("");
    expect(typeof rows[0].__id).toBe("string");
  });

  it("编辑单元格产出新数组新行，原数组与原行不被改写", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const rows = [
      { __id: "r1", hostname: "h1", ip: "10.0.0.1", role: "control" },
      { __id: "r2", hostname: "h2", ip: "10.0.0.2", role: "worker" },
    ];
    render(<NodeMatrixEditor field={physField()} value={rows} onChange={onChange} />);
    const hostInputs = screen.getAllByRole("textbox", { name: "主机名" });
    await user.type(hostInputs[1], "X");
    const next = lastCall(onChange);
    expect(next).not.toBe(rows);
    expect(next[1].hostname).toBe("h2X");
    expect(next[0]).toBe(rows[0]);
    expect(rows[1].hostname).toBe("h2");
  });

  it("删除一行：只剔除该行，其余按引用保留", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const rows = [
      { __id: "r1", hostname: "h1" },
      { __id: "r2", hostname: "h2" },
    ];
    render(<NodeMatrixEditor field={physField()} value={rows} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "删除第 1 台" }));
    expect(lastCall(onChange)).toEqual([rows[1]]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("删中间行后其余输入框沿用同一 DOM 节点（行标识稳定，焦点不跳）", async () => {
    const user = userEvent.setup();
    render(<Box field={physField()} />);
    await user.click(screen.getByRole("button", { name: "+ 添加一台" }));
    await user.click(screen.getByRole("button", { name: "+ 添加一台" }));
    const kept = screen.getAllByRole("textbox", { name: "IP" })[1];
    await user.type(kept, "10.0.0.9");
    await user.click(screen.getByRole("button", { name: "删除第 1 台" }));
    const after = screen.getByRole("textbox", { name: "IP" });
    expect(after).toHaveValue("10.0.0.9");
    expect(after).toBe(kept);
  });

  it("角色下拉只认 NodeRole 全集，改值写回枚举字面量", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NodeMatrixEditor field={physField()} value={[{ __id: "r1", hostname: "h1", role: "worker" }]} onChange={onChange} />);
    const roleSelect = screen.getByRole("combobox", { name: "角色" });
    expect(Array.from(roleSelect.querySelectorAll("option")).map((o) => o.value)).toEqual(ROLES);
    await user.selectOptions(roleSelect, "database");
    expect(lastCall(onChange)[0].role).toBe("database");
  });

  it("历史行的非法角色不被静默改写，作为独立选项如实展示", () => {
    render(<NodeMatrixEditor field={physField()} value={[{ __id: "r1", role: "" }]} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "角色" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "（未填写）" })).toHaveAttribute("value", "");
  });

  it("number 列用 spinbutton，值按字符串回传", async () => {
    const user = userEvent.setup();
    render(<Box field={virtField()} initial={[{ __id: "r1", vcpu: 16 }]} />);
    const el = screen.getByRole("spinbutton", { name: "vCPU" });
    expect(el).toHaveValue(16);
    await user.clear(el);
    await user.type(el, "8");
    expect(state()[0].vcpu).toBe("8");
  });

  it("物理机演示数据角色全为合法 NodeRole，且不含 \"db\"", async () => {
    const user = userEvent.setup();
    render(<Box field={physField()} />);
    await user.click(screen.getByRole("button", { name: "填充演示数据" }));
    const rows = state();
    expect(rows.map((r) => r.role)).toEqual(["control", "control", "control", "database"]);
    expect(rows.every((r) => ROLES.includes(r.role as NodeRole))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('"db"');
    expect(rows.every((r) => typeof r.__id === "string")).toBe(true);
    expect(screen.getByText("物理机节点 · 4 台")).toBeInTheDocument();
  });

  it("虚拟机演示数据覆盖 worker / gateway，列键齐全", async () => {
    const user = userEvent.setup();
    render(<Box field={virtField()} />);
    await user.click(screen.getByRole("button", { name: "填充演示数据" }));
    const rows = state();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.role)).toEqual(["worker", "worker", "worker", "worker", "gateway"]);
    expect(rows.every((r) => ROLES.includes(r.role as NodeRole))).toBe(true);
    expect(rows[0].host_platform).toBeTruthy();
    expect(screen.getAllByRole("textbox", { name: "主机名" })).toHaveLength(5);
    expect(screen.getAllByRole("spinbutton", { name: "内存 GB" }).map((el) => (el as HTMLInputElement).value)).toEqual(["64", "64", "64", "64", "32"]);
  });

  it("disabled 关闭全部输入框、下拉与三个按钮", () => {
    render(<NodeMatrixEditor field={physField()} value={[{ __id: "r1", hostname: "h1" }]} onChange={vi.fn()} disabled />);
    for (const el of screen.getAllByRole("textbox")) expect(el).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "角色" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ 添加一台" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "填充演示数据" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除第 1 台" })).toBeDisabled();
  });

  it("无 __id 的服务端已存行照样可编辑", async () => {
    const user = userEvent.setup();
    render(<Box field={physField()} initial={[{ hostname: "legacy", ip: "10.9.9.9" }]} />);
    expect(screen.getByRole("textbox", { name: "主机名" })).toHaveValue("legacy");
    await user.type(screen.getByRole("textbox", { name: "机柜" }), "R09");
    expect(state()[0].rack).toBe("R09");
    expect(state()[0].hostname).toBe("legacy");
  });
});
