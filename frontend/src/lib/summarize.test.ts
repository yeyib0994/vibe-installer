import { describe, it, expect } from "vitest";
import { groupNodes, roleBreakdown } from "./summarize";
import type { NodeSpec } from "../api/types";

const n = (over: Partial<NodeSpec>): NodeSpec => ({
  id: "x", hostname: "h", ip: "1.1.1.1", role: "worker", machine_type: "virtual",
  ssh_port: 22, ssh_user: "root", status: "unknown", precheck_issues: [], ...over,
});

describe("summarize", () => {
  it("按机器形态分组", () => {
    const g = groupNodes([n({ machine_type: "physical", id: "p" }), n({ id: "v" })]);
    expect(g.physical).toHaveLength(1);
    expect(g.virtual).toHaveLength(1);
  });
  it("角色分布按数量降序", () => {
    const r = roleBreakdown([n({ role: "worker" }), n({ role: "worker" }), n({ role: "control" })]);
    expect(r).toEqual([{ role: "worker", label: "工作节点", count: 2 }, { role: "control", label: "控制节点", count: 1 }]);
  });
  it("数量并列时按角色字典序，且与入参顺序无关", () => {
    const roles = ["worker", "database", "control"] as const;
    const forward = roleBreakdown(roles.map((role) => n({ role })));
    // 并列组内部同样按字典序：gateway < storage，与 worker(2) 的降序主键不冲突
    const tied = roleBreakdown([n({ role: "worker" }), n({ role: "worker" }), n({ role: "storage" }), n({ role: "gateway" })]);
    expect(tied.map((x) => x.role)).toEqual(["worker", "gateway", "storage"]);
    expect(forward).toEqual([
      { role: "control", label: "控制节点", count: 1 },
      { role: "database", label: "数据库节点", count: 1 },
      { role: "worker", label: "工作节点", count: 1 },
    ]);
    // 去掉次级排序就会失败：Map 顺序跟随入参，同一环境两次渲染可能给出不同顺序
    expect(roleBreakdown([...roles].reverse().map((role) => n({ role })))).toEqual(forward);
  });
});
