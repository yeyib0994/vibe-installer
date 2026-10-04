import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger" | "quiet";

const V: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-dark disabled:bg-ink-mute",
  ghost: "bg-panel text-ink border border-line hover:border-brand hover:text-brand",
  danger: "bg-panel text-danger border border-line hover:border-danger",
  quiet: "bg-transparent text-ink-soft hover:text-ink",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  children: ReactNode;
}

export function Button({ variant = "primary", size = "md", className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={[
        "inline-flex items-center gap-1.5 rounded-btn font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        V[variant],
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
