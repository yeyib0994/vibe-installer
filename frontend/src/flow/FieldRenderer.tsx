import { useId, type ReactNode } from "react";
import { Field, inputCls, labelCls } from "../components/ui/Field";
import { NodeMatrixEditor } from "./NodeMatrixEditor";
import type { NodeRow } from "./NodeMatrixEditor";
import type { FieldOption, FormField } from "../api/types";

export interface FieldRendererProps {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}

const hintCls = "mt-1 block text-[11px] leading-4 text-ink-mute";

const labelText = (field: FormField) => (
  <>
    {field.label}
    {field.required && <span className="text-danger"> *</span>}
  </>
);

const hintOf = (field: FormField) => field.help || field.hint || undefined;

/** 仅用于显示：数组值串接成可读文本，服务端 Workflow.asStringList 会按逗号切回数组。 */
const display = (value: unknown, sep: string): string =>
  Array.isArray(value) ? value.map((v) => String(v ?? "")).join(sep) : String(value ?? "");

const toList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "")).filter((s) => s !== "");
  if (value == null || value === "") return [];
  return String(value).replace(/，/g, ",").split(",").map((s) => s.trim()).filter(Boolean);
};

const optionValues = (options: FieldOption[]): string[] => options.map((o) => o.value);

/** 目录里一个字段可能对应多个控件（复选框组、节点矩阵），不能塞进 Field 的 <label>。 */
function GroupBlock({ labelId, label, hint, children }: {
  labelId: string; label: ReactNode; hint?: string; children: ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={labelId} className="col-span-full min-w-0">
      <span id={labelId} className={`mb-1 block ${labelCls}`}>{label}</span>
      {children}
      {hint && <span className={hintCls}>{hint}</span>}
    </div>
  );
}

export function FieldRenderer({ field, value, onChange, disabled }: FieldRendererProps) {
  const labelId = useId();
  const label = labelText(field);
  const hint = hintOf(field);

  if (field.readonly) {
    // 只读不等于 disabled：值仍然受控回流，I3 的 {...stage.inputs, ...collected} 才带得上注入值。
    return (
      <Field label={label} hint={hint}>
        <input
          readOnly
          aria-readonly="true"
          className={`${inputCls} cursor-default bg-canvas font-mono text-ink-soft`}
          value={display(value, ", ")}
        />
      </Field>
    );
  }

  if (field.type === "node_table") {
    return (
      <GroupBlock labelId={labelId} label={label} hint={hint}>
        <NodeMatrixEditor
          field={field}
          value={(Array.isArray(value) ? value : []) as NodeRow[]}
          onChange={onChange}
          disabled={disabled}
        />
      </GroupBlock>
    );
  }

  if (field.type === "multiselect") {
    const options = field.options ?? [];
    const candidates = optionValues(options);
    const chosen = toList(value);
    // 回传按目录候选顺序排列，候选外的历史值保持原相对顺序，避免重排掩盖真实值。
    const orderLikeCatalog = (list: string[]) => [
      ...candidates.filter((v) => list.includes(v)),
      ...list.filter((v) => !candidates.includes(v)),
    ];
    const toggle = (opt: string, on: boolean) => {
      const next = chosen.filter((v) => v !== opt);
      if (on) next.push(opt);
      onChange(orderLikeCatalog(next));
    };
    return (
      <GroupBlock labelId={labelId} label={label} hint={hint}>
        {options.length === 0 ? (
          <p className="text-xs text-ink-mute">目录未下发可选项</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {options.map((o) => (
              <label key={o.value} className="inline-flex items-center gap-1.5 text-xs text-ink">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand"
                  disabled={disabled}
                  checked={chosen.includes(o.value)}
                  onChange={(e) => toggle(o.value, e.target.checked)}
                />
                {o.label}
              </label>
            ))}
          </div>
        )}
      </GroupBlock>
    );
  }

  if (field.type === "select") {
    const options = field.options ?? [];
    const cur = display(value, ",");
    if (options.length === 0) {
      return (
        <Field label={label} hint={hint}>
          <input
            disabled={disabled}
            className={inputCls}
            value={cur}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );
    }
    return (
      <Field label={label} hint={hint}>
        <select
          disabled={disabled}
          className={inputCls}
          value={cur}
          onChange={(e) => onChange(e.target.value)}
        >
          {!optionValues(options).includes(cur) && (
            <option value={cur}>{cur || "（未选择）"}</option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === "boolean") {
    const on = Boolean(value);
    return (
      <Field label={label} hint={hint}>
        {/* <label> 的隐式关联覆盖不到 <button>，显式补可访问名。 */}
        <button
          type="button"
          role="switch"
          aria-label={field.label}
          aria-checked={on}
          disabled={disabled}
          onClick={() => onChange(!on)}
          className={`relative h-6 w-11 rounded-full border transition-colors ${
            on ? "border-brand bg-brand" : "border-line bg-canvas"
          } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
        >
          <span
            className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-panel shadow-card transition-all ${
              on ? "left-[22px]" : "left-[2px]"
            }`}
          />
        </button>
      </Field>
    );
  }

  if (field.type === "textarea") {
    return (
      <Field label={label} hint={hint} className="col-span-full">
        <textarea
          disabled={disabled}
          className={`${inputCls} h-24 font-mono`}
          value={display(value, "\n")}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint}>
      <input
        disabled={disabled}
        type={field.type === "number" ? "number" : "text"}
        className={inputCls}
        value={display(value, ", ")}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
