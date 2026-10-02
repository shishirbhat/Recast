import type { ButtonHTMLAttributes, ReactNode } from "react";

const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(" ");

export function Button({ variant = "default", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" }) {
  return <button {...p} className={cx(
    "inline-flex h-8 items-center rounded-(--r-pill) border px-4 text-xs font-medium transition-colors duration-(--dur-fast) disabled:opacity-50",
    variant === "primary" && "border-transparent bg-accent text-on-accent",
    variant === "default" && "border-soft bg-raised text-ink hover:bg-sunken",
    variant === "danger" && "border-danger bg-raised text-danger hover:bg-sunken", className)} />;
}
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-(--r-panel) border border-soft bg-raised p-5", className)}>{children}</section>;
}
export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "warn" | "danger" }) {
  const t = { muted: "text-muted", ok: "text-ok", warn: "text-warn", danger: "text-danger" }[tone];
  return <span className={cx("inline-flex items-center rounded-(--r-pill) border border-soft px-2 py-0.5 text-[11px] font-medium", t)}>{children}</span>;
}
export function PageHeader({ title, lead }: { title: string; lead: string }) {
  return <header className="mb-6"><h1 className="text-xl font-semibold">{title}</h1><p className="mt-1 max-w-prose text-muted">{lead}</p></header>;
}
export function Empty({ children }: { children: ReactNode }) { return <p className="rounded-(--r-panel) border border-dashed border-line p-6 text-center text-muted">{children}</p>; }
