import { animate, AnimatePresence, motion, useReducedMotion, useSpring, useTransform, useVelocity } from "motion/react";
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CHIP_H, CHIP_W } from "@recast/interaction";
import type { View } from "@recast/interaction";
import type { Store } from "./store.js";

import { CARRY, INSTANT, LEAN, SPRING } from "./motion.js";
const pct = (n: number) => `${Math.round(n * 100)}%`;

function LiftOutline({ rect, glyph }: { rect: NonNullable<View["liftOutline"]>; glyph?: string }) {
  return (
    <motion.div data-testid="lift-outline" className="absolute rounded-(--r-input) border-2 border-(--accent)" style={{ left: rect.x - 3, top: rect.y - 3, width: rect.w + 6, height: rect.h + 6 }}
      initial={{ scale: 1 }} animate={{ scale: useReducedMotion() ? 1 : [1, 1.035, 1] }} transition={{ duration: 0.2 }}>
      {glyph ? <span aria-hidden className="absolute -top-2.5 -left-1 grid size-5 place-items-center rounded-(--r-input) bg-(--accent) font-mono text-[11px] font-semibold text-(--on-accent)">{glyph}</span> : null}
    </motion.div>
  );
}

/** A small object in the hand: it trails the pointer on a spring, tilts with its momentum and lifts higher (bigger, softer
 *  shadow) the faster it moves. All of it runs on motion values, so carrying never re-renders React. */
function Token({ token, store }: { token: NonNullable<View["token"]>; store: Store }) {
  const reduce = !!useReducedMotion();
  const sx = useSpring(store.x, SPRING.carry), sy = useSpring(store.y, SPRING.carry);
  const vx = useVelocity(sx), vy = useVelocity(sy);
  const tilt = useSpring(useTransform(vx, [-CARRY.tiltAtSpeed, 0, CARRY.tiltAtSpeed], [-CARRY.maxTiltDeg, 0, CARRY.maxTiltDeg], { clamp: true }), SPRING.carry);
  const lift = useTransform(() => Math.min(1, Math.hypot(vx.get(), vy.get()) / CARRY.liftAtSpeed));
  const shadow = useTransform(lift, (l) => `0 ${1 + l * 2}px ${2 + l * 3}px rgb(var(--shadow-rgb) / ${0.1 + l * 0.06}), 0 ${10 + l * 14}px ${28 + l * 22}px rgb(var(--shadow-rgb) / ${0.14 + l * 0.1})`);
  const x = reduce ? store.x : sx, y = reduce ? store.y : sy;
  return (
    <motion.div
      data-testid="token" role="img" aria-label={`Carrying ${token.title}, ${token.type}`}
      initial={reduce ? false : { opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={reduce ? INSTANT : SPRING.carry}
      style={{ x, y, height: "var(--token-h)", ...(reduce ? { boxShadow: "var(--shadow-token)" } : { rotate: tilt, boxShadow: shadow }) }}
      className={`absolute top-0 left-0 flex max-w-60 items-center gap-2 rounded-(--r-pill) border border-(--line-soft) bg-(--token-bg) pr-4 pl-2 text-(--token-fg) ${token.snapped ? "-translate-x-full -translate-y-1/2" : "translate-x-4 translate-y-4"}`}
    >
      <TokenFace token={token} />
    </motion.div>
  );
}

function TokenFace({ token }: { token: Pick<NonNullable<View["token"]>, "glyph" | "title" | "favicon"> }) {
  return (
    <>
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-(--r-pill) bg-(--accent) font-mono text-[12px] font-semibold text-(--on-accent)">{token.glyph}</span>
      <span className="truncate text-[13px] font-medium">{token.title}</span>
      {token.favicon ? <img alt="" src={token.favicon} className="size-4 shrink-0 rounded-sm" /> : null}
    </>
  );
}

/** Esc or a drop on nothing: the token falls back to where it was lifted, bounces once, and fades. Nothing changed. */
function DroppedToken({ token, store, onDone }: { token: NonNullable<View["token"]>; store: Store; onDone: () => void }) {
  const reduce = !!useReducedMotion();
  useEffect(() => {
    if (reduce) { onDone(); return; }
    const a = animate(store.x, store.origin.x, SPRING.cancel), b = animate(store.y, store.origin.y, SPRING.cancel);
    void Promise.all([a.finished, b.finished]).then(onDone);
    return () => { a.stop(); b.stop(); };
  }, [reduce, store, onDone]);
  return (
    <motion.div data-testid="token-dropping" aria-hidden initial={{ opacity: 1, scale: 1 }} animate={{ opacity: [1, 1, 0], scale: [1, 0.96, 0.9] }} transition={{ duration: 0.25, times: [0, 0.7, 1] }}
      style={{ x: store.x, y: store.y, height: "var(--token-h)", boxShadow: "var(--shadow-rest)" }}
      className="absolute top-0 left-0 flex max-w-60 translate-x-4 translate-y-4 items-center gap-2 rounded-(--r-pill) border border-(--line-soft) bg-(--token-bg) pr-4 pl-2 text-(--token-fg)">
      <TokenFace token={token} />
    </motion.div>
  );
}

/** Landing chips are magnets. Near: the closest chip leans toward the pointer, grows 5% and glows. Locked: it snaps with a
 *  small overshoot (the "click"). Hold: it shrinks a little under the press and fills with the accent over 600 ms, then pops. */
function Chips({ view }: { view: View }) {
  const reduce = !!useReducedMotion();
  const hold = view.hold;
  if (!view.chips.length) return null;
  return (
    <div role="listbox" aria-label={view.token ? `Places to put ${view.token.title}` : "Places"}>
      {view.chips.map((c) => {
        const pressing = !!hold && c.active;
        const holding = pressing && hold.kind === "hold";
        const label = holding ? (c.tier === "high" ? "Hold to confirm" : c.label) : pressing && hold.kind === "confirm" ? "Confirm" : c.label;
        const cx = c.rect.x + CHIP_W / 2, cy = c.rect.y + CHIP_H / 2;
        const lean = (d: number) => Math.max(-LEAN.maxPx, Math.min(LEAN.maxPx, d * LEAN.factor));
        const target = reduce
          ? { opacity: c.status === "blocked" ? 0.6 : 1, x: 0, y: 0, scale: 1 }
          : c.active
            ? { opacity: 1, x: -4, y: 0, scale: holding ? (hold.progress >= 1 ? 1.06 : 0.97) : 1 }
            : c.near ? { opacity: 1, x: lean(view.pointer.x - cx), y: lean(view.pointer.y - cy), scale: 1.05 }
            : { opacity: c.status === "blocked" ? 0.6 : 1, x: 0, y: 0, scale: 1 };
        return (
          <motion.div
            key={c.proposalId} role="option" aria-selected={c.active} aria-disabled={c.status === "blocked"}
            aria-label={`${c.label}${c.status === "blocked" ? `, unavailable: ${c.reason}` : ""}. ${c.reliability}. ${c.tier === "high" ? "Needs a press and hold." : c.tier === "medium" ? "Needs confirmation." : "Places on release."}`}
            data-testid="chip" data-active={c.active} data-near={c.near} data-status={c.status} data-tier={c.tier}
            initial={reduce ? false : { opacity: 0, x: 8, scale: 0.96 }} animate={target}
            transition={reduce ? INSTANT : c.active ? SPRING.snap : SPRING.approach}
            style={{ left: c.rect.x, top: c.rect.y, width: CHIP_W, height: CHIP_H }}
            className={`absolute flex items-center overflow-hidden rounded-(--r-pill) border px-3 text-xs font-medium transition-shadow ${c.active ? "border-(--accent) bg-(--accent-soft) text-(--text) shadow-(--shadow-token)" : c.near ? "border-(--accent) bg-(--chip-bg) text-(--chip-fg) shadow-[0_0_0_4px_var(--accent-soft),var(--shadow-token)]" : "border-(--line-soft) bg-(--chip-bg) text-(--chip-fg) shadow-(--shadow-rest)"}`}
          >
            {holding ? <span aria-hidden data-testid="hold-fill" className="absolute inset-y-0 left-0 bg-(--accent)" style={{ width: pct(hold.progress) }} /> : null}
            <span className="relative block truncate first-letter:uppercase">{label}</span>
          </motion.div>
        );
      })}
    </div>
  );
}

/** The preview is a hologram: translucent, blurred behind, floating a little above the destination, outlined in the accent. */
function Ghost({ view }: { view: View }) {
  const reduce = !!useReducedMotion();
  if (!view.ghost || !view.destinationRect) return null;
  const d = view.destinationRect;
  const last = view.chips.at(-1);
  const W = Math.min(232, d.w - 32);
  return (
    <motion.div
      data-testid="ghost" initial={reduce ? false : { opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: reduce ? 0 : -2, scale: 1 }} transition={reduce ? INSTANT : SPRING.carry}
      style={{ left: d.x + d.w - W - 16, top: (last ? last.rect.y + CHIP_H : d.y + 24) + 12, width: W }}
      className="absolute rounded-(--r-input) border border-dashed border-(--ghost-outline) bg-[color-mix(in_srgb,var(--surface-raised)_86%,transparent)] px-3 py-2 text-[13px] text-(--text) shadow-(--shadow-lifted) backdrop-blur-md"
    >
      <div className="mb-1 font-mono text-[11px] tracking-wide text-(--text-muted) uppercase">Preview</div>
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
      initial={reduce ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: 16, transition: SPRING.carry }} transition={reduce ? INSTANT : SPRING.carry}
      className="pointer-events-auto absolute bottom-4 left-1/2 flex [translate:-50%_0] items-center gap-3 overflow-hidden rounded-(--r-panel) border border-(--line-soft) bg-(--toast-bg) py-3 pr-3 pl-4 text-[13px] whitespace-nowrap shadow-(--shadow-toast)"
    >
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${toast.kind === "error" ? "bg-(--danger)" : toast.kind === "placed" ? "bg-(--ok)" : "bg-(--text-muted)"}`} />
      <span className={toast.kind === "error" ? "text-(--danger-ink)" : ""}>{toast.text}</span>
      {toast.kind === "placed" ? <button type="button" onClick={onUndo} className="cursor-pointer rounded-(--r-pill) px-2.5 py-1 font-semibold text-(--accent-ink) hover:bg-(--accent-soft) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus)">Undo</button> : null}
      <span aria-hidden data-testid="toast-bar" className="recast-bar absolute bottom-0 left-0 h-0.5 w-full origin-left bg-(--accent)"
        style={reduce ? { transform: `scaleX(${Math.min(1, toast.remainingMs / total)})` } : { animation: `recast-bar ${total}ms linear forwards`, animationDelay: `-${elapsed}ms` }} />
    </motion.div>
  );
}, (a, b) => a.toast.startedAt === b.toast.startedAt && a.toast.text === b.toast.text && a.toast.kind === b.toast.kind && a.onUndo === b.onUndo);

export function Overlay({ store, onUndo }: { store: Store; onUndo: () => void }) {
  const view = useSyncExternalStore(store.subscribe, store.get);
  const last = useRef<NonNullable<View["token"]> | null>(null);
  const [dropped, setDropped] = useState<NonNullable<View["token"]> | null>(null);
  useEffect(() => {
    if (view?.token) last.current = view.token;
    else if (view?.cancelled && last.current) { setDropped(last.current); last.current = null; }
    else last.current = null;
  }, [view]);
  if (!view) return null;
  return (
    <>
      {view.liftOutline ? <LiftOutline rect={view.liftOutline} {...(view.liftGlyph ? { glyph: view.liftGlyph } : {})} /> : null}
      {view.destinationRect ? <div data-testid="destination" className="absolute rounded-(--r-panel) border-2 border-(--accent)" style={{ left: view.destinationRect.x, top: view.destinationRect.y, width: view.destinationRect.w, height: view.destinationRect.h }} /> : null}
      <Chips view={view} />
      <Ghost view={view} />
      {view.note ? <div data-testid="note" className="absolute rounded-(--r-input) bg-(--surface-raised) px-3 py-1.5 text-xs text-(--text-muted) shadow-(--shadow-token)" style={{ left: (view.destinationRect?.x ?? 0) + 16, top: (view.destinationRect?.y ?? 0) + (view.destinationRect?.h ?? 0) - 40 }}>{view.note}</div> : null}
      {view.token ? <Token token={view.token} store={store} /> : dropped ? <DroppedToken token={dropped} store={store} onDone={() => setDropped(null)} /> : null}
      <AnimatePresence>{view.toast ? <Toast key={view.toast.startedAt} toast={view.toast} onUndo={onUndo} /> : null}</AnimatePresence>
      <div data-testid="live" aria-live="polite" role="status" className="sr-only">{view.live}</div>
    </>
  );
}
