import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { qk } from "../api/endpoints";
import type {
  FlowDetail,
  FlowStage,
  PackageEntry,
  UploadChunkResult,
  UploadInit,
  UploadStatus,
} from "../api/types";
import {
  CHUNK_SIZE,
  pickStrategy,
  sliceRanges,
  useChunkedUpload,
  type UploadProgress,
} from "./useChunkedUpload";

/**
 * 契约要点（与 backend-java 对齐，全部用 mock 复刻，不打真机）：
 * - 单请求路径（<64MB）客户端无法取消：Spring 早已收完请求体并注册了包，所以钩子必须给出
 *   cancellable=false，UI 才不会挂出一个假按钮。
 * - 分片路径每一片都带 AbortSignal；取消在下一个边界生效，绝不触发 complete。
 * - 断点续传靠 localStorage 里记住的 upload_id：分片字节在服务端磁盘上，进程没重启就还在。
 *   会话丢失（重启/GC）时 GET /upload/{id} 报错（服务端抛 RuntimeException，不是 404，
 *   所以任何失败都只能当「会话没了」），本地记录作废、退回全新会话。
 * - 「已挂到流程」只在缓存的流程详情真有 package_upload 阶段时才说（upgrade/upgrade_k8s 没有）。
 */

const pushToast = vi.hoisted(() => vi.fn());
const ep = vi.hoisted(() => ({
  uploadPackage: vi.fn(),
  initUpload: vi.fn(),
  uploadChunk: vi.fn(),
  uploadStatus: vi.fn(),
  completeUpload: vi.fn(),
}));

vi.mock("../components/ToastProvider", () => ({ useToast: () => pushToast }));
vi.mock("../api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/endpoints")>()),
  endpoints: ep,
}));

const MB = 1024 * 1024;
const BIG = 64 * MB; // 恰好 8 片，且已达分片阈值
const BIG_CHUNKS = BIG / CHUNK_SIZE;
const LAST_MODIFIED = 1735689600000;

/** hook 写入的会话键：文件名|字节数|修改时间 —— 测试按同一规则拼，等于把格式钉住。 */
const keyOf = (name: string, size: number) => `shipdesk.upload.${name}|${size}|${LAST_MODIFIED}`;

const abortError = () => new DOMException("已取消", "AbortError");

/** 真实的 File（jsdom 提供），只把 size 改成需要的量级，避免造 512MB 内容。 */
const stubFile = (name: string, size: number): File => {
  const f = new File(["stub"], name, { lastModified: LAST_MODIFIED });
  Object.defineProperty(f, "size", { value: size, configurable: true });
  return f;
};

const entryOf = (name: string): PackageEntry & { pieces_count: number } => ({
  id: "p1",
  name,
  version: "",
  kind: "bundle",
  size_bytes: BIG,
  checksum: "abc123",
  pieces: [],
  upload_complete: true,
  uploaded_bytes: BIG,
  path: `data/packages/${name}`,
  storage: "local",
  target_env_id: null,
  created_at: "2026-10-04T12:00:00",
  note: "",
  progress: 100,
  pieces_count: 1,
});

const initOf = (uploadId: string, chunkSize = CHUNK_SIZE): UploadInit => ({
  upload_id: uploadId,
  name: "pkg.iso",
  size_bytes: BIG,
  chunk_size: chunkSize,
  total_chunks: Math.ceil(BIG / chunkSize),
  flow_id: "f1",
});

const statusOf = (uploadId: string, done: number[], chunkSize = CHUNK_SIZE): UploadStatus => ({
  upload_id: uploadId,
  name: "pkg.iso",
  size_bytes: BIG,
  uploaded_bytes: done.length * chunkSize,
  chunk_size: chunkSize,
  total_chunks: Math.ceil(BIG / chunkSize),
  done_chunks: done,
  progress: (done.length / Math.ceil(BIG / chunkSize)) * 100,
  complete: false,
});

const chunkOf = (index: number, total = BIG_CHUNKS): UploadChunkResult => ({
  upload_id: "u",
  chunk_index: index,
  received_bytes: CHUNK_SIZE,
  checksum: "sha",
  progress: ((index + 1) * 100) / total,
});

const stageOf = (key: string): FlowStage => ({
  key,
  index: 0,
  title: key,
  description: "",
  form_fields: [],
  inputs: {},
  required: true,
  status: "ready",
  steps: [],
});

const detailOf = (keys: string[]): FlowDetail => ({
  id: "f1",
  name: "生产升级",
  env_id: "e1",
  mode: "upgrade",
  status: "draft",
  stages: keys.map(stageOf),
  current_stage: 0,
  operator: "admin",
  created_at: "2026-10-04T12:00:00",
  updated_at: "2026-10-04T12:00:00",
  finished_at: null,
  error: null,
  backup_point_id: null,
  progress: { done: 0, total: keys.length },
  env_name: "生产",
  env_summary: { total: 0, by_role: {}, by_type: {}, physical: 0, virtual: 0 },
  nodes: [],
});

const makeQc = () => new QueryClient({ defaultOptions: { queries: { retry: 0 } } });

const wrapperOf = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };

/** 纯微任务冲刷：所有 mock 都用 Promise.resolve，不用真定时器。 */
const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const deferredOf = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

type Uploaded = PackageEntry | null;

beforeEach(() => {
  localStorage.clear();
  pushToast.mockReset();
  ep.uploadPackage.mockReset();
  ep.initUpload.mockReset();
  ep.uploadChunk.mockReset();
  ep.uploadStatus.mockReset();
  ep.completeUpload.mockReset();

  ep.uploadPackage.mockResolvedValue(entryOf("pkg.iso"));
  ep.initUpload.mockResolvedValue(initOf("u-new"));
  ep.uploadStatus.mockImplementation((uploadId: string) => Promise.resolve(statusOf(uploadId, [])));
  ep.uploadChunk.mockImplementation(
    (_id: string, index: number, _blob: Blob, _name: string, signal?: AbortSignal) =>
      signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(chunkOf(index)),
  );
  ep.completeUpload.mockResolvedValue(entryOf("pkg.iso"));
});

describe("sliceRanges", () => {
  it("整片对齐：24MB 切 3 片", () => {
    expect(sliceRanges(3 * CHUNK_SIZE, CHUNK_SIZE)).toEqual([
      [0, CHUNK_SIZE],
      [CHUNK_SIZE, 2 * CHUNK_SIZE],
      [2 * CHUNK_SIZE, 3 * CHUNK_SIZE],
    ]);
  });

  it("末片取余", () => {
    const r = sliceRanges(CHUNK_SIZE + 10, CHUNK_SIZE);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual([CHUNK_SIZE, CHUNK_SIZE + 10]);
  });

  it("空文件不切", () => {
    expect(sliceRanges(0, CHUNK_SIZE)).toEqual([]);
  });

  it("片长必须为正数：chunk 来自服务端 init 响应，0 会让切片循环永不结束", () => {
    expect(() => sliceRanges(10, 0)).toThrow(RangeError);
    expect(() => sliceRanges(10, -1)).toThrow(RangeError);
  });
});

describe("pickStrategy", () => {
  it("小于阈值走单请求", () => {
    expect(pickStrategy(8 * 1024 * 1024)).toBe("single");
  });

  it("达到阈值走分片续传", () => {
    expect(pickStrategy(64 * 1024 * 1024)).toBe("chunked");
  });
});

describe("useChunkedUpload 单请求路径", () => {
  it("只走 /packages/upload：FormData 字段齐备，分片接口一个都不碰，进度收尾归 null", async () => {
    const file = stubFile("small.tar", 1024);
    const gate = deferredOf<PackageEntry>();
    ep.uploadPackage.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    let run!: Promise<Uploaded>;
    act(() => {
      run = result.current.upload(file);
    });
    await act(async () => {
      await flush();
    });

    // 取消对单请求路径没有意义（服务端早已收完包体），必须报 false 让 UI 收起按钮
    expect(result.current.cancellable).toBe(false);
    expect(result.current.busy).toBe(true);
    expect(result.current.progress).toMatchObject<Partial<UploadProgress>>({
      fileName: "small.tar",
      totalChunks: 1,
      percent: 0,
      resuming: false,
    });

    gate.resolve(entryOf("small.tar"));
    let out!: Uploaded;
    await act(async () => {
      out = await run;
    });

    expect(out).toEqual(entryOf("small.tar"));
    const fd = ep.uploadPackage.mock.calls[0]![0] as FormData;
    expect(fd.get("name")).toBe("small.tar");
    expect(fd.get("kind")).toBe("bundle");
    expect(fd.get("flow_id")).toBe("f1");
    expect(fd.get("file")).toBeTruthy();
    expect(ep.initUpload).not.toHaveBeenCalled();
    expect(ep.uploadStatus).not.toHaveBeenCalled();
    expect(ep.uploadChunk).not.toHaveBeenCalled();
    expect(ep.completeUpload).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
    expect(result.current.cancellable).toBe(false);
    expect(result.current.progress).toBeNull();
  });
});

describe("useChunkedUpload 分片路径", () => {
  it("策略已知就把片数说准：init 在飞行中显示 分片 0/8 而不是 0/1", async () => {
    const file = stubFile("pkg.iso", BIG);
    const gate = deferredOf<UploadInit>();
    ep.initUpload.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    let run!: Promise<Uploaded>;
    act(() => {
      run = result.current.upload(file);
    });
    await act(async () => {
      await flush();
    });

    expect(result.current.progress).toMatchObject<Partial<UploadProgress>>({
      fileName: "pkg.iso",
      totalBytes: BIG,
      totalChunks: BIG_CHUNKS,
      chunkIndex: 0,
      percent: 0,
    });
    expect(result.current.cancellable).toBe(true);

    gate.resolve(initOf("u-new"));
    await act(async () => {
      await run;
    });
    expect(ep.uploadChunk).toHaveBeenCalledTimes(BIG_CHUNKS);
  });

  it("全新会话：8 片按 sliceRanges 各发一次、complete 收尾、进度归 null", async () => {
    const file = stubFile("pkg.iso", BIG);
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(qc),
    });

    const sent: number[] = [];
    ep.uploadChunk.mockImplementation(
      (_id: string, index: number, _blob: Blob, _name: string, signal?: AbortSignal) => {
        sent.push(index);
        return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(chunkOf(index));
      },
    );

    let out!: Uploaded;
    await act(async () => {
      out = await result.current.upload(file);
    });

    expect(out).toEqual(entryOf("pkg.iso"));
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 新会话的 done_chunks 服务端必定为空，问一次进度只是白跑一个来回
    expect(ep.initUpload).toHaveBeenCalledTimes(1);
    expect(ep.uploadStatus).not.toHaveBeenCalled();
    expect(ep.completeUpload.mock.calls[0]![0]).toBe("u-new");
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.packages });
    expect(pushToast).toHaveBeenCalledWith(expect.stringContaining("上传完成"));
    expect(result.current.busy).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it("最后一片飞行中取消：不再 complete、不报「上传完成」， warn 说明分片已保留", async () => {
    const file = stubFile("pkg.iso", BIG);
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    const sent: number[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    ep.uploadChunk.mockImplementation(
      (_id: string, index: number, _blob: Blob, _name: string, signal?: AbortSignal) => {
        sent.push(index);
        signals.push(signal);
        if (index === BIG_CHUNKS - 1) {
          // 请求已在路上，服务端会真的收下这片；取消只该拦住后面的 complete
          result.current.cancel();
        }
        return Promise.resolve(chunkOf(index));
      },
    );

    let out!: Uploaded;
    await act(async () => {
      out = await result.current.upload(file);
    });

    expect(out).toBeNull();
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ep.completeUpload).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith(
      "上传已取消，已发送的分片已保留，重传同一文件可续传",
      "warn",
    );
    expect(pushToast).not.toHaveBeenCalledWith(expect.stringContaining("上传完成"));
    expect(result.current.busy).toBe(false);
    expect(result.current.cancellable).toBe(false);
    expect(result.current.progress).toBeNull();
    // 取消必须拿到真信号，且会话记录留着，下次重传同一文件才接得上
    expect(signals).toHaveLength(BIG_CHUNKS);
    expect(signals.every((s) => s !== undefined)).toBe(true);
    expect(signals.at(-1)!.aborted).toBe(true);
    expect(JSON.parse(localStorage.getItem(keyOf("pkg.iso", BIG))!).upload_id).toBe("u-new");
  });

  it("命中存储的会话：先问进度、跳过已到片、不建新会话，完成后清掉记录", async () => {
    const file = stubFile("pkg.iso", BIG);
    const key = keyOf("pkg.iso", BIG);
    localStorage.setItem(key, JSON.stringify({ upload_id: "u-old", flow_id: "f1" }));
    ep.uploadStatus.mockImplementation((uploadId: string) =>
      Promise.resolve(statusOf(uploadId, [0, 1])),
    );

    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    const sent: number[] = [];
    const gate = deferredOf<UploadChunkResult>();
    ep.uploadChunk.mockImplementation(
      (_id: string, index: number, _blob: Blob, _name: string, signal?: AbortSignal) => {
        sent.push(index);
        if (index === 2) return gate.promise;
        return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(chunkOf(index));
      },
    );

    let run!: Promise<Uploaded>;
    act(() => {
      run = result.current.upload(file);
    });
    await act(async () => {
      await flush();
    });

    expect(ep.uploadStatus).toHaveBeenCalledWith("u-old");
    expect(ep.initUpload).not.toHaveBeenCalled();
    // 已到 2 片 ⇒ 起跳就是 分片 2/8 且 resuming 为真（本轮确实跳过了服务端的片）
    expect(result.current.progress).toMatchObject<Partial<UploadProgress>>({
      fileName: "pkg.iso",
      totalBytes: BIG,
      chunkIndex: 2,
      totalChunks: BIG_CHUNKS,
      resuming: true,
    });

    gate.resolve(chunkOf(2));
    let out!: Uploaded;
    await act(async () => {
      out = await run;
    });

    expect(out).toEqual(entryOf("pkg.iso"));
    expect(sent).toEqual([2, 3, 4, 5, 6, 7]);
    expect(ep.completeUpload.mock.calls[0]![0]).toBe("u-old");
    expect(localStorage.getItem(key)).toBeNull();
    expect(result.current.progress).toBeNull();
  });

  it("存储的会话已失效（服务重启）：作废记录、退回全新会话、上传照样成功", async () => {
    const file = stubFile("pkg.iso", BIG);
    const key = keyOf("pkg.iso", BIG);
    localStorage.setItem(key, JSON.stringify({ upload_id: "u-dead", flow_id: "f1" }));
    // 服务端对未知 id 抛 RuntimeException（不是 404），客户端只能把任何失败都当会话没了
    ep.uploadStatus.mockRejectedValue(new ApiError(500, "上传会话不存在: u-dead", [], null));

    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    let out!: Uploaded;
    await act(async () => {
      out = await result.current.upload(file);
    });

    expect(out).toEqual(entryOf("pkg.iso"));
    expect(ep.uploadStatus).toHaveBeenCalledWith("u-dead");
    expect(ep.initUpload).toHaveBeenCalledTimes(1);
    expect(ep.completeUpload.mock.calls[0]![0]).toBe("u-new");
    expect(ep.uploadChunk.mock.calls.map((c) => c[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 陈旧记录已被新会话覆盖，complete 成功后一并清掉
    expect(localStorage.getItem(key)).toBeNull();
    expect(result.current.progress).toBeNull();
  });

  it("存储的会话属于别的流程：不复用（挂载目标不能悄悄变），直接建新会话", async () => {
    const file = stubFile("pkg.iso", BIG);
    localStorage.setItem(keyOf("pkg.iso", BIG), JSON.stringify({ upload_id: "u-other", flow_id: "f2" }));

    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    await act(async () => {
      await result.current.upload(file);
    });

    expect(ep.uploadStatus).not.toHaveBeenCalled();
    expect(ep.initUpload).toHaveBeenCalledTimes(1);
    expect(ep.completeUpload.mock.calls[0]![0]).toBe("u-new");
  });

  it("localStorage 不可用（隐私模式/配额）：退化成普通上传，绝不因为存储炸掉", async () => {
    const file = stubFile("pkg.iso", BIG);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    let out!: Uploaded;
    await act(async () => {
      out = await result.current.upload(file);
    });

    expect(out).toEqual(entryOf("pkg.iso"));
    expect(ep.uploadChunk).toHaveBeenCalledTimes(BIG_CHUNKS);
    expect(ep.completeUpload).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("服务端给的 chunk_size 与本地不同：按服务端的值切片，片数与进度跟着改", async () => {
    const file = stubFile("pkg.iso", BIG);
    ep.initUpload.mockResolvedValue(initOf("u-odd", 16 * MB));

    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    await act(async () => {
      await result.current.upload(file);
    });

    expect(ep.uploadChunk).toHaveBeenCalledTimes(4);
    expect(ep.uploadChunk.mock.calls[3]![1]).toBe(3);
  });

  it("任一步 ApiError：提示服务端消息、busy 归位、进度清空、返回 null", async () => {
    const file = stubFile("pkg.iso", BIG);
    ep.uploadChunk.mockRejectedValue(new ApiError(413, "文件过大", [], null));

    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    let out!: Uploaded;
    await act(async () => {
      out = await result.current.upload(file);
    });

    expect(out).toBeNull();
    expect(pushToast).toHaveBeenCalledWith("文件过大", "error");
    expect(pushToast).not.toHaveBeenCalledWith(expect.stringContaining("上传完成"));
    expect(result.current.busy).toBe(false);
    expect(result.current.cancellable).toBe(false);
    expect(result.current.progress).toBeNull();
    // 失败不是取消：已建的会话留着，重传同一文件从中断处接上
    expect(JSON.parse(localStorage.getItem(keyOf("pkg.iso", BIG))!).upload_id).toBe("u-new");
  });

  it("失败后重传同一文件：拿回上次的会话续着发，不重复建会话", async () => {
    const file = stubFile("pkg.iso", BIG);
    const first = deferredOf<UploadChunkResult>();
    ep.uploadChunk.mockReturnValueOnce(first.promise);
    ep.uploadChunk.mockImplementation(
      (_id: string, index: number, _blob: Blob, _name: string, signal?: AbortSignal) =>
        signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(chunkOf(index)),
    );
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    await act(async () => {
      const p = result.current.upload(file);
      await flush();
      first.reject(new ApiError(500, "网络断了", [], null));
      await p;
    });
    expect(ep.initUpload).toHaveBeenCalledTimes(1);
    expect(ep.uploadChunk).toHaveBeenCalledTimes(1);

    ep.uploadStatus.mockImplementation((uploadId: string) =>
      Promise.resolve(statusOf(uploadId, [0])),
    );
    await act(async () => {
      await result.current.upload(file);
    });

    expect(ep.initUpload).toHaveBeenCalledTimes(1); // 第二轮没建新会话
    expect(ep.uploadChunk.mock.calls.map((c) => c[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 第二轮从 done=[0] 起跳，实际发出去的是 1..7
    expect(ep.uploadChunk.mock.calls.filter((c) => c[1] === 0)).toHaveLength(1);
  });
});

describe("useChunkedUpload 取消与重复触发", () => {
  it("上传进行中重复 upload()：直接返回 null 且不再发第二个请求", async () => {
    const gate = deferredOf<PackageEntry>();
    ep.uploadPackage.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useChunkedUpload(), { wrapper: wrapperOf(makeQc()) });

    let first!: Promise<Uploaded>;
    act(() => {
      first = result.current.upload(stubFile("a.tar", 1024));
    });
    await act(async () => {
      await flush();
    });
    expect(result.current.busy).toBe(true);

    let second!: Promise<Uploaded>;
    act(() => {
      second = result.current.upload(stubFile("b.tar", 2048));
    });
    // 先把闸门放行再断言：断言失败时也不会留下永不落地的 promise 拖累后面的用例
    gate.resolve(entryOf("a.tar"));
    await act(async () => {
      expect(await first).toEqual(entryOf("a.tar"));
      expect(await second).toBeNull();
    });

    expect(ep.uploadPackage).toHaveBeenCalledTimes(1);
    expect(ep.uploadPackage.mock.calls[0]![0] as FormData).toBeInstanceOf(FormData);
    expect(result.current.busy).toBe(false);

    // 上一轮结束后必须重新放行，否则钩子永久锁死
    ep.uploadPackage.mockResolvedValue(entryOf("b.tar"));
    await act(async () => {
      expect(await result.current.upload(stubFile("b.tar", 2048))).toEqual(entryOf("b.tar"));
    });
    expect(ep.uploadPackage).toHaveBeenCalledTimes(2);
  });
});

describe("useChunkedUpload 成功提示的诚实性", () => {
  it("缓存的流程没有 package_upload 阶段（upgrade）：绝不宣称「已挂到流程」", async () => {
    ep.uploadPackage.mockResolvedValue(entryOf("small.tar"));
    const qc = makeQc();
    qc.setQueryData(qk.flow("f1"), detailOf(["env_precheck", "upgrade_exec"]));
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), { wrapper: wrapperOf(qc) });

    await act(async () => {
      expect(await result.current.upload(stubFile("small.tar", 1024))).toEqual(entryOf("small.tar"));
    });

    expect(pushToast).toHaveBeenCalledWith("「small.tar」上传完成");
    expect(pushToast).not.toHaveBeenCalledWith(expect.stringContaining("挂到流程"));
  });

  it("缓存的流程确有 package_upload 阶段：照常说「已挂到流程」", async () => {
    ep.uploadPackage.mockResolvedValue(entryOf("small.tar"));
    const qc = makeQc();
    qc.setQueryData(qk.flow("f1"), detailOf(["env_precheck", "package_upload", "install_exec"]));
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), { wrapper: wrapperOf(qc) });

    await act(async () => {
      await result.current.upload(stubFile("small.tar", 1024));
    });

    expect(pushToast).toHaveBeenCalledWith("「small.tar」上传完成，已挂到流程「生产升级」");
  });

  it("流程详情还没进缓存：只说完成，不承诺挂载", async () => {
    ep.uploadPackage.mockResolvedValue(entryOf("small.tar"));
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    await act(async () => {
      await result.current.upload(stubFile("small.tar", 1024));
    });

    expect(pushToast).toHaveBeenCalledWith("「small.tar」上传完成");
  });

  it("无 flowId（纯登记）：提示里不提流程", async () => {
    ep.uploadPackage.mockResolvedValue(entryOf("small.tar"));
    const { result } = renderHook(() => useChunkedUpload(), { wrapper: wrapperOf(makeQc()) });

    await act(async () => {
      await result.current.upload(stubFile("small.tar", 1024));
    });

    expect(pushToast).toHaveBeenCalledWith("「small.tar」上传完成");
  });
});

describe("useChunkedUpload 卸载与状态收敛", () => {
  it("进度只在上传期间非 null：连续失败两次也不会挂着上次的半截进度", async () => {
    const file = stubFile("pkg.iso", BIG);
    ep.initUpload.mockRejectedValue(new ApiError(503, "服务暂不可用", [], null));
    const { result } = renderHook(() => useChunkedUpload("f1", "生产升级"), {
      wrapper: wrapperOf(makeQc()),
    });

    await act(async () => {
      expect(await result.current.upload(file)).toBeNull();
    });
    expect(result.current.progress).toBeNull();

    await act(async () => {
      expect(await result.current.upload(file)).toBeNull();
    });
    expect(result.current.progress).toBeNull();
  });

  it("卸载后迟到的响应不再 setState（act 环境里以 resolve 不炸为限）", async () => {
    const gate = deferredOf<PackageEntry>();
    ep.uploadPackage.mockReturnValue(gate.promise);
    const { result, unmount } = renderHook(() => useChunkedUpload(), {
      wrapper: wrapperOf(makeQc()),
    });

    let run!: Promise<Uploaded>;
    act(() => {
      run = result.current.upload(stubFile("small.tar", 1024));
    });
    await act(async () => {
      await flush();
    });
    unmount();
    gate.resolve(entryOf("small.tar"));
    await waitFor(async () => {
      expect(await run).toEqual(entryOf("small.tar"));
    });
  });
});
