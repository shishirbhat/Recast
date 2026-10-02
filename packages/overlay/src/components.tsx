import { motion, useReducedMotion, useSpring } from "motion/react";
import { memo, useRef, useSyncExternalStore } from "react";
import { CHIP_H, CHIP_W } from "@recast/interaction";
import type { View } from "@recast/interaction";
import type { Store } from "./store.js";

const EASE = [0.2, 0.7, 0.1, 1] as const;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function LiftOutline({ rect, glyph }: { rect: NonNullable<View["liftOutline"]>; glyph?: string }) {
  return (
    <div data-testid="lift-outline" className="absolute rounded-(--r-input) border border-(--accent)" style={{ left: rect.x - 2, top: rect.y - 2, width: rect.w + 4, height: rect.h + 4 }}>
      {glyph ? <span aria-hidden className="absolute -top-2.5 -left-1 grid size-5 place-items-center rounded-(--r-input) bg-(--accent) font-mono text-[11px] font-semibold text-(--on-accent)">{glyph}</span> : null}
    </div>
  );
}

function Token({ token, store }: { token: NonNullable<View["token"]>; store: Store }) {
  const reduce = useReducedMotion();
  const sx = useSpring(store.x, { stiffness: 320, damping: 30 });
  const sy = useSpring(store.y, { stiffness: 320, damping: 30 });
  const x = reduce ? store.x : sx, y = reduce ? store.y : sy;
  return (
    <motion.div
      data-testid="token" role="img" aria-label={`Carrying ${token.title}, ${token.type}`}
      initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: reduce ? 0.08 : 0.16, ease: EASE }}
      style={{ x, y, height: "var(--token-h)" }}
      className={`absolute top-0 left-0 flex max-w-60 items-center gap-2 rounded-(--r-pill) border border-(--line-soft) bg-(--token-bg) pr-4 pl-3 text-(--token-fg) shadow-(--shadow-token) ${token.snapped ? "-translate-x-full" : "translate-x-4 translate-y-4"}`}
    >
      <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-(--r-input) bg-(--accent-soft) font-mono text-[11px] font-semibold text-(--accent)">{token.glyph}</span>
      <span className="truncate text-[13px] font-medium">{token.title}</span>
      {token.favicon ? <img alt="" src={token.favicon} className="size-4 shrink-0 rounded-sm" /> : <span aria-hidden className="size-4 shrink-0 rounded-sm bg-(--text-muted)" />}
    </motion.div>
  );
}

function Chips({ view }: { view: View }) {
  const reduce = useReducedMotion();
  const hold = view.hold;
  if (!view.chips.length) return null;
  return (
    <div role="listbox" aria-label={view.token ? `Places to put ${view.token.title}` : "Places"}>
      {view.chips.map((c) => {
        const holding = hold && hold.kind === "hold" && c.active;
        const label = holding ? (c.tier === "high" ? "Hold to confirm" : c.label) : hold && hold.kind === "confirm" && c.active ? "Confirm" : c.label;
        return (
          <motion.div
            key={c.proposalId} role="option" aria-selected={c.active} aria-disabled={c.status === "blocked"}
            aria-label={`${c.label}${c.status === "blocked" ? `, unavailable: ${c.reason}` : ""}. ${c.reliability}. ${c.tier === "high" ? "Needs a press and hold." : c.tier === "medium" ? "Needs confirmation." : "Places on release."}`}
            data-testid="chip" data-active={c.active} data-status={c.status} data-tier={c.tier}
            initial={{ opacity: 0, x: 6 }} animate={{ opacity: c.status === "blocked" ? 0.6 : 1, x: c.active ? -4 : 0 }} transition={{ duration: reduce ? 0.08 : 0.16, ease: EASE }}
            style={{ left: c.rect.x, top: c.rect.y, width: CHIP_W, height: CHIP_H }}
            className={`absolute flex items-center overflow-hidden rounded-(--r-pill) border px-3 text-xs font-medium shadow-(--shadow-token) ${c.active ? "border-transparent bg-(--chip-active-bg) text-(--chip-active-fg)" : "border-(--line-soft) bg-(--chip-bg) text-(--chip-fg)"} ${holding ? "border-(--danger)" : ""}`}
          >
            {holding ? <span aria-hidden className="absolute inset-y-0 left-0 bg-(--danger) opacity-25" style={{ width: pct(hold.progress) }} /> : null}
            <span className="relative block truncate first-letter:uppercase">{label}</span>
          </motion.div>
        );
      })}
    </div>
  );
}

function Ghost({ view }: { view: View }) {
  const reduce = useReducedMotion();
  if (!view.ghost || !view.destinationRect) return null;
  const d = view.destinationRect;
  const last = view.chips.at(-1);
  const W = Math.min(232, d.w - 32);
  // Right-aligned under the chips, opaque so the destination's own text does not show through the preview.
  return (
    <motion.div
      data-testid="ghost" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduce ? 0.08 : 0.12, ease: EASE }}
      style={{ left: d.x + d.w - W - 16, top: (last ? last.rect.y + CHIP_H : d.y + 24) + 12, width: W }}
      className="absolute rounded-(--r-input) border border-dashed border-(--ghost-outline) bg-(--surface-raised) bg-[linear-gradient(var(--accent-soft),var(--accent-soft))] px-3 py-2 text-[13px] text-(--text) shadow-(--shadow-token)"
    >
      <div className="mb-1 font-mono text-[11px] text-(--text-muted)">preview</div>
      {view.ghost.ghost.rows.map((r) => (
        <div key={r.label} className="flex gap-2"><span className="text-(--text-muted)">{r.label.split(".")[1]}</span><span className="truncate">{r.value}</span></div>
      ))}
    </motion.div>
  );
}

/** The countdown is one CSS animation started at mount (negative delay = time already elapsed). It must not depend on
 *  `remainingMs`, which changes on every tick: that would restart the animation and re-render this component constantly. */
const Toast = memo(function Toast({ toast, onUndo }: { toast: NonNullable<View["toast"]>; onUndo: () => void }) {
  const reduce = useReducedMotion();
  const total = Math.max(1, toast.expiresAt - toast.startedAt);
  const elapsed = useRef(Math.max(0, total - toast.remainingMs)).current;
  return (
    <motion.div
      key={toast.startedAt} data-testid="toast" role="status"
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduce ? 0.08 : 0.22, ease: EASE }}
      className="pointer-events-auto absolute bottom-4 left-1/2 flex [translate:-50%_0] items-center gap-4 overflow-hidden rounded-(--r-pill) border border-(--line-soft) bg-(--toast-bg) px-4 py-3 text-[13px] whitespace-nowrap shadow-(--shadow-toast)"
    >
      <span className={toast.kind === "error" ? "text-(--danger)" : ""}>{toast.text}</span>
      {toast.kind === "placed" ? <button type="button" onClick={onUndo} className="cursor-pointer rounded-(--r-pill) px-2 py-0.5 font-semibold text-(--accent) hover:bg-(--accent-soft) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)">Undo</button> : null}
      <span aria-hidden data-testid="toast-bar" className="recast-bar absolute bottom-0 left-0 h-0.5 w-full origin-left bg-(--accent)"
        style={reduce ? { transform: `scaleX(${Math.min(1, toast.remainingMs / total)})` } : { animation: `recast-bar ${total}ms linear forwards`, animationDelay: `-${elapsed}ms` }} />
    </motion.div>
  );
}, (a, b) => a.toast.startedAt === b.toast.startedAt && a.toast.text === b.toast.text && a.toast.kind === b.toast.kind && a.onUndo === b.onUndo);

export function Overlay({ store, onUndo }: { store: Store; onUndo: () => void }) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  if (!view) return null;
  return (
    <>
      {view.liftOutline ? <LiftOutline rect={view.liftOutline} {...(view.liftGlyph ? { glyph: view.liftGlyph } : {})} /> : null}
      {view.destinationRect ? <div data-testid="destination" className="absolute rounded-(--r-input) border border-(--accent)" style={{ left: view.destinationRect.x, top: view.destinationRect.y, width: view.destinationRect.w, height: view.destinationRect.h }} /> : null}
      <Chips view={view} />
      <Ghost view={view} />
      {view.note ? <div data-testid="note" className="absolute rounded-(--r-input) bg-(--surface-raised) px-3 py-1.5 text-xs text-(--text-muted) shadow-(--shadow-token)" style={{ left: (view.destinationRect?.x ?? 0) + 16, top: (view.destinationRect?.y ?? 0) + (view.destinationRect?.h ?? 0) - 40 }}>{view.note}</div> : null}
      {view.token ? <Token token={view.token} store={store} /> : null}
      {view.toast ? <Toast toast={view.toast} onUndo={onUndo} /> : null}
      <div data-testid="live" aria-live="polite" role="status" className="sr-only">{view.live}</div>
    </>
  );
}
