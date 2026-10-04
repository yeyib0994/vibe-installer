import { Table, Td, Tr } from "../ui/Table";
import { Tag } from "../ui/Tag";
import { StatusTag } from "../StatusTag";
import { Empty } from "../ui/Empty";
import { groupNodes } from "../../lib/summarize";
import { fmtTime } from "../../lib/format";
import { ROLE_CN } from "../../lib/labels";
import type { NodeRole, NodeSpec, NodeStatus } from "../../api/types";

const PHYS_HEAD = ["主机名", "IP", "角色", "厂商", "型号", "机房", "机柜", "网卡", "RAID", "状态", "检测时间"];
const VIRT_HEAD = ["主机名", "IP", "角色", "平台", "vCPU", "内存", "磁盘", "模板", "状态", "检测时间"];

const DASH = "—";

type Cell =
  | { kind: "mono"; value: string }
  | { kind: "spec"; value: string }
  | { kind: "role"; value: NodeRole }
  | { kind: "status"; value: NodeStatus };

const mono = (value: string): Cell => ({ kind: "mono", value });
const specText = (value?: string | null): Cell => ({ kind: "spec", value: value || DASH });
// 0 vCPU / 0 GB 是合法值，只能按 nullish 判断缺失，不能用 ||
const specNum = (value?: number | null): Cell =>
  ({ kind: "spec", value: value == null ? DASH : String(value) });

function cells(n: NodeSpec): Cell[] {
  const head: Cell[] = [mono(n.hostname), mono(n.ip), { kind: "role", value: n.role }];
  const tail: Cell[] = [{ kind: "status", value: n.status }, mono(fmtTime(n.last_checked_at))];
  return n.machine_type === "physical"
    ? [
        ...head,
        specText(n.vendor),
        specText(n.model),
        specText(n.idc),
        specText(n.rack),
        specText(n.nic_speed),
        specText(n.raid_level),
        ...tail,
      ]
    : [
        ...head,
        specText(n.host_platform),
        specNum(n.vcpu),
        specNum(n.memory_gb),
        specNum(n.disk_gb),
        specText(n.image_template),
        ...tail,
      ];
}

function view(cell: Cell) {
  if (cell.kind === "role") return <Tag tone="brand">{ROLE_CN[cell.value] ?? cell.value}</Tag>;
  if (cell.kind === "status") return <StatusTag kind="node" value={cell.value} />;
  if (cell.kind === "mono") return <span className="font-mono text-xs">{cell.value}</span>;
  return <span className="text-ink-soft">{cell.value}</span>;
}

export function NodeMatrixReadonly({ nodes }: { nodes: NodeSpec[] }) {
  const { physical, virtual } = groupNodes(nodes);
  if (nodes.length === 0) return <Empty>该环境暂未登记节点</Empty>;

  const rows = (list: NodeSpec[]) =>
    list.map((n) => (
      <Tr key={n.id}>
        {cells(n).map((c, i) => (
          <Td key={i}>{view(c)}</Td>
        ))}
      </Tr>
    ));

  return (
    <div className="flex flex-col gap-5">
      {physical.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold text-ink-soft">物理机节点 · {physical.length} 台</h4>
          <Table head={PHYS_HEAD}>{rows(physical)}</Table>
        </div>
      )}
      {virtual.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold text-ink-soft">虚拟机节点 · {virtual.length} 台</h4>
          <Table head={VIRT_HEAD}>{rows(virtual)}</Table>
        </div>
      )}
    </div>
  );
}
