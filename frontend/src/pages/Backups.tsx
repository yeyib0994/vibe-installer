import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Table, Td, Tr } from "../components/ui/Table";
import { Empty } from "../components/ui/Empty";
import { Tag } from "../components/ui/Tag";
import { StatusTag } from "../components/StatusTag";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { useBackups, useEnvironments } from "../hooks/queries";
import { endpoints, qk } from "../api/endpoints";
import { ApiError } from "../api/client";
import { fmtBytes, fmtDate, fmtTime } from "../lib/format";
import { BACKUP_KIND_CN } from "../lib/labels";
import type { BackupPoint, Environment, RestoreResult, VerifyResult } from "../api/types";

export default function Backups() {
  const { data: rows = [], isLoading } = useBackups();
  const { data: envs = [], isLoading: envsLoading } = useEnvironments();
  const qc = useQueryClient();
  const toast = useToast();
  const [verifyOut, setVerifyOut] = useState<{ b: BackupPoint; r: VerifyResult } | null>(null);
  const [restoreOut, setRestoreOut] = useState<{ b: BackupPoint; r: RestoreResult } | null>(null);
  const [toRestore, setToRestore] = useState<BackupPoint | null>(null);
  const [envFilter, setEnvFilter] = useState("");

  // 备份点行的终态一律以后端为准：失败信息（404/409）本身就证明缓存那一行已过期
  const invalidateBackups = () => qc.invalidateQueries({ queryKey: qk.backups() });

  const verify = useMutation({
    mutationFn: (id: string) => endpoints.verifyBackup(id),
    onSuccess: (r, id) => {
      const b = rows.find((x) => x.id === id);
      if (b) setVerifyOut({ b, r });
      invalidateBackups();
      toast(r.ok ? "校验通过" : "校验不一致", r.ok ? "ok" : "error");
    },
    // 后端在校验失败时已把 status 落成 failed（409「备份目录不存在」同样落库），
    // 失败分支不失效的话，那一行会停在旧状态。
    onError: (e) => {
      invalidateBackups();
      toast(e instanceof ApiError ? e.message : "校验失败", "error");
    },
  });

  const expire = useMutation({
    mutationFn: (id: string) => endpoints.expireBackup(id),
    onSuccess: () => {
      invalidateBackups();
      toast("已标记过期");
    },
    onError: (e) => {
      invalidateBackups();
      toast(e instanceof ApiError ? e.message : "标记过期失败", "error");
    },
  });

  // 恢复目标由后端按环境解析（store.getEnv(b.envId) → env.nodes），不认备份记录里的节点，
  // 环境已删则 404「环境不存在」；清单没命中就传空数组，把判定交给后端。
  const restore = useMutation({
    mutationFn: (b: BackupPoint) => endpoints.restoreBackup(b.id, {
      backup_id: b.id,
      node_ids: (envs.find((e) => e.id === b.env_id)?.nodes ?? []).map((n) => n.id),
      confirm: true,
    }),
    onSuccess: (r, b) => {
      // restored_nodes 是目标节点的 hostname 清单，含「无备份数据，跳过」的节点，
      // 所以说「已恢复 N 台」是假的；台数只报目标，明细交给结果弹窗。
      toast(`恢复完成 · 目标 ${r.restored_nodes.length} 台节点`);
      invalidateBackups();
      // 结果窗绑定的是这次点击的 b（TanStack Query 的 variables），无条件弹才是诚实的；
      // 只有「关确认窗」要认当下打开的那一个，函数式更新在提交时读到最新 state，不需要 ref。
      setRestoreOut({ b, r });
      setToRestore((cur) => (cur?.id === b.id ? null : cur));
    },
    onError: (e) => {
      invalidateBackups();
      toast(e instanceof ApiError ? e.message : "恢复失败", "error");
    },
  });

  const list = envFilter ? rows.filter((b) => b.env_id === envFilter) : rows;
  const bytes = list.reduce((a, b) => a + b.size_bytes, 0);

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="备份点"
        sub={`${list.length} 个 · ${fmtBytes(bytes)} · 恢复会覆盖目标节点数据`}
        actions={
          <select
            className="rounded-btn border border-line bg-panel px-2 py-1 text-xs"
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
          >
            <option value="">全部环境</option>
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        }
      >
        <Table head={["名称", "类型", "状态", "覆盖节点", "大小", "校验和", "完成时间", "过期时间", "操作"]}>
          {isLoading && <tr><Td colSpan={9}><div className="text-sm text-ink-mute">加载备份点…</div></Td></tr>}
          {!isLoading && list.length === 0 && (
            <tr><Td colSpan={9}><Empty>流程的备份阶段执行后会自动生成备份点</Empty></Td></tr>
          )}
          {list.map((b) => (
            <Tr key={b.id}>
              <Td>
                <div className="font-medium">{b.name}</div>
                <div className="font-mono text-[11px] text-ink-mute">{b.id}</div>
              </Td>
              <Td><Tag tone="purple">{BACKUP_KIND_CN[b.kind]}</Tag></Td>
              <Td>
                <StatusTag kind="backup" value={b.status} />
                {/* 失败原因后端已存进 error（如「备份目录不存在」），不显示就只能对着「失败」猜 */}
                {b.error && <div className="mt-0.5 text-[11px] text-danger">{b.error}</div>}
              </Td>
              <Td>
                <span className="font-mono text-xs">{b.nodes_covered.length} 台</span>
                <div className="mt-0.5 truncate text-[11px] text-ink-mute">{b.nodes_covered.join(", ") || "—"}</div>
              </Td>
              <Td className="font-mono text-xs">{fmtBytes(b.size_bytes)}</Td>
              <Td className="font-mono text-[11px] text-ink-mute">{b.checksum.slice(0, 12) || "—"}</Td>
              <Td className="text-xs text-ink-mute">
                {fmtTime(b.finished_at)}
                {b.verified_at && <div className="text-[11px]">已校验 {fmtTime(b.verified_at)}</div>}
              </Td>
              <Td className="text-xs text-ink-mute">{fmtDate(b.expire_at)}</Td>
              <Td>
                <div className="flex gap-1.5">
                  {/* 校验是后端磁盘遍历，不并发；用 variables 让进行中的那一行自己显示状态 */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => verify.mutate(b.id)}
                    disabled={verify.isPending}
                    title={verify.isPending ? "校验是磁盘遍历，暂不支持并发" : undefined}
                  >
                    {verify.isPending && verify.variables === b.id ? "校验中…" : "校验"}
                  </Button>
                  {/* 恢复与校验同为节点级/磁盘操作，后端不认并发：在途时锁住全部行的入口 */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setToRestore(b)}
                    disabled={!b.restorable || restore.isPending}
                    title={restore.isPending ? "恢复是节点级操作，暂不支持并发" : undefined}
                  >
                    恢复
                  </Button>
                  {/* 过期只翻后端那条记录的元数据，成本远低于校验，按行禁用即可 */}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => expire.mutate(b.id)}
                    disabled={expire.isPending && expire.variables === b.id}
                  >
                    {expire.isPending && expire.variables === b.id ? "处理中…" : "标记过期"}
                  </Button>
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Modal
        open={!!verifyOut}
        title={verifyOut?.r.ok ? "校验通过" : "校验失败"}
        width={520}
        onClose={() => setVerifyOut(null)}
        footer={<Button variant="ghost" onClick={() => setVerifyOut(null)}>关闭</Button>}
      >
        {verifyOut && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-ink-soft">{verifyOut.r.message}</p>
            <Row k="备份点" v={verifyOut.b.name} />
            <Row k="文件数" v={String(verifyOut.r.files)} />
            <Row k="体积" v={fmtBytes(verifyOut.r.size_bytes)} />
            <Row k="期望校验和" v={verifyOut.r.expected || "—"} mono />
            <Row k="实际校验和" v={verifyOut.r.actual || "—"} mono />
          </div>
        )}
      </Modal>

      <Modal
        open={!!restoreOut}
        title="恢复结果"
        width={620}
        onClose={() => setRestoreOut(null)}
        footer={<Button variant="ghost" onClick={() => setRestoreOut(null)}>关闭</Button>}
      >
        {restoreOut && (
          <div className="flex flex-col gap-2 text-sm">
            <Row k="备份点" v={restoreOut.b.name} />
            <Row
              k="目标节点"
              v={`${restoreOut.r.restored_nodes.length} 台（${restoreOut.r.restored_nodes.join(", ") || "—"}）`}
            />
            <p className="text-xs text-ink-mute">目标节点清单含被后端跳过的节点，实际结果以逐节点输出为准。</p>
            {restoreOut.r.detail
              ? (
                <pre className="whitespace-pre-line break-all rounded-card border border-line bg-canvas p-3 font-mono text-xs text-ink">
                  {restoreOut.r.detail}
                </pre>
              )
              : <div className="text-xs text-ink-mute">后端未返回逐节点结果</div>}
          </div>
        )}
      </Modal>

      <RestoreDialog
        backup={toRestore}
        envs={envs}
        envsLoading={envsLoading}
        busy={restore.isPending && restore.variables?.id === toRestore?.id}
        restorePending={restore.isPending}
        onClose={() => setToRestore(null)}
        onConfirm={(b) => restore.mutate(b)}
      />
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <span className="text-xs text-ink-mute">{k}</span>
      <span className={`text-right text-xs ${mono ? "font-mono break-all" : "text-ink"}`}>{v}</span>
    </div>
  );
}

function RestoreDialog({ backup, envs, envsLoading, busy, restorePending, onClose, onConfirm }: {
  backup: BackupPoint | null;
  envs: Environment[];
  envsLoading: boolean;
  busy: boolean;
  restorePending: boolean;
  onClose: () => void;
  onConfirm: (b: BackupPoint) => void;
}) {
  if (!backup) return null;
  const env = envs.find((e) => e.id === backup.env_id);
  const targets = env?.nodes ?? [];
  // 加载中不等于环境不存在：这时候说「不在清单」是句谎话，确认仍要可点；
  // 清单加载完仍没有这个环境，后端必然 404「环境不存在」——已知结局就不该再给出确认动作。
  const envMissing = !envsLoading && !env;
  const targetText = envsLoading
    ? "环境清单加载中，确认后由后端按该环境的全部节点解析。"
    : env
      ? `${targets.length} 台（${targets.map((n) => n.hostname).join(", ")}）`
      : "该环境已不在清单中，无法恢复；需先重新登记同名环境。";

  return (
    <ConfirmDialog
      open
      title="恢复备份"
      danger
      confirmLabel="确认覆盖并恢复"
      busy={busy}
      confirmDisabled={restorePending || envMissing}
      onCancel={onClose}
      onConfirm={() => onConfirm(backup)}
      body={
        `备份点「${backup.name}」覆盖 ${backup.nodes_covered.length} 台节点。\n` +
        `本次恢复目标：${targetText}\n` +
        `该操作会覆盖目标节点上的现有数据，不可撤销。`
      }
    />
  );
}
