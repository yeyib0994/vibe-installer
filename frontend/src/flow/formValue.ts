import type { FlowStage, FormField } from "../api/types";

/** 后端 number 字段一律 Integer.parseInt（Workflow.validateStageInputs），只接受整数串。 */
const INT_ONLY = /^[+-]?\d+$/;

/**
 * I3：提交某阶段表单必须是 `{ ...stage.inputs, ...collected }`。
 *
 * 服务端把执行产物写进 stage.inputs 的下划线键（`_package_id` / `_package_ids`
 * ——ApiController 上传回填；`_distribution_id` / `_backup_id` ——StageExecutor 回填），
 * 这些键不在表单里，整体替换 inputs 会把它们抹掉，包分发阶段随即拿不到包。
 * collected 只能覆盖同名键；空数组的下划线键也要按 key 存活（后端按 containsKey/getOrDefault 取值）。
 */
export const mergeInputs = (
  server: Record<string, unknown>,
  collected: Record<string, unknown>,
): Record<string, unknown> => ({ ...server, ...collected });

/**
 * 把控件里的原始值转成后端要的 JSON 形态。目录里真实存在的 type：
 * text | number | select | multiselect | boolean | textarea | node_table。
 */
export function coerce(field: FormField, raw: unknown): unknown {
  if (field.type === "number") {
    if (raw == null || raw === "") return "";
    if (typeof raw !== "string") return raw;
    const s = raw.trim();
    if (s === "") return "";
    // trim 后仍非整数（"abc" / "2.5"）就原样回传：后端会给出「XXX 必须是数字」的字段错误。
    // 变成 0 会写进库，变成 "" 会让必填校验静默放行——两者都丢用户的输入。
    return INT_ONLY.test(s) ? Number(s) : raw;
  }
  // multiline_list 只由 textareaField 写入（Workflow.field 只在 true 时落键），
  // 真实目录里它从不与 number / boolean / node_table 同时出现，故与类型分支无争用；
  // 放在 number 之后纯粹是防御。
  if (field.multiline_list) {
    if (Array.isArray(raw)) return raw;
    return String(raw ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (field.type === "boolean") return Boolean(raw);
  // ApiController 对 physical_nodes / virtual_nodes 是硬转 List<Map>，必须交数组。
  if (field.type === "node_table") return Array.isArray(raw) ? raw : [];
  // multiselect 同理：后端 asStringList 虽容错，但 UI 与必填判空都按数组走。
  if (field.type === "multiselect") {
    if (Array.isArray(raw)) return raw;
    if (raw == null || raw === "") return [];
    return String(raw).replace(/，/g, ",").split(",").map((s) => s.trim()).filter(Boolean);
  }
  // text / select / textarea(未标 multiline_list) 兜底：不得字符串化，
  // 因为 text 字段可能带数组值（smoke_endpoints 的 default 就是 List）。
  return raw ?? "";
}

/**
 * 表单初值：已提交的 inputs 优先，其次字段 default，最后按 type 给空值。
 * `default` 为 null 时后端不落键（Workflow.field），所以 default 可能整个缺失。
 */
export function initialValues(stage: FlowStage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of stage.form_fields) {
    const stored = stage.inputs[f.key];
    out[f.key] = stored !== undefined
      ? stored
      : (f.default ?? (f.type === "boolean" ? false
        : f.type === "node_table" || f.type === "multiselect" ? []
        : ""));
  }
  return out;
}

/** 采集 → 按字段转换 → 合并服务端 inputs（I3）。 */
export function collect(stage: FlowStage, values: Record<string, unknown>): Record<string, unknown> {
  const collected: Record<string, unknown> = {};
  for (const f of stage.form_fields) {
    // values 里没有该键说明这份 values 不属于本阶段（或尚未初始化），
    // 此时跳过而不是写空值，免得把服务端已存的下划线无关键清掉。
    if (!(f.key in values)) continue;
    collected[f.key] = coerce(f, values[f.key]);
  }
  return mergeInputs(stage.inputs, collected);
}
