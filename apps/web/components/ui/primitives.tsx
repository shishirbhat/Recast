import type { ButtonHTMLAttributes, ReactNode } from "react";

const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(" ");

export function Button({ variant = "default", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" }) {
  return <button {...p} className={cx(
    "inline-flex h-9 items-center rounded-(--r-pill) border px-4 text-[13px] font-medium transition-[background-color,transform] duration-(--dur-fast) active:scale-[.97] disabled:opacity-50",
    variant === "primary" && "border-transparent bg-accent text-on-accent hover:brightness-105",
    variant === "default" && "border-soft bg-raised text-ink hover:bg-sunken",
    variant === "danger" && "border-danger-ink bg-raised text-danger-ink hover:bg-sunken", className)} />;
}
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-(--r-panel) border border-soft bg-raised p-5 shadow-(--shadow-rest)", className)}>{children}</section>;
}
export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "warn" | "danger" }) {
  const t = { muted: "text-muted", ok: "text-ok-ink", warn: "text-warn-ink", danger: "text-danger-ink" }[tone];
  return <span className={cx("inline-flex items-center rounded-(--r-pill) border border-soft px-2 py-0.5 text-[11px] font-medium", t)}>{children}</span>;
}
export function PageHeader({ title, lead }: { title: string; lead: string }) {
  return <header className="mb-8"><h1 className="text-[40px]">{title}</h1><p className="mt-2 max-w-prose text-muted">{lead}</p></header>;
}
export function Empty({ children }: { children: ReactNode }) { return <p className="rounded-(--r-panel) border border-dashed border-line p-6 text-center text-muted">{children}</p>; }
