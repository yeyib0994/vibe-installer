/**
 * K8s 集群页的纯函数：后端回执（整坨 node stderr / 未校验的 helm JSON 单元格）→ 可读文本。
 * 页面只 export 组件，这些可单测的收口逻辑与 lib/format.ts、lib/summarize.ts 同处一层。
 */

/** 截断上限：超出就留省略号，静默砍尾会让读者以为那是完整的一行。 */
const MAX_LENGTH = 240;

/**
 * 后端把 node 的 stderr 原样塞进 error（真机抓到的是一整坨 MODULE_NOT_FOUND 栈，770+ 字符），
 * 栈帧对运维毫无意义：宁可退回固定文案也不能把 node:internal 端上页面。
 * 顺序很关键——必须先滤掉栈帧再挑行：帧里也带 Error 字样（emitErrorNT、new NodeError），
 * 而进程被杀 / stderr 被截断时后端往往只回一堆帧，先挑行就会把帧当成错误信息。
 * node 的致命信息排在帧块之前，所以取滤帧后最后一条匹配行，而不是第一条（第一条常是 harmless 的
 * 「warning: retrying after error…」这类噪声）。
 */
export function releaseError(raw: string): string {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const INFO = /Error|not recognized|Cannot find module|command not found|connection refused|Unauthorized/i;
  const FRAME = /^(at |\}|throw err\b|Node\.js v)/i;
  const clean = lines.filter((l) => !FRAME.test(l) && !l.includes("node:internal"));
  let hit: string | undefined;
  for (const l of clean) if (INFO.test(l)) hit = l;
  const text = hit ?? clean[0];
  if (!text) return "后端未返回可读的错误信息";
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}

/** 后端零校验，整份 YAML 原文也进得了这张表（虽然 k8s-ops 会按 base64 解码它）：表格只显示首行，其余留给 title。 */
export function kubeFirstLine(raw: string): string {
  return raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

/** helm list -o json 的字段未经校验，逐个 unknown 收口成可读文本。 */
export function cell(v: unknown): string {
  return v === undefined || v === null || v === "" ? "—" : String(v);
}
