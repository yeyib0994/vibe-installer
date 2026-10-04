/**
 * API 请求层 —— 与 backend-java/ApiController 的错误形态对齐。
 *
 * 后端错误体有四种形态：
 * 1. ApiException(status, "消息")        → `{"detail": "消息"}`
 * 2. ApiException(status, Map)（422 校验）→ Map 本身即响应体：顶层 `{"errors": string[], "message": string}`
 * 3. 非 ApiException（如 413 超限、原始 500）→ Spring 默认错误 Map `{timestamp, status, error, message?, path}`，
 *    常无可用 message；跨域时 statusText 为空，需从该 Map 组装可读消息
 * 4. 纯文本 / 空体                        → 短文本直接用作消息，否则回退 statusText、再回退 "请求失败"
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

/** 请求与 SSE（EventSource 需完整 URL）共用的唯一 base 拼接点。 */
export const apiUrl = (path: string) => `${BASE}${path}`;

/** Spring/Servlet 状态码 → 中文可读标签；未命中时退化为后端 error 短语或 statusText。 */
const STATUS_LABELS: Record<number, string> = {
  400: "请求无效",
  401: "登录状态已失效",
  403: "无访问权限",
  404: "资源不存在",
  405: "请求方法不被支持",
  408: "请求超时",
  409: "资源状态冲突",
  413: "文件过大",
  415: "不支持的媒体类型",
  422: "数据校验未通过",
  429: "请求过于频繁",
  500: "服务器错误",
  502: "网关错误",
  503: "服务暂不可用",
  504: "网关超时",
};

const NO_MESSAGE_PLACEHOLDER = /^no message available\b/i;
const MAX_PLAIN_TEXT_LENGTH = 200;

function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 兜底消息：从后端实际发送的内容里尽量提取可读信息（Spring 默认错误 Map / 纯文本），
 * 只有在确实无信息可用时才返回 "请求失败"。
 */
function fallbackMessage(status: number, statusText: string, body: unknown): string {
  const text = trimmedText(statusText);

  if (typeof body === "string") {
    const plain = body.trim();
    if (plain && plain.length <= MAX_PLAIN_TEXT_LENGTH) return plain;
    return text || "请求失败";
  }

  if (body && typeof body === "object") {
    const b = body as { message?: unknown; error?: unknown; path?: unknown };
    const message = trimmedText(b.message);
    if (message && !NO_MESSAGE_PLACEHOLDER.test(message)) return message;
    const label = STATUS_LABELS[status] || trimmedText(b.error) || text;
    if (label) {
      const path = trimmedText(b.path);
      return `${status} ${label}${path ? `（${path}）` : ""}`;
    }
    return text || "请求失败";
  }

  return text || "请求失败";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init);
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
    const fallback = () => fallbackMessage(res.status, res.statusText, parsed);
    const body = parsed as { detail?: unknown; errors?: unknown; message?: unknown } | undefined;
    const detail = body?.detail;
    if (typeof detail === "string") throw new ApiError(res.status, detail.trim() || fallback(), [], parsed);
    if (detail && typeof detail === "object") {
      const d = detail as { errors?: string[]; message?: unknown; detail?: unknown };
      const message = trimmedText(d.message) || trimmedText(d.detail);
      throw new ApiError(res.status, message || fallback(), d.errors ?? [], parsed);
    }
    // 422 校验失败：ApiController 把 {errors, message} 直接作为响应体（顶层，不包 detail）
    if (Array.isArray(body?.errors)) {
      throw new ApiError(res.status, trimmedText(body.message) || fallback(), body.errors as string[], parsed);
    }
    throw new ApiError(res.status, fallback(), [], parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  /**
   * opts.signal 让调用方能真的中断一个 POST：fetch 收到 abort 后以 name="AbortError" 的
   * DOMException 拒绝（不传 signal 时行为与之前完全一致）。
   * 注意取消只在「请求还没发出去」或「分片之间」有意义——Spring 只要收完请求体就已经注册了包，
   * 客户端断开并不能收回单次 multipart 上传的结果，所以别把它包装成可取消的操作。
   */
  post: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) =>
    body instanceof FormData
      ? request<T>(path, { method: "POST", body, signal: opts?.signal })
      : request<T>(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: opts?.signal,
        }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
