import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { endpoints, qk } from "../api/endpoints";
import { useToast } from "../components/ToastProvider";
import { ApiError } from "../api/client";
import type { FlowDetail, PackageEntry } from "../api/types";

/** 单片字节数，同时作为「是否走分片」的阈值基准与服务端建会话时的建议片长。 */
export const CHUNK_SIZE = 8 * 1024 * 1024;
const SINGLE_LIMIT = 64 * 1024 * 1024;
/** localStorage 里的会话记录前缀；键含文件身份，同一文件重传必然命中同一条。 */
const SESSION_PREFIX = "shipdesk.upload.";

export type UploadStrategy = "single" | "chunked";

/** 小于 64MB 走单次表单上传，达到阈值即改分片续传，避免撞后端请求体上限。 */
export const pickStrategy = (size: number): UploadStrategy => (size >= SINGLE_LIMIT ? "chunked" : "single");

/**
 * 按 chunk 切片 [from, to)；末片取余，size 为 0 时不给片。
 * chunk 是服务端 init/status 回的值（外部输入）：给 0 会让下面的循环永不结束，先拦掉。
 */
export function sliceRanges(size: number, chunk: number): [number, number][] {
  if (!Number.isFinite(chunk) || chunk <= 0) throw new RangeError(`分片长度必须为正数，收到 ${chunk}`);
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

interface StoredSession {
  upload_id: string;
  flow_id: string;
}

const sessionKeyOf = (file: File): string => `${SESSION_PREFIX}${file.name}|${file.size}|${file.lastModified}`;

// localStorage 在隐私模式/配额满时会抛。它只是续传的加速带，读不到就当没有会话，
// 写不上就退化成普通上传 —— 存储故障绝不能把上传本身弄炸。
const readSession = (key: string): StoredSession | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.upload_id !== "string" || parsed.upload_id === "") return null;
    return { upload_id: parsed.upload_id, flow_id: typeof parsed.flow_id === "string" ? parsed.flow_id : "" };
  } catch {
    /* 存储读不了：走全新会话 */
    return null;
  }
};

const writeSession = (key: string, session: StoredSession): void => {
  try {
    localStorage.setItem(key, JSON.stringify(session));
  } catch {
    /* 存不下就不续传，上传照走 */
  }
};

const clearSession = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 清不掉最多留一条废记录，服务端那边迟早作废 */
  }
};

const abortError = (): DOMException => new DOMException("上传已取消", "AbortError");

/** fetch 被中断时浏览器抛 DOMException(name="AbortError")；这里按结构判定，兼容各类抛出物。 */
const isAbort = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";

/**
 * 安装包上传：单请求 / 分片续传两条路径，进度与取消由本 hook 持有。
 *
 * 取消只在分片路径成立（`cancellable` 为此而暴露）：每片请求都带同一个 AbortSignal，取消在
 * 下一个边界生效，并且一定拦得住 complete。单请求路径（<64MB）是一把梭的 multipart，客户端
 * 断开时 Spring 早已收完包体并注册了包，没有「取消」这回事 —— 那条路径上 `cancellable` 恒为
 * false，UI 不该挂出一个假按钮（T5.2 的 UploadZone 按此渲染）。
 *
 * 断点续传是真的：分片字节写在服务端磁盘 data/packages/.tmp/{upload_id}/chunk_{i}，Java 进程
 * 不重启就还在，客户端丢的只是 upload_id。所以每个会话 id 都按「文件名|字节数|修改时间」记进
 * localStorage，重传同一文件先 GET /upload/{id} 问已到片号，只补缺失片。服务端对未知 id 抛
 * 异常（不是 404，所以任何失败都只能当「会话没了」）：作废本地记录、退回全新会话。flow_id 不
 * 一致的会话不复用 —— 挂载目标不能悄悄变。complete 成功后记录即删除。
 *
 * `progress` 只在上传进行期间非 null（成功/失败/取消收尾都清空），`upload()` 同一时刻只放
 * 一个在飞，重复触发直接返回 null 且不碰网络。
 */
export function useChunkedUpload(flowId?: string, flowName?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 在飞标记用 ref 把关：用 busy state 判断会让 upload 依赖自己形成环
  const runningRef = useRef(false);
  // 非 null ⇒ 服务端那儿有个可续传的会话（取消文案据此说实话）
  const sessionKeyRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.packages });
    if (flowId) qc.invalidateQueries({ queryKey: qk.flow(flowId) });
  }, [qc, flowId]);

  const single = useCallback(async (file: File, signal: AbortSignal) => {
    // 请求还没发出去，此时的取消是真的；一旦发出就没有可取消的余地（cancellable=false）
    if (signal.aborted) throw abortError();
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("name", file.name);
    fd.append("version", "");
    fd.append("kind", "bundle");
    fd.append("flow_id", flowId ?? "");
    return endpoints.uploadPackage(fd);
  }, [flowId]);

  const chunked = useCallback(async (file: File, signal: AbortSignal) => {
    const key = sessionKeyOf(file);
    const ownFlow = flowId ?? "";
    let uploadId = "";
    let chunkSize = CHUNK_SIZE;
    let sentBytes = 0;
    let percent = 0;
    const done = new Set<number>();

    // 续传：命中同一流程的会话就先问服务端哪些片已到，跳过的片一个都不重发
    const stored = readSession(key);
    if (stored && stored.flow_id === ownFlow) {
      try {
        const st = await endpoints.uploadStatus(stored.upload_id);
        uploadId = st.upload_id || stored.upload_id;
        chunkSize = st.chunk_size > 0 ? st.chunk_size : CHUNK_SIZE;
        for (const i of st.done_chunks) done.add(i);
        sentBytes = st.uploaded_bytes;
        percent = st.progress;
        sessionKeyRef.current = key;
      } catch {
        // 服务端不认这个 id（进程重启、会话被清）：作废记录，下面建新会话
        clearSession(key);
      }
    }
    if (signal.aborted) throw abortError();

    if (uploadId === "") {
      const init = await endpoints.initUpload({
        name: file.name,
        version: "",
        kind: "bundle",
        size_bytes: file.size,
        chunk_size: CHUNK_SIZE,
        flow_id: ownFlow,
      });
      uploadId = init.upload_id;
      // 片长以服务端为准：它可能不按我们的建议来
      chunkSize = init.chunk_size > 0 ? init.chunk_size : CHUNK_SIZE;
      writeSession(key, { upload_id: uploadId, flow_id: ownFlow });
      sessionKeyRef.current = key;
    }

    const ranges = sliceRanges(file.size, chunkSize);
    const resumed = done.size > 0;
    setProgress({
      fileName: file.name, totalBytes: file.size, sentBytes,
      percent, chunkIndex: done.size, totalChunks: ranges.length, resuming: resumed,
    });

    for (let i = 0; i < ranges.length; i++) {
      if (signal.aborted) throw abortError();
      if (done.has(i)) continue;
      const [from, to] = ranges[i]!;
      const r = await endpoints.uploadChunk(uploadId, i, file.slice(from, to), `${file.name}.part${i}`, signal);
      // sentBytes 只能由服务端回报的整体 percent 反推：UploadChunkResult.received_bytes 给的是
      // 「这一片收到多少字节」，是单片值不是累计值，攒不出已发总量（续传跳过的片根本没经过我们）。
      // 够进度条文案用；续传正确性只看 done_chunks，不看 sentBytes。
      setProgress({
        fileName: file.name, totalBytes: file.size, sentBytes: (r.progress * file.size) / 100,
        percent: r.progress, chunkIndex: i + 1, totalChunks: ranges.length, resuming: resumed,
      });
    }

    // 最后一片飞行中点了取消：绝不能再走 complete，否则取消形同虚设
    if (signal.aborted) throw abortError();
    const entry = await endpoints.completeUpload(uploadId, signal);
    clearSession(key);
    sessionKeyRef.current = null;
    return entry;
  }, [flowId]);

  const upload = useCallback(async (file: File): Promise<PackageEntry | null> => {
    if (runningRef.current) return null; // 一次只跑一个：并行会话会让两次 setProgress 互相打架，还能产出两个包
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    sessionKeyRef.current = null;

    const strategy = pickStrategy(file.size);
    // 片数在选定策略时就已知，别让 512MB 的文件先显示「分片 0/1」再跳到 /64
    const totalChunks = strategy === "single" ? 1 : Math.ceil(file.size / CHUNK_SIZE);
    setBusy(true);
    setCancellable(strategy === "chunked");
    setProgress({
      fileName: file.name, totalBytes: file.size, sentBytes: 0,
      percent: 0, chunkIndex: 0, totalChunks, resuming: false,
    });

    try {
      const entry = strategy === "single" ? await single(file, controller.signal) : await chunked(file, controller.signal);
      if (controller.signal.aborted) throw abortError(); // 已取消就不报「上传完成」

      // 「已挂到流程」得挣来：服务端只在流程真有 package_upload 阶段时才注入 _package_id
      //（ApiController.java:536-549、615-630 的 if (st != null)）。两种模式的目录里都有这个阶段，
      // 但旧记录与手工写库的流程可能没有 —— 缓存查不到就用弱文案，绝不说强的。
      const detail = flowId ? qc.getQueryData<FlowDetail>(qk.flow(flowId)) : undefined;
      const attached = flowName !== undefined && (detail?.stages.some((s) => s.key === "package_upload") ?? false);
      toast(`「${entry.name}」上传完成${attached && flowName ? `，已挂到流程「${flowName}」` : ""}`);
      refresh();
      return entry;
    } catch (e) {
      if (isAbort(e)) {
        // sessionKeyRef 非 null ⇒ 分片会话还在服务端磁盘上，这话才是真的
        toast(sessionKeyRef.current ? "上传已取消，已发送的分片已保留，服务不重启的话重传同一文件可续传" : "上传已取消", "warn");
      } else {
        toast(e instanceof ApiError ? e.message : "上传失败", "error");
      }
      return null;
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setBusy(false);
      setCancellable(false);
      setProgress(null); // progress 非 null 只在上传期间：失败/取消后不留半截进度给 UI
    }
  }, [single, chunked, toast, refresh, qc, flowId, flowName]);

  /** 取消：只负责 abort，busy/progress/cancellable 一律由 upload() 的 finally 收口。 */
  const cancel = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  return { busy, cancellable, progress, upload, cancel };
}
