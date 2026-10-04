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
});
