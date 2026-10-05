import { ApiError } from "../../api/client";
import { Button } from "./Button";

/**
 * 查询失败的统一呈现：错误绝不能落到「空」或「永久加载中」那一个分支上。
 * 消息优先用后端原话（ApiError.message 即 detail / 校验 message），网络层失败才退到通用文案。
 */
export function QueryError({
  label,
  error,
  onRetry,
  retrying,
}: {
  label: string;
  error?: unknown;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const detail =
    error instanceof ApiError
      ? error.message
      : error instanceof Error && error.message
        ? error.message
        : "";
  return (
    <div className="flex items-center gap-3">
      <div className="text-sm text-danger">
        {label}
        {detail ? `：${detail}` : "：网络异常或后端未响应"}
      </div>
      <Button size="sm" variant="ghost" disabled={retrying} onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
