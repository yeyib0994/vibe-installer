import { Link } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { StatusTag } from "../components/StatusTag";
import { Tag } from "../components/ui/Tag";
import { useAudit, useOverview } from "../hooks/queries";
import { fmtBytes, fmtTime } from "../lib/format";
import { AUDIT_CN, modeLabel, statusTone } from "../lib/labels";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-line bg-panel px-4 py-3.5 shadow-card">
      <div className="text-xs text-ink-mute">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-mute">{sub}</div>}
    </div>
  );
}

export default function Overview() {
  const { data: ov } = useOverview();
  const { data: audit } = useAudit(12);

  if (!ov) return <div className="text-sm text-ink-mute">加载总览…</div>;

  const running = ov.flows_by_status["running"] ?? 0;
  const failed = ov.flows_by_status["failed"] ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="安装环境"
          value={String(ov.environments)}
          sub={`${ov.nodes_total} 台节点 · 物理 ${ov.nodes_physical} / 虚拟 ${ov.nodes_virtual}`}
        />
        <Stat
          label="流程总数"
          value={String(ov.flows_total)}
          sub={`进行中 ${running} · 失败 ${failed}`}
        />
        <Stat label="安装包" value={String(ov.packages)} sub={fmtBytes(ov.packages_bytes)} />
        <Stat
          label="备份点"
          value={String(ov.backups)}
          sub={`可恢复 ${ov.backups_restorable} · ${fmtBytes(ov.backups_bytes)}`}
        />
      </div>

      <Card
        title="最近流程"
        actions={
          <Link to="/flows?new=1" className="text-xs font-medium text-brand hover:underline">
            新建流程
          </Link>
        }
      >
        <Table head={["流程", "模式", "环境", "进度", "状态", "更新时间"]}>
          {ov.recent_flows.length === 0 && (
            <tr>
              <Td colSpan={6}>
                <Empty>还没有流程，点击右上角「新建流程」</Empty>
              </Td>
            </tr>
          )}
          {ov.recent_flows.map((f) => (
            <Tr key={f.id}>
              <Td>
                <Link to={`/flows/${f.id}`} className="font-medium text-brand hover:underline">
                  {f.name}
                </Link>
              </Td>
              <Td className="text-ink-soft">{modeLabel(f.mode)}</Td>
              <Td className="text-ink-soft">{f.env_name || "—"}</Td>
              <Td className="font-mono text-xs">{f.progress.done}/{f.progress.total}</Td>
              <Td>
                <StatusTag kind="flow" value={f.status} />
              </Td>
              <Td className="text-xs text-ink-mute">{fmtTime(f.updated_at)}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Card title="操作审计" sub="最近 12 条">
        <Table head={["时间", "操作者", "动作", "对象", "结果"]}>
          {(audit ?? []).length === 0 && (
            <tr>
              <Td colSpan={5}>
                <Empty>暂无审计记录</Empty>
              </Td>
            </tr>
          )}
          {(audit ?? []).map((a) => (
            <Tr key={a.id}>
              <Td className="whitespace-nowrap text-xs text-ink-mute">{fmtTime(a.ts)}</Td>
              <Td className="text-ink-soft">{a.operator}</Td>
              <Td className="font-mono text-xs">{a.action}</Td>
              <Td className="font-mono text-xs text-ink-mute">{a.target}</Td>
              <Td>
                <Tag tone={statusTone(a.result)}>{AUDIT_CN[a.result] ?? a.result}</Tag>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
