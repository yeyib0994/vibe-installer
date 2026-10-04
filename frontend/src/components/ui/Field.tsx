import type { ReactNode } from "react";

/** 表单微基元：label 在上、控件居中、hint 在下。M4 动态表单复用此 API。 */

export const inputCls =
  "w-full rounded-btn border border-line bg-panel px-2.5 py-1.5 text-sm text-ink outline-none " +
  "placeholder:text-ink-mute focus:border-brand focus:ring-2 focus:ring-brand/20";

export const labelCls = "text-xs font-medium text-ink-soft";

/**
 * 注意：Field 外层是 <label>（点击文字即聚焦控件），因此一个 Field 内只允许放
 * 一个表单控件；不要在其中嵌套第二个 input/textarea/select。
 * M4 的 node_table、复选框行等多控件字段不属于此契约：整块用独立组件渲染，
 * 需要多个控件时并列多个 Field，而不是塞进同一个 Field。
 */
export function Field({ label, hint, children, className = "" }: {
  label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-4 text-ink-mute">{hint}</span>}
    </label>
  );
}
