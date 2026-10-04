import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { StatusTag } from "../components/StatusTag";
import { NewFlowDialog } from "../components/flow/NewFlowDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { useDeleteFlow, useFlows } from "../hooks/queries";
import { fmtDate, fmtTime } from "../lib/format";
import { modeLabel } from "../lib/labels";
import type { FlowMode, FlowSummary } from "../api/types";

export default function Flows() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: flows = [], isLoading } = useFlows(100);
  const del = useDeleteFlow();
  // 新建入口走 URL：环境页的「建流程」按钮带 ?new=1&env=&mode= 过来即可预填
  const creating = params.get("new") === "1";
  const [toDelete, setToDelete] = useState<FlowSummary | null>(null);

  const openNew = () => setParams({ new: "1" });
  const closeNew = () => {
    const next = new URLSearchParams(params);
    next.delete("new");
    next.delete("env");
    next.delete("mode");
    setParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="流程列表"
        sub="按门禁顺序推进：上一阶段通过或跳过才会解锁下一阶段"
        actions={<Button size="sm" onClick={openNew}>新建流程</Button>}
      >
        <Table head={["流程", "模式", "环境", "阶段进度", "状态", "创建时间", "操作"]}>
          {isLoading && <tr><Td colSpan={7}><div className="text-sm text-ink-mute">加载流程…</div></Td></tr>}
          {!isLoading && flows.length === 0 && <tr><Td colSpan={7}><Empty>还没有流程，点击右上角「新建流程」</Empty></Td></tr>}
          {flows.map((f) => (
            <Tr key={f.id}>
              <Td><Link to={`/flows/${f.id}`} className="font-medium text-brand hover:underline">{f.name}</Link></Td>
              <Td className="text-ink-soft">{modeLabel(f.mode)}</Td>
              {/* 列表接口不回传 env_name（只有 GET /flows/{id} 拼了），此处如实显示 env_id */}
              <Td className="font-mono text-xs text-ink-mute">{f.env_id || "—"}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                    <span
                      className="block h-full bg-brand"
                      style={{ width: `${f.progress.total ? (f.progress.done / f.progress.total) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="font-mono text-xs">{f.progress.done}/{f.progress.total}</span>
                </div>
              </Td>
              <Td><StatusTag kind="flow" value={f.status} /></Td>
              <Td className="text-xs text-ink-mute">{fmtTime(f.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => nav(`/flows/${f.id}`)}>进入</Button>
                  <Button size="sm" variant="danger" onClick={() => setToDelete(f)}>删除</Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <NewFlowDialog
        open={creating}
        onClose={closeNew}
        presetEnv={params.get("env") ?? undefined}
        presetMode={(params.get("mode") as FlowMode | null) ?? undefined}
        onCreated={(id) => { closeNew(); nav(`/flows/${id}`); }}
      />

      <ConfirmDialog
        open={!!toDelete}
        title="删除流程"
        body={toDelete
          ? `将删除流程「${toDelete.name}」（${fmtDate(toDelete.created_at)} 创建）及其阶段执行记录。安装包与备份点不受影响。`
          : ""}
        danger
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (!toDelete) return;
          del.mutate(toDelete.id, {
            onSuccess: () => { toast("流程已删除"); setToDelete(null); },
            onError: () => { toast("删除失败", "error"); setToDelete(null); },
          });
        }}
      />
    </div>
  );
}
