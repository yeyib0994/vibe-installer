import { FieldRenderer } from "./FieldRenderer";
import type { FormField } from "../api/types";

export interface DynamicFormProps {
  fields: FormField[];
  values: Record<string, unknown>;
  onChange: (key: string, v: unknown) => void;
  disabled?: boolean;
}

/**
 * 阶段表单的栅格容器：只渲染目录下发的 fields，键与 values 一一对应。
 * 服务端 artifacts（_package_id 等下划线键）不在 fields 里，因此这里既不渲染也不回吐，
 * 由 T4.1 的 collect 合并 stage.inputs 保住（不变量 I3）。
 */
export function DynamicForm({ fields, values, onChange, disabled }: DynamicFormProps) {
  if (fields.length === 0) {
    return <p className="text-xs text-ink-mute">本阶段无需填写参数，直接执行即可。</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
      {fields.map((f) => (
        <FieldRenderer
          key={f.key}
          field={f}
          disabled={disabled}
          value={values[f.key]}
          onChange={(v) => onChange(f.key, v)}
        />
      ))}
    </div>
  );
}
