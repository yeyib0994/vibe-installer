import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, apiUrl, ApiError } from "./client";

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

  it("非 JSON 短文本错误体优先使用后端文本", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("网关超时", { status: 502, statusText: "Bad Gateway" }));
    const err = (await api.get("/api/x").catch((e) => e as ApiError)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe("网关超时");
    expect(err.fieldErrors).toEqual([]);
  });

  it("超长非 JSON 错误体回退到 statusText", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(`<html><body>${"nginx error page ".repeat(40)}</body></html>`, { status: 502, statusText: "Bad Gateway" })
    );
    const err = (await api.get("/api/x").catch((e) => e as ApiError)) as ApiError;
    expect(err.message).toBe("Bad Gateway");
  });

  it("Spring 默认 500 错误体（无 detail）生成可读消息", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          timestamp: "2026-10-29T10:00:00.000+08:00",
          status: 500,
          error: "Internal Server Error",
          path: "/api/packages/upload",
        }),
        { status: 500, statusText: "" }
      )
    );
    const err = (await api.post("/api/packages/upload", new FormData()).catch((e) => e as ApiError)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("500");
    expect(err.message).toContain("服务器错误");
    expect(err.message).toContain("/api/packages/upload");
    expect(err.message).not.toBe("请求失败");
    expect(err.message).not.toContain("[object Object]");
  });

  it("Spring 真实 message 优先于状态码描述", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ timestamp: "x", status: 500, error: "Internal Server Error", message: "数据库连接池耗尽", path: "/api/flows" }), {
        status: 500,
        statusText: "",
      })
    );
    const err = (await api.get("/api/flows").catch((e) => e as ApiError)) as ApiError;
    expect(err.message).toBe("数据库连接池耗尽");
  });

  it("忽略 Servlet 占位 message（No message available）", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 500, message: "No message available", error: "Internal Server Error", path: "/api/x" }), {
        status: 500,
        statusText: "",
      })
    );
    const err = (await api.get("/api/x").catch((e) => e as ApiError)) as ApiError;
    expect(err.message).not.toContain("No message available");
    expect(err.message).toContain("服务器错误");
  });

  it("413 上传超限错误体可读", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ timestamp: "x", status: 413, error: "Payload Too Large", path: "/api/packages/upload" }), {
        status: 413,
        statusText: "",
      })
    );
    const err = (await api.post("/api/packages/upload", new FormData()).catch((e) => e as ApiError)) as ApiError;
    expect(err.status).toBe(413);
    expect(err.message).toContain("413");
    expect(err.message).toContain("文件过大");
    expect(err.message).toContain("/api/packages/upload");
    expect(err.message).not.toBe("请求失败");
  });

  it("空错误体且无 statusText 时回退请求失败", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 500, statusText: "" }));
    const err = (await api.get("/api/x").catch((e) => e as ApiError)) as ApiError;
    expect(err.message).toBe("请求失败");
  });

  it("apiUrl 在未配置 VITE_API_BASE 时原样返回相对路径", async () => {
    const path = "/api/flows/f-1/stages/install/stream";
    expect(apiUrl(path)).toBe(path);
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    await api.get(path);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(apiUrl(path));
  });
});
