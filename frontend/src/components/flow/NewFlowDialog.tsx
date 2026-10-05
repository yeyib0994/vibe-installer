import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, inputCls, labelCls } from "../ui/Field";
import { useToast } from "../ToastProvider";
import { useCreateFlow, useEnvironments } from "../../hooks/queries";
import { MODE_OPTIONS } from "../../lib/labels";
import { ApiError } from "../../api/client";
import type { FlowMode } from "../../api/types";

/**
 * POST /api/flows 请求体只有 name / env_id / mode（operator 由后端固定写 admin）。
 * 全新安装与原地升级都必须选环境（后端在 ApiController.java:207-215 也这么拦）：
 * install 是把节点矩阵写进这个环境，upgrade 则是确认环境里已登记好的那一份矩阵、不重新登记。
 * 只有 K8s 升级在阶段 1 选集群，创建时环境可留空。
 * 导航由父组件经 onCreated 完成，本对话框只负责校验与提交。
 */
export function NewFlowDialog({ open, onClose, presetEnv, presetMode, onCreated }: {
  open: boolean;
  onClose: () => void;
  presetEnv?: string;
  presetMode?: FlowMode;
  onCreated: (flowId: string) => void;
}) {
  // URL 带过来的 mode 未经校验（`?mode=xxx` 后端会 400），只认目录里的三个值。
  const modeOf = (p?: FlowMode): FlowMode => MODE_OPTIONS.find((m) => m.value === p)?.value ?? "install";
  const [name, setName] = useState("");
  const [envId, setEnvId] = useState(presetEnv ?? "");
  const [mode, setMode] = useState<FlowMode>(modeOf(presetMode));
  const create = useCreateFlow();
  const toast = useToast();
  const { data: envs = [] } = useEnvironments();
  const hint = MODE_OPTIONS.find((m) => m.value === mode)?.hint ?? "";

  // Modal 关闭只是 return null，本组件从不卸载：useState 初始值只在挂载时播一次，
  // 于是上一轮的草稿和旧 preset 会跟着下一次打开一起回来（换个 env/mode 也覆盖不上）。
  // 每次由关到开都按当前 props 重新播种，「取消后重开」才是一张干净表单。
  useEffect(() => {
    if (!open) return;
    setName("");
    setEnvId(presetEnv ?? "");
    setMode(modeOf(presetMode));
  }, [open, presetEnv, presetMode]);

  const submit = () => {
    if (!name.trim()) { toast("流程名称必填", "warn"); return; }
    if (mode === "install" && !envId) { toast("全新安装必须选择环境", "warn"); return; }
    if (mode === "upgrade" && !envId) { toast("原地升级必须选择已登记节点的环境", "warn"); return; }
    create.mutate(
      { name: name.trim(), env_id: envId, mode },
      {
        onSuccess: (f) => { toast(`流程「${f.name}」已创建`); onCreated(f.id); },
        onError: (e) => toast(e instanceof ApiError ? e.message : "创建失败", "error"),
      }
    );
  };

  return (
    <Modal
      open={open}
      title="新建流程"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={submit} disabled={create.isPending}>创建并进入</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={<span className={labelCls}>流程名称 *</span>}>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="生产-AZ1 全新安装" />
        </Field>
        <Field label={<span className={labelCls}>编排模式 *</span>} hint={hint}>
          <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as FlowMode)}>
            {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field
          label={<span className={labelCls}>目标环境{mode === "upgrade_k8s" ? "" : " *"}</span>}
          hint={mode === "install"
            ? (envs.length === 0 ? "还没有环境，请先到「环境」页创建" : "阶段 1 的节点矩阵会写入该环境")
            : mode === "upgrade"
              ? "该环境里已登记的节点矩阵就是升级目标，阶段 1 只做确认与校验"
              : "K8s 升级在阶段 1 选择集群，环境可留空"}
        >
          <select className={inputCls} value={envId} onChange={(e) => setEnvId(e.target.value)}>
            <option value="">（未选择）</option>
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
