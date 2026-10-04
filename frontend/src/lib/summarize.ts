import type { MachineType, NodeRole, NodeSpec } from "../api/types";
import { ROLE_CN } from "./labels";

export const groupNodes = (nodes: NodeSpec[]): Record<MachineType, NodeSpec[]> => ({
  physical: nodes.filter((x) => x.machine_type === "physical"),
  virtual: nodes.filter((x) => x.machine_type === "virtual"),
});

export interface RoleCount {
  role: NodeRole;
  label: string;
  count: number;
}

export function roleBreakdown(nodes: NodeSpec[]): RoleCount[] {
  const m = new Map<NodeRole, number>();
  for (const x of nodes) m.set(x.role, (m.get(x.role) ?? 0) + 1);
  return [...m.entries()]
    // 数量相同时按角色字典序，避免不同入参顺序导致同一环境每次渲染顺序不同
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([role, count]) => ({ role, label: ROLE_CN[role], count }));
}
