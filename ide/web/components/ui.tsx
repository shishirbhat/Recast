"use client";

import { motion } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import type { TaskState } from "@/lib/types";

/** Relay's mark: two strokes handing a point between them. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 15.5c0-4.7 3.4-8.5 8-8.5" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M20 8.5c0 4.7-3.4 8.5-8 8.5" stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.2" fill="var(--attention)" />
    </svg>
  );
}

type ButtonTone = "primary" | "quiet" | "ghost" | "danger";
export function Button({ tone = "quiet", size = "md", className = "", children, ...rest }: ComponentProps<"button"> & { tone?: ButtonTone; size?: "sm" | "md" }) {
  const tones: Record<ButtonTone, string> = {
    primary: "bg-accent text-accent-fg hover:brightness-110 active:translate-y-px",
    quiet: "bg-sunken text-ink border border-rule hover:border-rule-strong hover:bg-hover active:translate-y-px",
    ghost: "text-ink-2 hover:bg-sunken hover:text-ink",
    danger: "bg-danger-soft text-danger hover:brightness-95",
  };
  const sizes = { sm: "h-[24px] px-2 text-[12px] gap-1.5", md: "h-[26px] px-3 text-[13px] gap-1.5" };
  return (
    <button
      className={`inline-flex items-center justify-center rounded-sm font-medium transition-[background,border,color,filter] duration-150 disabled:opacity-45 disabled:pointer-events-none ${tones[tone]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = "", ...rest }: ComponentProps<"button"> & { label: string }) {
  return (
    <button aria-label={label} title={label} className={`grid size-8 place-items-center rounded-sm text-muted transition-colors hover:bg-sunken hover:text-ink ${className}`} {...rest}>
      {children}
    </button>
  );
}

const STATE_STYLE: Record<TaskState, { label: string; cls: string; dot: string }> = {
  proposed: { label: "Proposed", cls: "bg-sunken text-muted", dot: "bg-faint" },
  queued: { label: "Ready", cls: "text-ink-2 ring-1 ring-inset ring-rule-strong", dot: "bg-muted" },
  running: { label: "Working", cls: "bg-accent-soft text-accent-ink", dot: "bg-accent animate-pulse" },
  blocked: { label: "Blocked", cls: "bg-danger-soft text-danger", dot: "bg-danger" },
  review_required: { label: "In review", cls: "bg-warn-soft text-warn", dot: "bg-warn" },
  failed: { label: "Failed", cls: "bg-danger-soft text-danger", dot: "bg-danger" },
  cancelled: { label: "Cancelled", cls: "bg-sunken text-faint line-through", dot: "bg-faint" },
  completed: { label: "Approved", cls: "bg-ok-soft text-ok", dot: "bg-ok" },
};

export function StatePill({ state }: { state: TaskState }) {
  const s = STATE_STYLE[state];
  return (
    <span className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em] ${s.cls}`}>
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "attention" }) {
  const tones = {
    neutral: "bg-sunken text-ink-2",
    accent: "bg-accent-soft text-accent-ink",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
    attention: "bg-attention-soft text-attention",
  };
  return <span className={`inline-flex h-[18px] items-center gap-1 rounded-sm px-1.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : (parts[0]?.[1] ?? ""))).toUpperCase();
}

export function Avatar({ name, color, size = 28, ring = false, title }: { name: string; color: string; size?: number; ring?: boolean; title?: string }) {
  return (
    <motion.span
      layout
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.6, opacity: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}
      title={title ?? name}
      className="relative grid shrink-0 place-items-center rounded-full font-semibold text-white select-none"
      style={{ width: size, height: size, background: color, fontSize: size * 0.36, letterSpacing: "0.02em", boxShadow: ring ? `0 0 0 2px var(--page), 0 0 0 3.5px ${color}` : "0 0 0 2px var(--page)" }}
    >
      {initials(name)}
    </motion.span>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1 pb-2 pt-1">
      <span className="micro text-muted">{children}</span>
      {right}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
