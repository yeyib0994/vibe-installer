import type { ReactNode } from "react";

export function Table({ head, children, className = "" }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-canvas text-left text-xs font-semibold text-ink-mute">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 first:pl-4 last:pr-4">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// 宽度载体：Table 已把每个 head 项包进 <th>，所以这里不能再输出 <th>
// （嵌套 <th> 非法，React 会报 hydration 错误，浏览器解析器还会把它拆成兄弟单元格）。
// 用 block 元素撑出列宽即可，auto 布局下列宽取内容最大宽度。
export function Th({ children, w }: { children?: ReactNode; w?: number }) {
  return (
    <span className="block" style={{ width: w }}>
      {children}
    </span>
  );
}

export function Tr({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={`border-t border-line hover:bg-brand-soft/60 ${onClick ? "cursor-pointer" : ""}`}
    >
      {children}
    </tr>
  );
}

export function Td({ children, colSpan, className = "" }: { children: ReactNode; colSpan?: number; className?: string }) {
  return (
    <td colSpan={colSpan} className={`px-3 py-2.5 align-middle first:pl-4 last:pr-4 ${className}`}>
      {children}
    </td>
  );
}
