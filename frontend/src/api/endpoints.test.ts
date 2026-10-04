import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { endpoints } from "./endpoints";

// Response 体只能读一次：每次调用必须生成新实例（计划原文复用同一实例会触发
// "Body has already been read"，此处仅修测试桩，不改断言）。
const stub = (data: unknown) =>
  vi.mocked(fetch).mockImplementation(async () =>
    new Response(JSON.stringify(data), { status: 200 }));

describe("endpoints URLs", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const urlOf = (i: number) => vi.mocked(fetch).mock.calls[i]![0] as string;
  const initOf = (i: number) => vi.mocked(fetch).mock.calls[i]![1]!;

  it("阶段动作路径", async () => {
    stub({ ok: true });
    await endpoints.runStage("f1", "env_precheck", { operator: "admin", confirm: false });
    expect(urlOf(0)).toBe("/api/flows/f1/stages/env_precheck/run");
    expect(initOf(0).method).toBe("POST");

    await endpoints.cancelStage("f1", "env_precheck");
    expect(urlOf(1)).toBe("/api/flows/f1/stages/env_precheck/cancel");

    await endpoints.validateStage("f1", "env_register", { a: 1 });
    expect(urlOf(2)).toBe("/api/flows/f1/stages/env_register/validate");
    expect(JSON.parse(initOf(2).body as string)).toEqual({ inputs: { a: 1 } });
  });

  it("K8s 与回滚路径", async () => {
    stub({});
    await endpoints.listClusters();
    await endpoints.rollback("f9", 3);
    expect(urlOf(0)).toBe("/api/k8s/clusters");
    expect(urlOf(1)).toBe("/api/flows/f9/rollback");
    expect(JSON.parse(initOf(1).body as string)).toEqual({ revision: 3 });
  });

  it("分片上传用 FormData 且字段名与后端一致", async () => {
    stub({});
    await endpoints.uploadChunk("u1", 7, new Blob(["x"]), "part");
    const fd = vi.mocked(fetch).mock.calls.at(-1)![1]!.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get("upload_id")).toBe("u1");
    expect(fd.get("chunk_index")).toBe("7");
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toBe("/api/packages/upload/chunk");
  });
});
