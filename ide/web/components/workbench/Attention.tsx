"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Eye, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";

/**
 * "Is anything blocking me, and what should I do next?" Computed on the server (`src/analysis/attention.ts`) for this
 * person: only situations that need someone, each with why it is theirs and one next action. Marking an item seen
 * hides that exact situation for this person; if it changes, it comes back.
 */
export interface AttentionItem {
  key: string;
  /** block: work can't proceed; review: someone has to look; info: worth knowing, nothing broken. */
  level: "block" | "review" | "info";
  title: string;
  why: string;
  forYou: string;
  seen: boolean;
  action: { label: string; run: () => void };
}

type Target = { kind: "task"; id: string } | { kind: "contracts" } | { kind: "conflict"; id: string; path: string } | { kind: "tests" } | { kind: "coordination" };
interface ServerItem extends Omit<AttentionItem, "action"> {
  target: Target;
  action: string;
  at: string | null;
}

export interface AttentionActions {
  openTask: (id: string) => void;
  openContracts: () => void;
  resolveConflict: (id: string, path: string) => void;
  showTests: () => void;
  openCoordination: () => void;
}

/** The server's inbox for this person, refreshed shortly after project activity (`tick`). */
export function useAttention(tick: unknown, go: AttentionActions): { items: AttentionItem[]; setSeen: (keys: string[], seen: boolean) => void } {
  const [raw, setRaw] = useState<ServerItem[]>([]);
  const load = useCallback(() => void api<{ items: ServerItem[] }>("GET", "/attention").then((r) => setRaw(r.items), () => {}), []);
  useEffect(() => {
    const t = setTimeout(load, 600);
    return () => clearTimeout(t);
  }, [tick, load]);
  const items = useMemo(
    () =>
      raw.map((i): AttentionItem => {
        const t = i.target;
        const run = t.kind === "task" ? () => go.openTask(t.id) : t.kind === "contracts" ? go.openContracts : t.kind === "conflict" ? () => go.resolveConflict(t.id, t.path) : t.kind === "tests" ? go.showTests : go.openCoordination;
        return { key: i.key, level: i.level, title: i.title, why: i.why, forYou: i.forYou, seen: i.seen, action: { label: i.action, run } };
      }),
    [raw, go],
  );
  const setSeen = useCallback((keys: string[], seen: boolean) => {
    setRaw((r) => r.map((i) => (keys.includes(i.key) ? { ...i, seen } : i)));
    void api("POST", "/attention/seen", { keys, seen }).then(load, load);
  }, [load]);
  return { items, setSeen };
}

const ICON = {
  block: <CircleAlert size={14} className="mt-px shrink-0 text-danger" />,
  review: <Eye size={14} className="mt-px shrink-0 text-warn" />,
  info: <TriangleAlert size={14} className="mt-px shrink-0 text-muted" />,
};

/** The title-bar control and its list. Quiet when there is nothing to do. */
export function AttentionButton({ items, setSeen }: { items: AttentionItem[]; setSeen: (keys: string[], seen: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Keyboard: opening moves focus to the first action; Escape closes and returns focus to where it was (the editor).
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement && !box.current?.contains(document.activeElement) ? document.activeElement : null;
    requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>("[role=dialog] button")?.focus());
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        setOpen(false);
        returnTo.current?.focus();
      } else if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => (window.removeEventListener("mousedown", close), window.removeEventListener("keydown", close));
  }, [open]);
  useEffect(() => {
    const toggle = () => setOpen((o) => !o);
    window.addEventListener("relay:attention", toggle);
    return () => window.removeEventListener("relay:attention", toggle);
  }, []);
  const needs = items.filter((i) => i.level !== "info" && !i.seen);
  const [showSeen, setShowSeen] = useState(false);
  const fresh = items.filter((i) => !i.seen);
  const seen = items.filter((i) => i.seen);
  const blocking = items.some((i) => i.level === "block");
  const row = (i: AttentionItem) => (
    <li key={i.key} className="flex gap-2.5 px-3.5 py-2.5" data-level={i.level} data-testid="attention-item" data-seen={i.seen}>
      {ICON[i.level]}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-snug text-ink">{i.title}</p>
        <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{i.why}</p>
        <p className="mt-0.5 text-[11.5px] text-faint">{i.forYou}</p>
      </div>
      <span className="flex shrink-0 flex-col items-end gap-1 self-center">
        <button onClick={() => (setOpen(false), i.action.run())} className="h-[24px] rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:bg-hover hover:text-ink">
          {i.action.label}
        </button>
        <button onClick={() => setSeen([i.key], !i.seen)} className="text-[11.5px] text-faint hover:text-ink" title={i.seen ? "Show it as new again" : "Hide it until it changes"}>
          {i.seen ? "Mark unseen" : "Mark seen"}
        </button>
      </span>
    </li>
  );
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="attention"
        aria-expanded={open}
        aria-label={needs.length ? `${needs.length} need${needs.length === 1 ? "s" : ""} you` : "Nothing needs you"}
        className={`flex h-[24px] items-center gap-1.5 rounded-sm px-2 text-[12.5px] transition-colors hover:bg-hover ${blocking ? "text-danger" : needs.length ? "text-warn" : "text-muted"}`}
      >
        {needs.length ? <span className={`size-1.5 rounded-full ${blocking ? "bg-danger" : "bg-warn"}`} /> : <CircleCheck size={13} />}
        {needs.length ? `${needs.length} need${needs.length === 1 ? "s" : ""} you` : "All clear"}
      </button>
      {open && (
        <div role="dialog" aria-label="What needs you" className="glass absolute right-0 top-full z-50 mt-1.5 w-[420px] max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-rule-strong" data-testid="attention-list">
          {items.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted">Nothing needs you. Agents and teammates keep working in the background; anything that needs a decision shows up here.</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              {fresh.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">Nothing new. You&apos;ve seen everything below; it comes back here if it changes.</p>}
              <ul className="divide-y divide-rule">{fresh.map((i) => row(i))}</ul>
              {seen.length > 0 && (
                <>
                  <button onClick={() => setShowSeen((v) => !v)} aria-expanded={showSeen} className="w-full border-t border-rule px-3.5 py-1.5 text-left text-[12px] text-muted hover:bg-hover" data-testid="attention-seen-toggle">
                    {showSeen ? "Hide" : "Show"} {seen.length} seen
                  </button>
                  {showSeen && <ul className="divide-y divide-rule opacity-70">{seen.map((i) => row(i))}</ul>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
