import { describe, it, expect } from "vitest";
import { groupNodes } from "./summarize";
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
});
