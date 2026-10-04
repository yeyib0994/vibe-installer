import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { StatusTag } from "../components/StatusTag";
import { StageRail } from "../flow/StageRail";
import { StagePanel } from "../flow/StagePanel";
import { RollbackButton } from "../components/flow/RollbackButton";
import { NodeMatrixReadonly } from "../components/env/NodeMatrixReadonly";
import { useFlow } from "../hooks/queries";
import { useFlowRunner } from "../hooks/useFlowRunner";
import { fmtTime } from "../lib/format";
import { modeLabel } from "../lib/labels";
import { ApiError } from "../api/client";
import type { FlowDetail } from "../api/types";

export default function FlowWizard() {
  const { id = "" } = useParams();
  const { data: flow, isError, error, isFetching, refetch } = useFlow(id);

  if (isError) {
    return (
      <div className="flex items-center gap-3">
        <div className="text-sm text-danger">
          加载流程失败：{error instanceof ApiError ? error.message : "请稍后重试"}
        </div>
        <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => refetch()}>
          重试
        </Button>
      </div>
    );
  }
  if (!flow) return <div className="text-sm text-ink-mute">加载流程…</div>;
  return <Wizard flow={flow} />;
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

  // release_name 只存在于 upgrade_k8s 的环境登记阶段 inputs
  const releaseName = String(stage.inputs.release_name ?? flow.stages[0]?.inputs.release_name ?? "");

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
