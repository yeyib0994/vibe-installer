import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { NodeMatrixReadonly } from "./NodeMatrixReadonly";
import type { NodeSpec } from "../../api/types";

const vm: NodeSpec = {
  id: "n1", hostname: "worker-vm-01", ip: "10.10.1.21", role: "worker", machine_type: "virtual",
  ssh_port: 22, ssh_user: "root", status: "reachable", precheck_issues: [],
};

const phy: NodeSpec = {
  ...vm, id: "p1", hostname: "ctrl-phy-01", role: "control", machine_type: "physical",
  vendor: "Dell", model: "PowerEdge R750", idc: "AZ1-A", rack: "R01",
  nic_speed: "25GbE", raid_level: "RAID10", last_checked_at: "2026-10-04T09:30:00",
};

const tables = (container: HTMLElement) => Array.from(container.querySelectorAll("table"));
const headText = (table: HTMLTableElement) =>
  Array.from(table.querySelectorAll("th")).map((th) => th.textContent).join("|");
const rows = (table: HTMLTableElement) =>
  Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.children).map((td) => td.textContent)
  );

describe("NodeMatrixReadonly", () => {
  it("按机器形态分表，列序与行数各自正确", () => {
    const { container } = render(<NodeMatrixReadonly nodes={[phy, vm, { ...vm, id: "n2" }]} />);
    expect(screen.getByText("物理机节点 · 1 台")).toBeInTheDocument();
    expect(screen.getByText("虚拟机节点 · 2 台")).toBeInTheDocument();
    expect(tables(container)).toHaveLength(2);
    expect(headText(tables(container)[0])).toBe("主机名|IP|角色|厂商|型号|机房|机柜|网卡|RAID|状态|检测时间");
    expect(headText(tables(container)[1])).toBe("主机名|IP|角色|平台|vCPU|内存|磁盘|模板|状态|检测时间");
    expect(rows(tables(container)[0])).toHaveLength(1);
    expect(rows(tables(container)[1])).toHaveLength(2);
    expect(rows(tables(container)[1])[0]).toHaveLength(10);
    expect(screen.getByText("2026-10-04 09:30")).toBeInTheDocument();
  });

  it("角色列渲染中文标签而非裸枚举值", () => {
    render(<NodeMatrixReadonly nodes={[phy, vm]} />);
    expect(screen.getByText("控制节点")).toBeInTheDocument();
    expect(screen.getByText("工作节点")).toBeInTheDocument();
    expect(screen.queryByText("worker")).not.toBeInTheDocument();
    expect(screen.getAllByText("可达")).toHaveLength(2);
  });

  it("空节点列表只渲染占位文案", () => {
    const { container } = render(<NodeMatrixReadonly nodes={[]} />);
    expect(screen.getByText("该环境暂未登记节点")).toBeInTheDocument();
    expect(tables(container)).toHaveLength(0);
  });

  it("可选字段缺失渲染破折号，真实的 0 不被吞掉", () => {
    const { container } = render(
      <NodeMatrixReadonly nodes={[vm, { ...vm, id: "n0", vcpu: 0, memory_gb: 0, disk_gb: 0 }]} />
    );
    expect(screen.queryByText(/undefined|null|NaN/)).not.toBeInTheDocument();
    const row = rows(tables(container)[0]);
    // 平台 / vCPU / 内存 / 磁盘 / 模板 / 检测时间 共 6 处缺失
    expect(row[0].slice(3, 8)).toEqual(["—", "—", "—", "—", "—"]);
    expect(row[0][9]).toBe("—");
    expect(row[0][8]).toBe("可达");
    expect(row[1].slice(4, 7)).toEqual(["0", "0", "0"]);
  });
});
