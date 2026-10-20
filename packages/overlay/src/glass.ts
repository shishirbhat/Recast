// The Recast action module: a small frosted-glass instrument that floats over the page. Framework-free DOM, so the same
// module runs in the clay page, in the browser extension's shadow root and in the try-it page.
//
// It renders a `ModuleModel` (packages/interaction/src/wheel.ts) and reports what the person asks for as intents; it never
// changes state itself. One root element morphs between sizes: a pill while Recast is on, the composition when two things
// have been pressed together, a destination selector, a review, a receipt. The clay object itself is not drawn here: the
// module leaves a well, and the host places the real blob in it (`well()`), so the composition stays one tangible object.
import type { AnswerField, EventField } from "@recast/core";
import { escapeEvent, reduceClump, type ClumpInput, type ClumpState, type ModuleModel, type WheelEntry, type WheelKey } from "@recast/interaction";

export type GlassIntent =
  | { type: "turnOff" } | { type: "reopen" } | { type: "close" } | { type: "back" }
  | { type: "openWheel" } | { type: "select"; choice: WheelKey } | { type: "pick"; destinationId: string }
  | { type: "inspect" } | { type: "remove"; ingredientId: string }
  | { type: "answer"; field: AnswerField; value: string } | { type: "choose"; field: EventField; ingredientId: string }
  | { type: "place"; heldMs?: number } | { type: "undo" } | { type: "dismiss" } | { type: "reconcile" } | { type: "confirmMerge"; yes: boolean };

/** The state-machine events for what the person asked the module for. Shared by every host, so they behave the same. */
export function intentEvents(i: GlassIntent, s: ClumpState): ClumpInput[] {
  const id = s.placement?.objectId ?? s.inspecting ?? s.focus;
  switch (i.type) {
    case "turnOff": return [{ type: "disarm" }];
    case "reopen": return [{ type: "openModule" }];
    case "back": { const e = escapeEvent(s); return e && e.type !== "disarm" ? [e] : []; }
    case "close": {
      // Back to the pill, one step at a time as Escape would go, but never past "on": closing is not turning off.
      const out: ClumpInput[] = []; let t = s;
      for (let n = 0; n < 5 && t.phase !== "idle"; n++) {
        const e = escapeEvent(t); if (!e || e.type === "disarm") break;
        out.push(e); t = reduceClump(t, { ...e, now: t.now } as never).state;
      }
      return out;
    }
    case "openWheel": return [{ type: "openWheel" }];
    case "select": return [{ type: "select", choice: i.choice }];
    case "pick": return [{ type: "pickDestination", destinationId: i.destinationId }];
    case "inspect": return id ? [{ type: "inspect", id }] : [];
    case "remove": return id ? [{ type: "remove", objectId: id, ingredientId: i.ingredientId }] : [];
    case "answer": return id ? [{ type: "answer", objectId: id, field: i.field, value: i.value }] : [];
    case "choose": return id ? [{ type: "choose", objectId: id, field: i.field, ingredientId: i.ingredientId }] : [];
    case "place": return [{ type: "place", consent: i.heldMs !== undefined ? { kind: "hold", heldMs: i.heldMs } : { kind: "confirm" } }];
    case "undo": return [{ type: "undo" }];
    case "dismiss": return [{ type: "dismiss" }];
    case "reconcile": return [{ type: "reconcile" }];
    case "confirmMerge": return [{ type: "confirmMerge", yes: i.yes }];
  }
}

export interface Glass {
  update(model: ModuleModel, extra?: { error?: string }): void;
  /** Where the host should draw the composition (viewport coordinates), or null when the module shows none. */
  well(): { x: number; y: number } | null;
  /** Move keyboard focus into the module (the selector when it is open, else the first action). */
  focus(): void;
  readonly el: HTMLElement;
  destroy(): void;
}

/**
 * Colours, as numbers so a test can check contrast over the worst backdrops (pure black and pure white) instead of trusting
 * the blur. `tint` is the glass (rgb + alpha); `solid` is the fallback where blur or transparency is unavailable.
 */
export const GLASS_TOKENS = {
  light: { tint: [246, 246, 248, 0.8], solid: [242, 242, 245], ink: [29, 29, 31], muted: [77, 77, 82], accent: [184, 61, 18] },
  dark: { tint: [28, 28, 30, 0.8], solid: [36, 36, 38], ink: [245, 245, 247], muted: [199, 199, 204], accent: [255, 138, 92] },
} as const;

const ICON: Record<WheelKey, string> = {
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12 3 3 5-6"/>',
  documents: '<path d="M7 3.5h7l4.5 4.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z"/><path d="M14 3.5V8h4.5M8.5 13h7M8.5 16.5h5"/>',
  more: '<circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/>',
};
const svg = (k: WheelKey) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const FIELD_LABEL: Record<string, string> = { title: "Title", start: "When", end: "Ends", allDay: "All day", timezone: "Time zone", location: "Where", description: "Notes", to: "To", snippet: "Message", subject: "Subject" };
const ORIGIN: Record<string, string> = { extracted: "from the page", inferred: "Recast's reading", default: "a default", user: "you" };
const INPUT_HINT: Record<string, string> = { start: "2026-10-23T19:30", end: "2026-10-23T21:00", title: "Dinner with Maya", to: "maya@example.com" };
function fmt(field: string, v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if ((field === "start" || field === "end") && typeof v === "string") { const d = new Date(v.length === 10 ? `${v}T00:00` : v); return isNaN(+d) ? v : d.toLocaleString("en", { weekday: "short", day: "numeric", month: "short", ...(v.length > 10 ? { hour: "numeric", minute: "2-digit" } : {}) }); }
  return String(v);
}

const ROW = 48;           // one destination row, px
const WINDOW = 3;         // rows visible in the selector: the chosen one and a neighbour either side
const HOLD_MS = 600;

export function createGlass(root: HTMLElement | ShadowRoot, opts: { onIntent: (i: GlassIntent) => void; onLayout?: () => void; reducedMotion?: () => boolean; shortcut?: string; theme?: () => "light" | "dark" | undefined }): Glass {
  const reduced = opts.reducedMotion ?? (() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const el = document.createElement("div"); el.className = "rg"; el.dataset["mode"] = "off"; el.hidden = true;
  el.setAttribute("role", "region"); el.setAttribute("aria-label", "Recast");
  el.innerHTML = `<div class="rg-head"><span class="rg-dot" aria-hidden="true"></span><p class="rg-title" role="status" aria-live="polite"></p><span class="rg-head-actions"></span></div>
    <div class="rg-well" aria-hidden="true"></div><div class="rg-facts"></div><div class="rg-drum-wrap"></div><div class="rg-body"></div><div class="rg-actions"></div>`;
  root.appendChild(el);
  const q = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;
  let model: ModuleModel = { mode: "off" };
  let drill: "more" | null = null;     // the "More" list is open inside the selector
  let wheelAcc = 0, wheelAt = 0, holdStart = 0;

  const emit = (i: GlassIntent) => opts.onIntent(i);

  /** The rows the selector shows now: the five places, or the registry entries under "More". */
  function rows(m: Extract<ModuleModel, { entries: WheelEntry[] }>): { key: string; label: string; sub: string; available: boolean; reason?: string; destinationId?: string; icon: WheelKey }[] {
    if (drill === "more") {
      const more = m.entries.find((e) => e.key === "more")!;
      return [...more.options.map((o, i) => ({ key: `more:${i}`, label: o.app, sub: o.effect, available: o.available, ...(o.reason ? { reason: o.reason } : {}), ...(o.destinationId ? { destinationId: o.destinationId } : {}), icon: "more" as WheelKey })),
        { key: "more:back", label: "Back", sub: "to the five places", available: true, icon: "more" as WheelKey }];
    }
    return m.entries.map((e) => {
      const live = e.options.find((o) => o.available);
      const sub = e.available ? `${live?.app ?? ""}${e.standIn ? " · stand-in" : ""}` : "Unavailable";
      return { key: e.key, label: e.label, sub, available: e.available, ...(e.reason ? { reason: e.reason } : {}), ...(e.destinationId ? { destinationId: e.destinationId } : {}), icon: e.key };
    });
  }
  let drillChoice = 0;
  const currentIndex = (m: Extract<ModuleModel, { entries: WheelEntry[] }>) => drill === "more" ? drillChoice : Math.max(0, m.entries.findIndex((e) => e.key === m.choice));

  function move(delta: number) {
    if (model.mode !== "choosing") return;
    const list = rows(model); const i = Math.min(list.length - 1, Math.max(0, currentIndex(model) + delta));
    if (drill === "more") { drillChoice = i; renderDrum(); return; }
    if (i !== currentIndex(model)) emit({ type: "select", choice: model.entries[i]!.key });
  }
  function openSelected() {
    if (model.mode !== "choosing") return;
    const r = rows(model)[currentIndex(model)]!;
    // "More" opens even when nothing in it fits: the person can still see what is there and why not.
    if (r.key === "more") { drill = "more"; drillChoice = 0; update(model); return; }
    if (r.key === "more:back") { drill = null; update(model); return; }
    if (!r.available || !r.destinationId) { q(".rg-reason").classList.remove("nudge"); void q(".rg-reason").offsetWidth; q(".rg-reason").classList.add("nudge"); return; }
    emit({ type: "pick", destinationId: r.destinationId });
  }

  // ---- the selector: built once per list, then only moved, so the motion is continuous ----------------------------------
  let drumSig = "";
  function renderDrum() {
    const wrap = q(".rg-drum-wrap");
    if (model.mode !== "choosing") { if (wrap.innerHTML) { wrap.innerHTML = ""; drumSig = ""; } return; }
    const list = rows(model); const sig = JSON.stringify(list.map((r) => [r.key, r.available, r.sub, r.reason]));
    if (sig !== drumSig) {
      drumSig = sig;
      wrap.innerHTML = `<div class="rg-drum" role="listbox" tabindex="0" aria-label="${drill === "more" ? "More destinations" : "Where it goes"}" style="height:${ROW * WINDOW}px"><div class="rg-track">${list.map((r) =>
        `<div class="rg-opt${r.available ? "" : " off"}" role="option" id="rg-opt-${esc(r.key.replace(":", "-"))}" data-key="${esc(r.key)}" aria-disabled="${!r.available}"><span class="rg-ico">${svg(r.icon)}</span><span class="rg-name"><span class="rg-label">${esc(r.label)}</span><span class="rg-sub">${esc(r.sub)}</span></span><kbd class="rg-enter" aria-hidden="true">↵</kbd></div>`).join("")}</div></div>
        <p class="rg-reason" aria-live="polite"></p>`;
      const drum = q(".rg-drum");
      drum.addEventListener("wheel", (e) => {
        e.preventDefault();
        // Trackpads send many small deltas, mice a few large ones: accumulate, and step at most once per notch.
        wheelAcc += e.deltaY; const t = performance.now();
        if (Math.abs(wheelAcc) >= 30 && t - wheelAt > 80) { move(Math.sign(wheelAcc)); wheelAcc = 0; wheelAt = t; }
      }, { passive: false });
      drum.addEventListener("keydown", (e) => {
        const k = e.key;
        if (k === "ArrowDown" || k === "ArrowRight") { e.preventDefault(); move(1); }
        else if (k === "ArrowUp" || k === "ArrowLeft") { e.preventDefault(); move(-1); }
        else if (k === "Home") { e.preventDefault(); move(-99); }
        else if (k === "End") { e.preventDefault(); move(99); }
        else if (k === "Enter" || k === " ") { e.preventDefault(); openSelected(); }
      });
      drum.addEventListener("click", (e) => {
        const opt = (e.target as HTMLElement).closest<HTMLElement>(".rg-opt"); if (!opt) return;
        const i = rows(model as never).findIndex((r) => r.key === opt.dataset["key"]);
        if (i === currentIndex(model as never)) openSelected(); else move(i - currentIndex(model as never));
        q(".rg-drum").focus();
      });
      // Touch: a vertical swipe steps through the list.
      let sy: number | null = null;
      drum.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") sy = e.clientY; });
      drum.addEventListener("pointermove", (e) => { if (sy === null) return; const d = e.clientY - sy; if (Math.abs(d) > 36) { move(d < 0 ? 1 : -1); sy = e.clientY; } });
      drum.addEventListener("pointerup", () => { sy = null; }); drum.addEventListener("pointercancel", () => { sy = null; });
    }
    const i = currentIndex(model); const r = list[i]!;
    q(".rg-track").style.transform = `translateY(${ROW * (WINDOW - 1) / 2 - ROW * i}px)`;
    for (const [j, o] of [...el.querySelectorAll<HTMLElement>(".rg-opt")].entries()) { o.classList.toggle("on", j === i); o.setAttribute("aria-selected", String(j === i)); o.classList.toggle("near", Math.abs(j - i) === 1); }
    q(".rg-drum").setAttribute("aria-activedescendant", `rg-opt-${r.key.replace(":", "-")}`);
    q(".rg-reason").textContent = r.available ? (r.key === "more" ? "Other destinations Recast connects to" : r.key === "more:back" ? "" : `${rowEffect(r.key)}${model.mode === "choosing" && r.sub.includes("stand-in") ? ". A local stand-in: nothing reaches the real service" : ""}`) : (r.reason ?? "");
    const open = q<HTMLButtonElement>(".rg-actions [data-act=open]"); if (open) open.disabled = !r.available;
  }
  function rowEffect(key: string): string {
    if (model.mode !== "choosing") return "";
    const e = model.entries.find((x) => x.key === key); const o = e?.options.find((x) => x.available);
    if (o) return `${o.app}: ${o.effect.toLowerCase()}`;
    if (drill === "more") { const more = model.entries.find((x) => x.key === "more")!; const idx = Number(key.split(":")[1]); const m = more.options[idx]; return m ? `${m.app}: ${m.effect.toLowerCase()}` : ""; }
    return "";
  }

  // ---- everything else: rebuilt only when its text changes, keeping focus where it was ---------------------------------
  function detail(m: Extract<ModuleModel, { object: unknown }>): string {
    const v = m.object.view; const fields = (v.event?.fields ?? v.message?.fields ?? {}) as Record<string, { value: unknown; origin: string } | undefined>;
    const rowsHtml = Object.entries(fields).filter(([, f]) => f).map(([k, f]) => `<div class="rg-row"><dt>${FIELD_LABEL[k] ?? k}</dt><dd>${esc(fmt(k, f!.value))} <span class="rg-origin">${ORIGIN[f!.origin] ?? f!.origin}</span></dd></div>`).join("");
    const missing = v.missing.map((x) => {
      const id = `rg-in-${x.field}`;
      return `<div class="rg-missing"><label for="${id}">${FIELD_LABEL[x.field] ?? x.field}</label><p class="rg-why">${esc(x.reason)}</p>${(x.suggestions ?? []).map((s) => `<button type="button" class="rg-chip" data-answer="${x.field}" data-value="${esc(s)}">Use “${esc(s)}”</button>`).join("")}<div class="rg-answer"><input id="${id}" data-field="${x.field}" placeholder="${INPUT_HINT[x.field] ?? ""}" autocomplete="off"><button type="button" class="rg-btn small ghost" data-submit="${x.field}">Set</button></div></div>`;
    }).join("");
    const conflicts = v.conflicts.map((c) => `<div class="rg-missing"><p class="rg-why">${FIELD_LABEL[c.field] ?? c.field}: the pieces disagree. Which one is right?</p>${c.options.map((o) => `<button type="button" class="rg-chip" data-choose="${c.field}" data-ingredient="${esc(o.fragmentId)}">${esc(o.original)}</button>`).join("")}</div>`).join("");
    const assumptions = v.assumptions.length ? `<ul class="rg-assume">${v.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : "";
    return `${rowsHtml ? `<dl class="rg-fields">${rowsHtml}</dl>` : ""}${missing || conflicts ? `<div class="rg-needs"><h3>Still needed</h3>${conflicts}${missing}</div>` : ""}${assumptions}`;
  }
  function content(m: ModuleModel, error?: string): { title: string; head: string; facts: string; body: string; actions: string } {
    const close = `<button type="button" class="rg-x" data-act="close" aria-label="Close (Esc). Your composition is kept">${xIcon}</button>`;
    if (m.mode === "off") return { title: "", head: "", facts: "", body: "", actions: "" };
    if (m.mode === "pill") return {
      title: esc(m.text), facts: "", body: "",
      head: `${m.reopen ? `<button type="button" class="rg-pill-btn" data-act="reopen">Open</button>` : ""}<button type="button" class="rg-x" data-act="turnOff" aria-label="Turn Recast off${opts.shortcut ? ` (${opts.shortcut})` : ""}">${xIcon}</button>`,
      actions: "",
    };
    const v = m.object.view; const facts = v.summary.filter(Boolean).slice(0, 3).map((s) => `<span>${esc(s)}</span>`).join("");
    const err = error ? `<p class="rg-error" role="alert">${esc(error.charAt(0).toUpperCase() + error.slice(1))}</p>` : "";
    const d = m.destination; const where = d ? d.label : "the destination";
    const standIn = d?.standIn ? `<p class="rg-note">Stand-in: ${esc(d.app)} here is a local stand-in. Nothing reaches the real ${esc(d.app)}.</p>` : "";
    switch (m.mode) {
      case "composed": return m.text ? { title: "Add to it?", head: "", facts, body: `<p class="rg-hint">${esc(m.text)}</p>`, actions: "" } : { title: "One object", head: close, facts,
        body: `${err}<p class="rg-hint">Drag another piece onto it to add more.</p>`,
        actions: `<button type="button" class="rg-btn" data-act="openWheel">Choose where it goes <kbd>↵</kbd></button><button type="button" class="rg-btn ghost" data-act="inspect">Look inside</button>` };
      case "choosing": return { title: drill === "more" ? "More places" : "Where should it go?", head: close, facts, body: err,
        actions: `<button type="button" class="rg-btn" data-act="open">Open <kbd>↵</kbd></button><button type="button" class="rg-btn ghost" data-act="back">Back</button>` };
      case "inspecting": return { title: "Inside this object", head: close, facts: "",
        body: `${err}<ul class="rg-ingredients">${m.object.ingredients.map((f) => `<li><span class="rg-kind">${esc(f.kind)}</span><span class="rg-what">${esc(f.text)}</span><span class="rg-src">from ${esc(f.from)}</span>${m.object.ingredients.length > 1 ? `<button type="button" class="rg-link" data-remove="${esc(f.id)}" aria-label="Take ${esc(f.text)} out">Take out</button>` : ""}</li>`).join("")}</ul>${detail(m)}`,
        actions: `<button type="button" class="rg-btn" data-act="back">Done</button>` };
      case "confirm": return { title: "Combine them?", head: "", facts: "", body: `<p>${esc(m.confirm ?? "")}</p>`,
        actions: `<button type="button" class="rg-btn" data-act="mergeYes">Combine</button><button type="button" class="rg-btn ghost" data-act="mergeNo">Keep apart</button>` };
      case "preview": {
        const op = m.placement?.op;
        const risk = op ? `<p class="rg-risk">${op.risk.tier === "low" ? "Low risk: adds an entry only you see, and it can be undone." : esc(op.risk.reasons.join("; "))}</p>` : "";
        const go = op ? (op.risk.consent === "hold" ? `<button type="button" class="rg-btn hold" data-act="hold">Press and hold to ${esc(op.proposal.effect.toLowerCase())}</button>` : `<button type="button" class="rg-btn" data-act="place">${esc(op.proposal.effect)}</button>`) : `<button type="button" class="rg-btn" disabled>Answer what is still needed</button>`;
        return { title: `${esc(where)}: review`, head: close, facts: "", body: `${err}${detail(m)}${risk}${standIn}`, actions: `${go}<button type="button" class="rg-btn ghost" data-act="back">Back</button>` };
      }
      case "executing": return { title: `Adding to ${esc(where)}…`, head: "", facts, body: `<p class="rg-hint">Waiting for ${esc(where)} to confirm.</p>`, actions: "" };
      case "succeeded": return { title: `${checkIcon}Added to ${esc(where)}`, head: close, facts,
        body: `<p class="rg-hint">${esc(where)} confirmed it${d?.standIn ? " (stand-in)" : ""}.${m.placement?.undoable ? "" : " It cannot be undone from here."}</p>`,
        actions: `${m.placement?.undoable ? `<button type="button" class="rg-btn ghost" data-act="undo">Undo</button>` : ""}<button type="button" class="rg-btn" data-act="dismiss">Done</button>` };
      case "unknown": return { title: `No answer from ${esc(where)}`, head: "", facts: "",
        body: `<p>${esc(m.placement?.message ?? "")}. It may or may not have been added. Recast does not send it again; it asks ${esc(where)} instead.</p>`,
        actions: `<button type="button" class="rg-btn" data-act="reconcile">Check ${esc(where)}</button>` };
      case "failed": return { title: "Not added", head: close, facts: "", body: `<p>${esc(m.placement?.message ?? m.text ?? "")}</p>`, actions: `<button type="button" class="rg-btn" data-act="dismiss">Close</button>` };
    }
  }

  let shown = { title: "", head: "", facts: "", body: "", actions: "" };
  function update(m: ModuleModel, extra: { error?: string } = {}) {
    const before = el.dataset["mode"]!; const prev = el.getBoundingClientRect();
    if (m.mode !== "choosing") drill = null;
    model = m; el.dataset["mode"] = m.mode; el.hidden = m.mode === "off";
    const t = opts.theme?.(); if (t) el.dataset["theme"] = t; else delete el.dataset["theme"];
    const c = content(m, extra.error);
    const focusKey = keyOf((el.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement | null);
    for (const k of ["title", "head", "facts", "body", "actions"] as const) {
      if (shown[k] === c[k]) continue;
      const target = { title: ".rg-title", head: ".rg-head-actions", facts: ".rg-facts", body: ".rg-body", actions: ".rg-actions" }[k];
      q(target).innerHTML = c[k];
    }
    shown = c;
    renderDrum();
    if (focusKey) { const f = el.querySelector<HTMLElement>(focusKey); f?.focus(); }
    // The one morph: the silhouette is revealed from its old outline to its new one. Layout takes the new size at once
    // (so the well, and the object in it, are where they will stay); only the clip animates.
    if (before !== m.mode && !el.hidden && !reduced() && prev.width && "animate" in el) {
      const next = el.getBoundingClientRect();
      const dx = Math.max(0, (next.width - prev.width) / 2), top = Math.max(0, next.bottom - prev.bottom + next.height - prev.height);
      const r = before === "pill" || before === "off" ? prev.height / 2 : 22;
      if (dx + top > 2) el.animate([{ clipPath: `inset(${top}px ${dx}px 0 ${dx}px round ${r}px)` }, { clipPath: "inset(0 0 0 0 round 22px)" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
      if (before === "off") el.animate([{ opacity: 0, transform: "translateY(6px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
    }
  }
  const keyOf = (a: HTMLElement | null): string | null => {
    if (!a || !el.contains(a)) return null;
    if (a.id) return `#${CSS.escape(a.id)}`;
    if (a.classList.contains("rg-drum")) return ".rg-drum";
    for (const k of ["act", "answer", "submit", "remove", "choose"]) if (a.dataset[k]) return `[data-${k}="${CSS.escape(a.dataset[k]!)}"]`;
    return null;
  };

  // Anything that changes the module's size (answering a field, an error line) moves the well: tell the host.
  new ResizeObserver(() => opts.onLayout?.()).observe(el);

  // ---- clicks and holds --------------------------------------------------------------------------------------------------
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!b || b.disabled) return;
    if (b.dataset["answer"]) return emit({ type: "answer", field: b.dataset["answer"] as AnswerField, value: b.dataset["value"]! });
    if (b.dataset["submit"]) return submit(b.dataset["submit"]);
    if (b.dataset["choose"]) return emit({ type: "choose", field: b.dataset["choose"] as EventField, ingredientId: b.dataset["ingredient"]! });
    if (b.dataset["remove"]) return emit({ type: "remove", ingredientId: b.dataset["remove"] });
    switch (b.dataset["act"]) {
      case "turnOff": return emit({ type: "turnOff" });
      case "reopen": return emit({ type: "reopen" });
      case "close": return emit({ type: "close" });
      case "back": if (drill) { drill = null; renderDrum(); update(model); return; } return emit({ type: "back" });
      case "openWheel": return emit({ type: "openWheel" });
      case "open": return openSelected();
      case "inspect": return emit({ type: "inspect" });
      case "place": return emit({ type: "place" });
      case "undo": return emit({ type: "undo" });
      case "dismiss": return emit({ type: "dismiss" });
      case "reconcile": return emit({ type: "reconcile" });
      case "mergeYes": return emit({ type: "confirmMerge", yes: true });
      case "mergeNo": return emit({ type: "confirmMerge", yes: false });
    }
  });
  el.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.matches("input[data-field]")) { e.preventDefault(); submit(t.dataset["field"]!); }
  });
  function submit(field: string) { const i = el.querySelector<HTMLInputElement>(`input[data-field="${CSS.escape(field)}"]`); const v = i?.value.trim(); if (v) emit({ type: "answer", field: field as AnswerField, value: v }); }
  el.addEventListener("pointerdown", (e) => { if ((e.target as HTMLElement).closest("[data-act=hold]")) holdStart = performance.now(); });
  el.addEventListener("pointerup", (e) => { if ((e.target as HTMLElement).closest("[data-act=hold]")) emit({ type: "place", heldMs: performance.now() - holdStart }); });

  return {
    el, update,
    well: () => { if (el.hidden || model.mode === "pill" || model.mode === "off" || model.mode === "inspecting" || model.mode === "confirm") return null; const r = q(".rg-well").getBoundingClientRect(); return r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; },
    focus: () => { const t = el.querySelector<HTMLElement>(".rg-drum") ?? el.querySelector<HTMLElement>(".rg-actions button:not([disabled])") ?? el.querySelector<HTMLElement>("button"); t?.focus(); },
    destroy: () => el.remove(),
  };
}
export const HOLD_TO_CONFIRM_MS = HOLD_MS;

const xIcon = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
const checkIcon = '<svg class="rg-check" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

const rgba = (c: readonly number[]) => (c.length === 4 ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})` : `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
const vars = (t: (typeof GLASS_TOKENS)["light" | "dark"], edge: string, line: string, sel: string, shadow: string) =>
  `--g-tint: ${rgba(t.tint)}; --g-solid: ${rgba(t.solid)}; --g-ink: ${rgba(t.ink)}; --g-muted: ${rgba(t.muted)}; --g-accent: ${rgba(t.accent)}; --g-edge: ${edge}; --g-line: ${line}; --g-sel: ${sel}; --g-shadow: ${shadow};`;
const LIGHT = vars(GLASS_TOKENS.light, "rgba(255,255,255,.7)", "rgba(0,0,0,.10)", "rgba(255,255,255,.78)", "rgba(0,0,0,.16)");
const DARK = vars(GLASS_TOKENS.dark, "rgba(255,255,255,.14)", "rgba(255,255,255,.12)", "rgba(255,255,255,.10)", "rgba(0,0,0,.5)");

/** Styles for the module. Self-contained (a shadow root sees none of the page's styles), light and dark, with fallbacks. */
export const GLASS_CSS = `
.rg { ${LIGHT}
  position: fixed; z-index: 2147482990; left: 50%; bottom: var(--rg-bottom, 16px); translate: -50% 0;
  width: min(var(--rg-w, 340px), calc(100vw - 32px)); max-height: calc(100vh - var(--rg-bottom, 16px) - 24px); box-sizing: border-box;
  display: flex; flex-direction: column; overflow: hidden; border-radius: 22px; color: var(--g-ink);
  font: 400 14px/1.4 var(--rg-font, "Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  background: var(--g-tint); -webkit-backdrop-filter: blur(28px) saturate(170%); backdrop-filter: blur(28px) saturate(170%);
  border: 0.5px solid var(--g-line);
  box-shadow: inset 0 1px 0 var(--g-edge), inset 0 0 0 0.5px var(--g-edge), 0 1px 2px rgba(0,0,0,.08), 0 10px 30px var(--g-shadow), 0 30px 60px -28px var(--g-shadow);
  pointer-events: auto; -webkit-font-smoothing: antialiased; }
.rg[hidden] { display: none; }
.rg *, .rg *::before, .rg *::after { box-sizing: border-box; }
@media (prefers-color-scheme: dark) { .rg:not([data-theme="light"]) { ${DARK} } }
.rg[data-theme="dark"] { ${DARK} }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .rg { background: var(--g-solid); } }
@media (prefers-reduced-transparency: reduce) { .rg { background: var(--g-solid); -webkit-backdrop-filter: none; backdrop-filter: none; } }
@media (prefers-contrast: more) { .rg { background: var(--g-solid); border: 1px solid var(--g-ink); } }
.rg[data-mode="pill"] { width: auto; max-width: calc(100vw - 32px); border-radius: 999px; }
.rg-head { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px 6px 16px; }
.rg[data-mode="pill"] .rg-head { min-height: 40px; padding: 4px 6px 4px 14px; }
.rg-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--g-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-accent) 22%, transparent); }
.rg-title { flex: 1; min-width: 0; margin: 0; font-weight: 600; font-size: 13px; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
.rg[data-mode="pill"] .rg-title { font-weight: 500; }
.rg-head-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.rg-x { width: 30px; height: 30px; border: 0; border-radius: 50%; display: grid; place-items: center; background: transparent; color: var(--g-muted); cursor: pointer; }
.rg-x:hover { background: var(--g-sel); color: var(--g-ink); }
.rg-pill-btn { border: 0; border-radius: 999px; padding: 6px 12px; background: var(--g-ink); color: var(--g-solid); font-family: inherit; font-weight: 600; font-size: 12px; line-height: 1; cursor: pointer; }
.rg :focus-visible { outline: 2px solid var(--g-ink); outline-offset: 2px; }
.rg-well { display: none; height: 76px; margin: 0 12px; border-radius: 18px; background: color-mix(in srgb, var(--g-ink) 4%, transparent); box-shadow: inset 0 1px 2px rgba(0,0,0,.08), inset 0 0 0 0.5px var(--g-line); }
.rg-facts { display: none; flex-wrap: wrap; justify-content: center; gap: 2px 0; padding: 8px 16px 0; font-size: 12px; color: var(--g-muted); }
.rg-facts span + span::before { content: "·"; margin: 0 6px; }
.rg[data-mode="composed"] .rg-well, .rg[data-mode="choosing"] .rg-well, .rg[data-mode="preview"] .rg-well, .rg[data-mode="executing"] .rg-well, .rg[data-mode="succeeded"] .rg-well, .rg[data-mode="unknown"] .rg-well, .rg[data-mode="failed"] .rg-well { display: block; }
.rg[data-mode="composed"] .rg-facts, .rg[data-mode="choosing"] .rg-facts, .rg[data-mode="executing"] .rg-facts, .rg[data-mode="succeeded"] .rg-facts { display: flex; }
.rg-body { padding: 0 16px; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.rg-body:not(:empty) { padding-top: 10px; }
.rg-body p { margin: 0; }
.rg-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px 14px; }
.rg-actions:empty { display: none; }
.rg-btn { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 9px 16px; background: var(--g-ink); color: var(--g-solid); font-family: inherit; font-weight: 600; font-size: 13px; line-height: 1.1; cursor: pointer; }
.rg-btn.ghost { background: transparent; color: var(--g-ink); box-shadow: inset 0 0 0 1px var(--g-line); }
.rg-btn.small { padding: 6px 12px; }
.rg-btn[disabled] { opacity: .45; cursor: not-allowed; }
.rg-btn kbd, .rg-enter { font-family: inherit; font-weight: 600; font-size: 11px; line-height: 1; padding: 3px 5px; border-radius: 5px; background: color-mix(in srgb, currentColor 16%, transparent); }
.rg-hint { font-size: 12px; color: var(--g-muted); }
.rg-note, .rg-risk { font-size: 12px; color: var(--g-muted); }
.rg-error { font-size: 13px; color: var(--g-ink); padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--g-accent) 14%, transparent); }
/* The selector: a short drum. The chosen place sits in the middle in a raised capsule; its neighbours recede. */
.rg-drum-wrap { padding: 10px 12px 0; }
.rg-drum-wrap:empty { display: none; }
.rg-drum { position: relative; overflow: hidden; border-radius: 16px; outline: none; touch-action: none;
  -webkit-mask-image: linear-gradient(transparent, #000 30%, #000 70%, transparent); mask-image: linear-gradient(transparent, #000 30%, #000 70%, transparent); }
.rg-drum:focus-visible { outline: 2px solid var(--g-ink); outline-offset: -2px; -webkit-mask-image: none; mask-image: none; }
.rg-drum::before { content: ""; position: absolute; left: 0; right: 0; top: ${ROW}px; height: ${ROW}px; border-radius: 14px; background: var(--g-sel); box-shadow: inset 0 1px 0 var(--g-edge), 0 0 0 0.5px var(--g-line), 0 2px 8px rgba(0,0,0,.08); }
.rg-track { position: relative; transition: transform 180ms cubic-bezier(.2,.8,.2,1); }
.rg-opt { height: ${ROW}px; display: flex; align-items: center; gap: 12px; padding: 0 14px; cursor: pointer; opacity: .5; transform: scale(.94); transition: opacity 160ms, transform 160ms; }
.rg-opt.near { opacity: .72; }
.rg-opt.on { opacity: 1; transform: none; }
.rg-opt .rg-ico { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: color-mix(in srgb, var(--g-ink) 7%, transparent); }
.rg-opt.on .rg-ico { background: var(--g-ink); color: var(--g-solid); }
.rg-opt.off .rg-ico { background: transparent; box-shadow: inset 0 0 0 1px var(--g-line); }
.rg-name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rg-label { font-weight: 600; font-size: 14px; }
.rg-opt.off .rg-label { text-decoration: line-through; text-decoration-thickness: 1px; text-decoration-color: var(--g-muted); }
.rg-sub { font-size: 11px; color: var(--g-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rg-enter { visibility: hidden; }
.rg-opt.on:not(.off) .rg-enter { visibility: visible; }
.rg-reason { margin: 8px 4px 0; min-height: 34px; font-size: 12px; color: var(--g-muted); }
.rg-reason.nudge { animation: rg-nudge 240ms ease-out; }
@keyframes rg-nudge { 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
/* Review */
.rg-fields { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.rg-row { display: grid; grid-template-columns: 72px 1fr; gap: 8px; }
.rg-row dt { color: var(--g-muted); font-size: 12px; }
.rg-row dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.rg-origin { font-size: 10.5px; color: var(--g-muted); border: 0.5px solid var(--g-line); border-radius: 999px; padding: 0 6px; white-space: nowrap; }
.rg-needs { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--g-accent) 10%, transparent); box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--g-accent) 40%, transparent); }
.rg-needs h3 { margin: 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--g-ink); }
.rg-missing { display: flex; flex-direction: column; gap: 6px; }
.rg-missing label { font-weight: 600; }
.rg-why { font-size: 12px; }
.rg-chip { align-self: flex-start; border: 0; border-radius: 999px; padding: 6px 12px; background: var(--g-sel); color: var(--g-ink); box-shadow: inset 0 0 0 1px var(--g-line); font-family: inherit; font-weight: 500; font-size: 12px; line-height: 1.2; cursor: pointer; }
.rg-answer { display: flex; gap: 6px; }
.rg-answer input { flex: 1; min-width: 0; padding: 7px 10px; border: 0; border-radius: 10px; background: var(--g-sel); color: var(--g-ink); box-shadow: inset 0 0 0 1px var(--g-line); font: inherit; }
.rg-assume { margin: 0; padding-left: 18px; font-size: 12px; color: var(--g-muted); }
.rg-ingredients { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rg-ingredients li { display: grid; grid-template-columns: auto 1fr auto; gap: 0 10px; align-items: baseline; padding: 8px 10px; border-radius: 12px; background: var(--g-sel); box-shadow: inset 0 0 0 0.5px var(--g-line); }
.rg-kind { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--g-muted); }
.rg-what { min-width: 0; overflow-wrap: anywhere; }
.rg-src { grid-column: 2; font-size: 11px; color: var(--g-muted); }
.rg-link { grid-column: 3; grid-row: 1 / span 2; border: 0; background: none; color: var(--g-ink); text-decoration: underline; cursor: pointer; font-family: inherit; font-size: 12px; }
.rg-check { color: var(--g-accent); stroke-dasharray: 20; stroke-dashoffset: 0; animation: rg-check 260ms ease-out; }
@keyframes rg-check { from { stroke-dashoffset: 20; } }
@media (max-width: 480px) { .rg:not([data-mode="pill"]) { left: 16px; right: 16px; width: auto; translate: none; } }
@media (prefers-reduced-motion: reduce) { .rg-track, .rg-opt { transition: none; } .rg-check, .rg-reason.nudge { animation: none; } }
`;
