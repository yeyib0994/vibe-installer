import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, inputCls, labelCls } from "../ui/Field";
import { useToast } from "../ToastProvider";
import { useCreateCluster } from "../../hooks/queries";
import { ApiError } from "../../api/client";

/**
 * K8s 集群登记表单。
 *
 * 三处诚实约束（都与后端源码对过）：
 * - POST /api/k8s/clusters 直接把请求体绑成 K8sCluster，一个字段都不校验
 *   （ApiController.java:850-853），空名字会被原样存成一条无名记录，所以必填门禁只能做在这里。
 * - context 只进登记表：K8sOpsService.helmList 只转发 namespace/kubeconfig
 *   （K8sOpsService.java:89-94），helm list 不带 --kube-context，所以表单不能把它说成「选择上下文」。
 * - kubeconfig 也不接受「直接粘贴 YAML 原文」：k8s-ops/src/config.ts:10-25 里不像路径的值一律按
 *   base64 解码写进临时文件，所以提示只承诺路径与 base64 两种输入。
 */
export function NewClusterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kubeconfig, setKubeconfig] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [context, setContext] = useState("");
  const [nameError, setNameError] = useState(false);
  const create = useCreateCluster();
  const toast = useToast();

  /** Modal 只是 return null——组件从没卸载，草稿会跟着下一次打开一起回来，所以每次收尾都要清。 */
  const reset = () => {
    setName(""); setKubeconfig(""); setNamespace("default"); setContext(""); setNameError(false);
  };

  // 与 ConfirmDialog 的 busy 处理一致：在途时 取消 禁用，✕/Esc/backdrop 也一律挡掉
  // （它们走的都是同一个 onClose），免得请求还在跑就把窗关了、结果回来无处安放。
  const cancel = () => {
    if (create.isPending) return;
    reset();
    onClose();
  };

  const submit = () => {
    if (!name.trim()) {
      setNameError(true);
      toast("集群名称必填", "warn");
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        kubeconfig: kubeconfig.trim(),
        namespace: namespace.trim() || "default",
        context: context.trim(),
      },
      {
        onSuccess: (c) => {
          toast(`集群「${c.name}」已登记`);
          reset();
          onClose();
        },
        onError: (e) => toast(e instanceof ApiError ? e.message : "登记失败", "error"),
      }
    );
  };

  return (
    <Modal
      open={open}
      title="登记 K8s 集群"
      width={620}
      sub="kubeconfig 填文件路径或 base64 内容；留空则回退 $KUBECONFIG，再退到 ~/.kube/config"
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} disabled={create.isPending}>取消</Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field
          label={<span className={labelCls}>集群名称 *</span>}
          hint={nameError
            ? <span className="text-danger">集群名称必填：后端 POST 不校验名称，空名字会直接存成一条无名记录</span>
            : undefined}
        >
          <input
            className={`${inputCls} ${nameError ? "border-danger" : ""}`}
            value={name}
            onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameError(false); }}
            placeholder="prod-hz-01"
          />
        </Field>
        <Field
          label={<span className={labelCls}>kubeconfig</span>}
          hint="路径按原样传给 k8s-ops；直接粘贴的 YAML 原文会被当成 base64 解码，要贴内容请先 base64 编码"
        >
          <textarea
            className={`${inputCls} h-28 font-mono`}
            value={kubeconfig}
            onChange={(e) => setKubeconfig(e.target.value)}
            placeholder="/home/ops/.kube/config"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label={<span className={labelCls}>默认命名空间</span>} hint="helm list 用它拼 --namespace">
            <input className={inputCls} value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          </Field>
          <Field
            label={<span className={labelCls}>context</span>}
            hint={<span className="text-ink-soft">仅登记备查：helm 调用只传 namespace / kubeconfig，不会用它切换上下文</span>}
          >
            <input className={inputCls} value={context} onChange={(e) => setContext(e.target.value)} placeholder="留空=当前 context" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
