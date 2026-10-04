import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  danger?: boolean;
  confirmLabel?: string;
  busy?: boolean;
  // busy 会把按钮文案换成「处理中…」，明知会被后端拒绝而禁用时不能用它（那句文案是谎话）
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open, title, body, danger, confirmLabel = "确认", busy, confirmDisabled, onCancel, onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      width={460}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-soft whitespace-pre-line">{body}</p>
    </Modal>
  );
}
