import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { endpoints, qk } from "../api/endpoints";
import { useToast } from "../components/ToastProvider";
import { ApiError } from "../api/client";
import type { PackageEntry } from "../api/types";

/** 单片字节数，同时作为「是否走分片」的阈值基准与服务端建会话时的建议片长。 */
export const CHUNK_SIZE = 8 * 1024 * 1024;
const SINGLE_LIMIT = 64 * 1024 * 1024;

export type UploadStrategy = "single" | "chunked";

/** 小于 64MB 走单次表单上传，达到阈值即改分片续传，避免撞后端请求体上限。 */
export const pickStrategy = (size: number): UploadStrategy => (size >= SINGLE_LIMIT ? "chunked" : "single");

/** 按 chunk 切片 [from, to)；末片取余，size 为 0 时不给片。 */
export function sliceRanges(size: number, chunk: number): [number, number][] {
  const out: [number, number][] = [];
  for (let off = 0; off < size; off += chunk) out.push([off, Math.min(off + chunk, size)]);
  return out;
}

export interface UploadProgress {
  fileName: string;
  totalBytes: number;
  sentBytes: number;
  percent: number;
  chunkIndex: number;
  totalChunks: number;
  resuming: boolean;
}

/**
 * 安装包上传：单请求 / 分片续传两条路径，进度与取消由本 hook 持有。
 * 断点续传以服务端 done_chunks 为准，重传只补缺失片。
 */
export function useChunkedUpload(flowId?: string, flowName?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.packages });
    if (flowId) qc.invalidateQueries({ queryKey: qk.flow(flowId) });
  }, [qc, flowId]);

  const single = useCallback(async (file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("name", file.name);
    fd.append("version", "");
    fd.append("kind", "bundle");
    fd.append("flow_id", flowId ?? "");
    return endpoints.uploadPackage(fd);
  }, [flowId]);

  const chunked = useCallback(async (file: File) => {
    const signal = abortRef.current?.signal;
    const init = await endpoints.initUpload({
      name: file.name,
      version: "",
      kind: "bundle",
      size_bytes: file.size,
      chunk_size: CHUNK_SIZE,
      flow_id: flowId ?? "",
    });

    // 断点续传：先问服务端哪些片已到
    const st = await endpoints.uploadStatus(init.upload_id);
    const done = new Set(st.done_chunks);
    const ranges = sliceRanges(file.size, init.chunk_size);

    setProgress({
      fileName: file.name, totalBytes: file.size, sentBytes: st.uploaded_bytes,
      percent: st.progress, chunkIndex: done.size, totalChunks: ranges.length, resuming: done.size > 0,
    });

    for (let i = 0; i < ranges.length; i++) {
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      if (done.has(i)) continue;
      const [from, to] = ranges[i]!;
      const r = await endpoints.uploadChunk(init.upload_id, i, file.slice(from, to), `${file.name}.part${i}`);
      // sentBytes 由服务端回报的百分比反推（接口只给 progress），仅用于进度条文案；
      // 续传正确性由 done_chunks 决定，不看 sentBytes。
      setProgress({
        fileName: file.name, totalBytes: file.size, sentBytes: (r.progress * file.size) / 100,
        percent: r.progress, chunkIndex: i + 1, totalChunks: ranges.length, resuming: done.size > 0,
      });
    }
    return endpoints.completeUpload(init.upload_id);
  }, [flowId]);

  const upload = useCallback(async (file: File): Promise<PackageEntry | null> => {
    setBusy(true);
    abortRef.current = new AbortController();
    setProgress({
      fileName: file.name, totalBytes: file.size, sentBytes: 0,
      percent: 0, chunkIndex: 0, totalChunks: 1, resuming: false,
    });
    try {
      const entry = pickStrategy(file.size) === "single" ? await single(file) : await chunked(file);
      toast(`「${entry.name}」上传完成${flowName ? `，已挂到流程「${flowName}」` : ""}`);
      refresh();
      return entry;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toast("上传已取消，可在原会话继续", "warn");
      } else {
        toast(e instanceof ApiError ? e.message : "上传失败", "error");
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, [single, chunked, toast, refresh, flowName]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  return { busy, progress, upload, cancel };
}
