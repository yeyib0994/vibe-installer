/**
 * API 请求层 —— 与 backend-java/ApiController 的错误形态对齐。
 *
 * 后端错误体有三种形态：
 * 1. ApiException(status, "消息")        → `{"detail": "消息"}`
 * 2. ApiException(status, Map)（422 校验）→ Map 本身即响应体：顶层 `{"errors": string[], "message": string}`
 * 3. 非 JSON / 网关错误                    → 纯文本或空体，回退到 statusText
 */

export class ApiError extends Error {
  status: number;
  fieldErrors: string[];
  data: unknown;

  constructor(status: number, message: string, fieldErrors: string[], data: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.data = data;
  }
}

const BASE = import.meta.env.VITE_API_BASE ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const body = parsed as { detail?: unknown; errors?: unknown; message?: unknown } | undefined;
    const detail = body?.detail;
    if (typeof detail === "string") throw new ApiError(res.status, detail, [], parsed);
    if (detail && typeof detail === "object") {
      const d = detail as { errors?: string[]; message?: string; detail?: string };
      throw new ApiError(res.status, d.message ?? d.detail ?? "请求失败", d.errors ?? [], parsed);
    }
    // 422 校验失败：ApiController 把 {errors, message} 直接作为响应体（顶层，不包 detail）
    if (Array.isArray(body?.errors)) {
      throw new ApiError(res.status, String(body?.message ?? "请求失败"), body.errors as string[], parsed);
    }
    throw new ApiError(res.status, res.statusText || "请求失败", [], parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    body instanceof FormData
      ? request<T>(path, { method: "POST", body })
      : request<T>(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
