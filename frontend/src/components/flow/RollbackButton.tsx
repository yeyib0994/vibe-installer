import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, inputCls, labelCls } from "../ui/Field";
import { useToast } from "../ToastProvider";
import { endpoints, qk } from "../../api/endpoints";
import { ApiError } from "../../api/client";

/**
 * 真实操作：POST /api/flows/{id}/rollback 直接跑 helm rollback，不经过阶段门禁，
 * 因此入口放在流程头部并强制 Modal 确认。回滚只动 release，阶段状态不会被重置
 * （后端不回写 flow，前端也绝不能假装它变了）。
 */
export function RollbackButton({ flowId, releaseName }: { flowId: string; releaseName: string }) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const go = async () => {
    setBusy(true);
    try {
      // 0 与留空同义：revision 为 null 时服务端干脆不下发该参数（K8sOpsService.java:71-74），
      // 而 0 到了执行层被 `if (input.revision)` 的 truthy 判断丢掉（k8s-ops/src/helm.ts:34），
      // 两种写法最后都是裸 `helm rollback <release>`，也就是回到上一版本——所以别把 0 当真实 revision 发出。
      const n = Number(revision);
      const r = await endpoints.rollback(flowId, revision.trim() && n > 0 ? n : undefined);
      const ok = r.ok === true;
      // 模拟模式下的 ok 没碰过集群（后端 K8sOpsService 合成结果时带 mock 标记），
      // 报成「回滚完成」就是凭空造一次成功。
      const mocked = ok && r.mock === true;
      toast(
        !ok
          ? `回滚失败：${String(r.error ?? JSON.stringify(r)).slice(0, 120)}`
          : mocked
            ? "Helm 回滚未执行：后端处于模拟模式（CLOUDOPS_FORCE_MOCK=1）"
            : `Helm 回滚完成：${releaseName || "release"}`,
        ok ? "ok" : "error",
      );
      qc.invalidateQueries({ queryKey: qk.flow(flowId) });
      if (ok) setOpen(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "回滚失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>Helm 回滚</Button>
      <Modal
        open={open}
        title={`回滚 Helm Release${releaseName ? ` · ${releaseName}` : ""}`}
        sub="调用 helm rollback 回到上一 revision，流程阶段状态不会被重置"
        width={460}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button variant="danger" onClick={go} disabled={busy}>{busy ? "回滚中…" : "确认回滚"}</Button>
          </>
        }
      >
        <Field label={<span className={labelCls}>目标 revision（留空=上一版本）</span>}>
          <input className={inputCls} type="number" min={0} value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="0" />
        </Field>
      </Modal>
    </>
  );
}
