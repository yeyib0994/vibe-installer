import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { QueryError } from "../components/ui/QueryError";
import { StatusTag } from "../components/StatusTag";
import { StageRail } from "../flow/StageRail";
import { StagePanel } from "../flow/StagePanel";
import { RollbackButton } from "../components/flow/RollbackButton";
import { NodeMatrixReadonly } from "../components/env/NodeMatrixReadonly";
import { UploadZone } from "../components/upload/UploadZone";
import { useFlow, usePackage } from "../hooks/queries";
import { useFlowRunner } from "../hooks/useFlowRunner";
import { fmtBytes, fmtTime } from "../lib/format";
import { modeLabel } from "../lib/labels";
import type { FlowDetail } from "../api/types";

export default function FlowWizard() {
  const { id = "" } = useParams();
  const { data: flow, isError, error, isFetching, refetch } = useFlow(id);

  if (isError) {
    return (
      <QueryError label="加载流程失败" error={error} retrying={isFetching} onRetry={() => refetch()} />
    );
  }
  if (!flow) return <div className="text-sm text-ink-mute">加载流程…</div>;
  // 按流程 id 重挂载：useFlowRunner 的草稿是 useState 初始值，只在挂载时播种一次。
  // 同路由树下 f1→f2 复用元素实例（f2 已在查询缓存里时 useFlow 同步给数据，不经过加载态卸载），
  // 不 key 就会把 f1 的草稿留在 f2 的表单上 —— 目录阶段键跨流程同名，active.key 照样解析得出。
  return <Wizard key={flow.id} flow={flow} />;
}

function Wizard({ flow }: { flow: FlowDetail }) {
  const r = useFlowRunner(flow);
  const next = r.nextReady;

  useEffect(() => {
    document.title = `${flow.name} · ShipDesk Console`;
  }, [flow.name]);

  // 目录保证 stages 非空；空 stages 时 useFlowRunner 的 stage 才会是 undefined（兜底交回页面）。
  const stage = r.stage;
  if (!stage) return <div className="text-sm text-ink-mute">该流程没有阶段，请删除后重建。</div>;

  // release_name 是 K8s 模式「环境登记」的表单字段（Workflow.java:292），随 inputs 落进 stages[0]；
  // 后端也从那里读它（回滚端点 ApiController.java:860-866、动作侧 StageExecutor.java:1408），
  // 其余阶段的 inputs 里没有这个键，只看首阶段即可。
  const releaseName = String(flow.stages[0]?.inputs.release_name ?? "");

  // 任一流水在跑就不给上传：同一目标机上并发安装/上传会互相踩。
  const running = flow.stages.some((s) => s.status === "running");
  // 上传区只属于 package_upload：install 与 upgrade_k8s 的目录里都有这个阶段，其余阶段没有。
  const isUploadStage = stage.key === "package_upload";
  // 已挂到本流程的包 id 由服务端注入 inputs（ApiController.java:536-549、615-630），
  // 表单草稿不重播（I3）：collect() 运行时合并 stage.inputs，下一次「校验并执行」自然带上。
  // inputs 是 Record<string, unknown>：_package_ids 未经校验，按 Array.isArray + 逐元素 typeof 收口。
  const rawPkgIds = stage.inputs._package_ids;
  const pkgIds = Array.isArray(rawPkgIds)
    ? rawPkgIds.filter((x): x is string => typeof x === "string")
    : [];

  return (
    <div className="flex flex-col gap-5">
      <Card
        title={
          <span className="flex items-center gap-2.5">
            {flow.name}
            <StatusTag kind="flow" value={flow.status} />
          </span>
        }
        sub={`${modeLabel(flow.mode)} · 环境 ${flow.env_name || "—"} · ${flow.stages.length} 阶段 · 更新于 ${fmtTime(flow.updated_at)}`}
        actions={
          <div className="flex items-center gap-2">
            {flow.mode === "upgrade_k8s" && <RollbackButton flowId={flow.id} releaseName={releaseName} />}
            <Link to="/flows" className="text-xs text-ink-soft hover:text-brand">返回列表</Link>
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-line">
            <span
              className="block h-full bg-brand transition-all"
              style={{ width: `${flow.progress.total ? (flow.progress.done / flow.progress.total) * 100 : 0}%` }}
            />
          </span>
          <span className="font-mono text-xs text-ink-soft">{flow.progress.done}/{flow.progress.total}</span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_1fr]">
        <div className="lg:sticky lg:top-[72px] lg:self-start">
          <Card title="阶段" tight sub="点锁定的阶段不可进入">
            <div className="p-2.5">
              <StageRail stages={flow.stages} activeKey={r.activeKey} onSelect={r.select} />
            </div>
          </Card>
          {flow.nodes.length > 0 && (
            <details className="mt-3 rounded-card border border-line bg-panel px-3 py-2.5">
              <summary className="cursor-pointer text-xs font-medium text-ink-soft">
                环境节点 · {flow.nodes.length} 台
              </summary>
              <div className="mt-3 max-h-[420px] overflow-auto">
                <NodeMatrixReadonly nodes={flow.nodes} />
              </div>
            </details>
          )}
        </div>

        <StagePanel
          flowId={flow.id}
          stage={stage}
          values={r.values}
          onChange={r.setValue}
          fieldErrors={r.fieldErrors}
          busy={r.busy}
          onRun={r.run}
          onSkip={r.skip}
          onCancel={r.cancel}
          onStreamDone={r.onStreamDone}
          uploadSlot={
            isUploadStage ? (
              <div className="rounded-card border border-dashed border-line p-4">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-mute">安装包上传</h3>
                <p className="mb-3 text-[11px] text-ink-mute">
                  ≥64 MB 自动走分片续传{running ? "（阶段执行中禁止上传）" : ""}
                </p>
                <UploadZone flowId={flow.id} flowName={flow.name} disabled={running} />
                {pkgIds.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1">
                    {pkgIds.map((pid) => <PackageChip key={pid} id={pid} />)}
                  </ul>
                )}
              </div>
            ) : null
          }
        />
      </div>

      {next && stage.status === "passed" && (
        <Card title="下一步" tight>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm text-ink-soft">已解锁「{next.title}」，可继续推进。</span>
            <button className="text-xs font-medium text-brand hover:underline" onClick={() => r.select(next.key)}>
              进入下一阶段 →
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

/** 已挂到本流程的安装包：后端没有 GET /packages/{id}，从列表查询里取（usePackage）。 */
function PackageChip({ id }: { id: string }) {
  const { data } = usePackage(id);
  if (!data) return <li className="font-mono text-[11px] text-ink-mute">{id}</li>;
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="font-medium text-ink">{data.name}</span>
      <span className="font-mono text-[11px] text-ink-mute">{fmtBytes(data.size_bytes)}</span>
      <span className="font-mono text-[11px] text-ink-mute">{id}</span>
    </li>
  );
}
