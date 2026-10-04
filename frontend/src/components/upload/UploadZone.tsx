import { useRef, useState } from "react";
import { Button } from "../ui/Button";
import { useChunkedUpload } from "../../hooks/useChunkedUpload";
import { fmtBytes } from "../../lib/format";

export interface UploadZoneProps {
  flowId?: string;
  flowName?: string;
  disabled?: boolean;
  onUploaded?: (packageId: string) => void;
}

/**
 * 安装包上传区：选文件（点击或拖拽）+ 进度 + 取消。
 *
 * 取消按钮只认 `cancellable`，不认 `busy`：单请求路径（<64MB）是一把梭的 multipart，客户端
 * abort 时服务端早已收完包体并注册了包，挂个「取消上传」等于骗人。busy 但不可取消时给一个
 * disabled 的「上传中…」。阈值判断（`pickStrategy`）全在 hook 里，组件不重复决策 —— 文案里的
 * 「≥64 MB 自动分片」只是静态说明。成功/取消/失败的提示由 hook 统一发，这里不再补 toast。
 */
export function UploadZone({ flowId, flowName, disabled, onUploaded }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const up = useChunkedUpload(flowId, flowName);

  const pick = (f: File | null) => setFile(f);

  const go = async () => {
    if (!file) return;
    const entry = await up.upload(file);
    if (entry) { setFile(null); onUploaded?.(entry.id); }
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0] ?? null); }}
        className={`flex flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed px-4 py-7 text-center transition-colors ${
          drag ? "border-brand bg-brand-soft" : "border-line bg-canvas"
        }`}
      >
        <p className="text-xs text-ink-soft">
          {file ? `已选择：${file.name} · ${fmtBytes(file.size)}` : "拖拽 tar.gz / chart 包到此处，或点击选择文件"}
        </p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => inputRef.current?.click()} disabled={disabled || up.busy}>
            选择文件
          </Button>
          {/* 取消能力只看 cancellable：busy 的单请求上传没有可撤销的余地。 */}
          {up.busy ? (
            up.cancellable ? (
              <Button size="sm" variant="danger" onClick={up.cancel}>取消上传</Button>
            ) : (
              <Button size="sm" onClick={go} disabled>上传中…</Button>
            )
          ) : (
            <Button size="sm" onClick={go} disabled={disabled || !file}>开始上传</Button>
          )}
        </div>
      </div>

      {up.progress && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-ink-mute">
            <span>
              {up.progress.resuming ? "断点续传中" : "上传中"} · 分片 {up.progress.chunkIndex}/{up.progress.totalChunks}
            </span>
            <span className="font-mono">
              {fmtBytes(Math.round(up.progress.totalBytes * up.progress.percent / 100))} / {fmtBytes(up.progress.totalBytes)}
            </span>
          </div>
          <span className="block h-1.5 overflow-hidden rounded-full bg-line">
            <span className="block h-full bg-brand transition-all" style={{ width: `${up.progress.percent}%` }} />
          </span>
        </div>
      )}
    </div>
  );
}
