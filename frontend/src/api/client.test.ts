import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "./client";

describe("api client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("JSON 请求带 content-type 且序列化 body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    await api.post("/api/flows", { name: "t", mode: "install" });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/api/flows");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init!.body).toBe(JSON.stringify({ name: "t", mode: "install" }));
  });

  it("FormData 请求不设置 content-type", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    const fd = new FormData();
    fd.append("file", new Blob(["x"]), "x.bin");
    await api.post("/api/packages/upload", fd);
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.headers ?? {}).not.toHaveProperty("content-type");
  });

  it("422 解析顶层 errors 到 fieldErrors", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ errors: ["「IP」必填"], message: "表单校验未通过" }), { status: 422 })
    );
    const err = (await api.post("/api/x", {}).catch((e) => e as ApiError)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.fieldErrors).toEqual(["「IP」必填"]);
    expect(err.message).toBe("表单校验未通过");
  });

  it("普通 detail 字符串作为 message", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ detail: "流程不存在" }), { status: 404 }));
    const err = (await api.get("/api/flows/nope").catch((e) => e as ApiError)) as ApiError;
    expect(err.message).toBe("流程不存在");
    expect(err.fieldErrors).toEqual([]);
  });

  it("非 JSON 错误体回退到 statusText", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("网关超时", { status: 502, statusText: "Bad Gateway" }));
    const err = (await api.get("/api/x").catch((e) => e as ApiError)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe("Bad Gateway");
    expect(err.fieldErrors).toEqual([]);
  });
});
