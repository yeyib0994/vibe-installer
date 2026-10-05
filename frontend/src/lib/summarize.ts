import type { MachineType, NodeSpec } from "../api/types";

export const groupNodes = (nodes: NodeSpec[]): Record<MachineType, NodeSpec[]> => ({
  physical: nodes.filter((x) => x.machine_type === "physical"),
  virtual: nodes.filter((x) => x.machine_type === "virtual"),
});
