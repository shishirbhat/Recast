// The Recast instrument: a small piece of optical glass that floats over the page. Framework-free DOM, so the same module
// runs in the clay page, in the browser extension's shadow root and in the try-it page.
//
// It renders a `ModuleModel` (packages/interaction/src/wheel.ts) and reports what the person asks for as intents; it never
// changes state itself. One silhouette changes shape: a pill while Recast is on; a capsule around the composition when two
// things have been pressed together; the capsule opens into a drum wheel of destinations beside the object; the wheel
// contracts into the review; the review closes into a receipt. The clay object is not drawn here: the module leaves a well
// at its centre and the host places the real blob in it (`well()`), so the composition stays one tangible object throughout.
import type { AnswerField, EventField, Operation } from "@recast/core";
import { escapeEvent, reduceClump, type ClumpInput, type ClumpState, type ModuleModel, type WheelEntry, type WheelKey } from "@recast/interaction";

export type GlassIntent =
  | { type: "turnOff" } | { type: "reopen" } | { type: "close" } | { type: "back" } | { type: "placeIt" }
  | { type: "openWheel" } | { type: "select"; choice: WheelKey } | { type: "pick"; destinationId: string }
  | { type: "inspect" } | { type: "remove"; ingredientId: string }
  | { type: "answer"; field: AnswerField; value: string } | { type: "choose"; field: EventField; ingredientId: string }
  | { type: "place"; heldMs?: number } | { type: "undo" } | { type: "dismiss" } | { type: "reconcile" } | { type: "confirmMerge"; yes: boolean }
  | { type: "openRecipe"; recipeId: string } | { type: "toggleStep"; stepId: string } | { type: "runRecipe"; heldMs?: number } | { type: "undoStep"; stepId: string }
  /** Only where the host offers it (`takePage`): the host captures the page itself, then opens the module on it. */
  | { type: "takePage" };

/** The state-machine events for what the person asked the module for. Shared by every host, so they behave the same. */
export function intentEvents(i: GlassIntent, s: ClumpState): ClumpInput[] {
  const id = s.placement?.objectId ?? s.inspecting ?? s.focus;
  switch (i.type) {
    case "turnOff": return [{ type: "disarm" }];
    case "reopen": return [{ type: "openModule" }];
    // From "Inside this object": open the module on that object (a single place can already go to a map).
    case "placeIt": return s.inspecting ? [{ type: "openModule", id: s.inspecting }] : [];
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
    case "openRecipe": return [{ type: "openRecipe", recipeId: i.recipeId, ...(s.focus ? { id: s.focus } : {}) }];
    case "toggleStep": return [{ type: "toggleStep", stepId: i.stepId }];
    case "runRecipe": return [{ type: "runRecipe", consent: i.heldMs !== undefined ? { kind: "hold", heldMs: i.heldMs } : { kind: "confirm" } }];
    case "undoStep": return [{ type: "undoStep", stepId: i.stepId }];
    case "takePage": return [];
  }
}

export interface Glass {
  update(model: ModuleModel, extra?: { error?: string }): void;
  /** Where the host should draw the composition (viewport coordinates), or null when the module shows none. */
  well(): { x: number; y: number } | null;
  /** Move keyboard focus into the module (the wheel when it is open, else the first action). */
  focus(): void;
  readonly el: HTMLElement;
  destroy(): void;
}

/**
 * Colours, as numbers so a test can check contrast over the worst backdrops (pure black and pure white) instead of trusting
 * the blur. `tint` is the glass (rgb + alpha); `solid` is the fallback where blur or transparency is unavailable.
 * Warm ivory and warm charcoal, with the ember accent (docs/design-direction.md).
 */
export const GLASS_TOKENS = {
  light: { tint: [250, 248, 243, 0.78], solid: [244, 241, 234], ink: [25, 23, 20], muted: [79, 74, 67], accent: [194, 65, 12] },
  dark: { tint: [24, 22, 19, 0.78], solid: [31, 28, 23], ink: [245, 241, 232], muted: [207, 200, 187], accent: [249, 115, 22] },
} as const;

// Icons: drawn on a 24px grid, 1.6px strokes, two tones (the second at reduced opacity) so they read as small objects.
const ICON: Record<WheelKey, string> = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17" /><path d="M8 3v4M16 3v4"/><rect x="7" y="13" width="3.2" height="3.2" rx=".8" fill="currentColor" stroke="none" opacity=".55"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="3"/><path d="m4.5 7.5 7.5 5.6 7.5-5.6"/><path d="M3.8 17.4 9.6 12M20.2 17.4 14.4 12" opacity=".45"/>',
  tasks: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="m8 12.2 2.8 2.8L16.2 9"/>',
  documents: '<path d="M7 3.5h7l4.5 4.5V19A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z"/><path d="M14 3.5V8h4.5"/><path d="M8.5 12.5h7M8.5 16h5" opacity=".55"/>',
  more: '<circle cx="12" cy="12" r="8.5" opacity=".45"/><circle cx="8" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
};
const svg = (k: WheelKey, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const FIELD_LABEL: Record<string, string> = { title: "Title", start: "When", end: "Ends", allDay: "All day", timezone: "Time zone", location: "Where", description: "Notes", to: "To", snippet: "Message", subject: "Subject", url: "Link", due: "Due", body: "Text" };
const ORIGIN: Record<string, string> = { extracted: "from the page", inferred: "Recast's reading", default: "a default", user: "you" };
const EFFECT_WORDS: Record<string, string> = { send: "It sends something", delete: "It deletes something", publish: "It publishes", financial: "It involves money", "modifies-important": "It changes something important" };
/** Why a review asks for more than a click, in words (the trust model's reasons are written for logs and tests). */
export function riskWords(reasons: readonly string[]): string {
  const out = reasons.flatMap((r) => {
    if (r.startsWith("relation base risk") || r.startsWith("opens the app")) return [];
    if (r.startsWith("confidence")) return ["Recast is not sure of part of this reading: check it before you confirm"];
    if (r === "notifies someone else") return ["Someone else will be notified"];
    if (r === "cannot be undone") return ["It cannot be undone from Recast"];
    if (r.startsWith("effect is ")) return r.slice(10).split(", ").map((f) => EFFECT_WORDS[f] ?? r);
    if (r.includes("UI automation")) return ["The destination is driven through its screen, which can break"];
    return [r];
  });
  return out.length ? `${[...new Set(out)].join(". ")}.` : "Check it before you confirm.";
}
const INPUT_HINT: Record<string, string> = { start: "2026-10-23T19:30", end: "2026-10-23T21:00", title: "Dinner with Maya", to: "maya@example.com", due: "2026-10-23" };
function fmt(field: string, v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if ((field === "start" || field === "end" || field === "due") && typeof v === "string") { const d = new Date(v.length === 10 ? `${v}T00:00` : v); return isNaN(+d) ? v : d.toLocaleString("en", { weekday: "short", day: "numeric", month: "short", ...(v.length > 10 ? { hour: "numeric", minute: "2-digit" } : {}) }); }
  return String(v);
}
const sure = (c: number) => (c >= 0.85 ? "sure" : c >= 0.6 ? "likely" : "unsure");

// The wheel is a cylinder: rows sit on its surface STEP degrees apart and the cylinder turns behind a fixed lens.
const ROW = 46;                                         // px, one row's height at the lens
const STEP = 24;                                        // degrees between rows
const RADIUS = ROW / (2 * Math.tan((STEP * Math.PI) / 360));
const DRUM_H = 214;
const HOLD_MS = 600;

type Row = { key: string; label: string; sub: string; available: boolean; reason?: string; destinationId?: string; icon: WheelKey };

export function createGlass(root: HTMLElement | ShadowRoot, opts: { onIntent: (i: GlassIntent) => void; onLayout?: () => void; reducedMotion?: () => boolean; shortcut?: string; theme?: () => "light" | "dark" | undefined;
  /** The label of a pill button that takes the whole page as one object ("This page"). Absent: no such button. */
  takePage?: string;
  /** For open-and-prefill destinations: the address the reviewed operation opens. The confirm button is then a real link,
   *  so the browser opens it from the person's own click. Absent, or undefined for an operation: that destination is not offered here. */
  linkFor?: (op: Operation) => string | undefined;
  /** How this host opens a link (the desktop app: the person's default browser). Returns false when it could not. */
  openLink?: (url: string) => boolean;
  /** How this host names a value taken from what the person captured (the browser: "from the page"). */
  capturedLabel?: string }): Glass {
  const reduced = opts.reducedMotion ?? (() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const el = document.createElement("div"); el.className = "rg"; el.dataset["mode"] = "off"; el.hidden = true;
  el.setAttribute("role", "region"); el.setAttribute("aria-label", "Recast");
  el.innerHTML = `<div class="rg-sheen" aria-hidden="true"></div>
    <div class="rg-head"><span class="rg-mark" aria-hidden="true"></span><p class="rg-title" role="status" aria-live="polite"></p><span class="rg-head-actions"></span></div>
    <div class="rg-stage"><div class="rg-left"><div class="rg-well" aria-hidden="true"></div><div class="rg-facts"></div></div><div class="rg-side"></div></div>
    <div class="rg-body"></div><div class="rg-actions"></div>`;
  root.appendChild(el);
  const q = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;
  let model: ModuleModel = { mode: "off" };
  // A place opened into its own list: "More" (the rest of the registry), or a place with several connected choices
  // (for example GitHub and Linear under Tasks), so the person picks one instead of Recast picking for them.
  let drill: WheelKey | null = null;
  let blocked: string | null = null;        // an open-and-prefill link the browser refused to open in a new tab
  let holdStart = 0;
  const emit = (i: GlassIntent) => opts.onIntent(i);

  // ---- the light: a soft specular highlight that drifts toward the pointer, so the surface reads as curved glass -------
  let sheenRaf = 0;
  el.addEventListener("pointermove", (e) => {
    if (reduced() || sheenRaf) return;
    sheenRaf = requestAnimationFrame(() => {
      sheenRaf = 0; const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${Math.round(((e.clientX - r.left) / r.width) * 100)}%`);
      el.style.setProperty("--my", `${Math.round(((e.clientY - r.top) / r.height) * 100)}%`);
    });
  });
  el.addEventListener("pointerleave", () => { el.style.removeProperty("--mx"); el.style.removeProperty("--my"); });

  /** The rows the wheel shows now: the five places, or the registry entries under "More". */
  function rows(m: Extract<ModuleModel, { entries: WheelEntry[] }>): Row[] {
    if (drill) {
      const entry = m.entries.find((e) => e.key === drill)!;
      const shown = drill === "more" ? entry.options : entry.options.filter((o) => o.available);
      return [...shown.map((o) => ({ key: `${drill}:${entry.options.indexOf(o)}`, label: o.app, sub: o.effect, available: o.available, ...(o.reason ? { reason: o.reason } : {}), ...(o.destinationId ? { destinationId: o.destinationId } : {}), icon: drill! })),
        { key: `${drill}:back`, label: "Back", sub: "to the five places", available: true, icon: drill }];
    }
    return m.entries.map((e) => {
      const live = e.options.filter((o) => o.available);
      const sub = e.available ? `${live.map((o) => o.app).join(" or ")}${e.standIn ? " · stand-in" : ""}` : "Unavailable";
      return { key: e.key, label: e.label, sub, available: e.available, ...(e.reason ? { reason: e.reason } : {}), ...(e.destinationId ? { destinationId: e.destinationId } : {}), icon: e.key };
    });
  }

  // ---- the wheel ------------------------------------------------------------------------------------------------------
  // pos: where the cylinder is (fractional rows); target: the row it is settling on. Wheel notches and keys move the
  // target one row at a time; trackpad scrolling and touch drag turn the cylinder continuously, then it snaps to the
  // nearest row. The settle is a short critically damped ease (no overshoot, no spin): a precision instrument.
  let wRows: Row[] = [], pos = 0, target = 0, wRaf = 0, wLast = 0, settleTimer = 0, notchAt = 0, sig = "";
  const clampI = (i: number) => Math.max(0, Math.min(wRows.length - 1, i));
  function drawWheel() {
    const opts2 = el.querySelectorAll<HTMLElement>(".rg-opt"); const focal = Math.round(pos);
    opts2.forEach((o, i) => {
      const a = (i - pos) * STEP; const vis = Math.abs(a) < 88;
      o.style.visibility = vis ? "visible" : "hidden";
      o.style.transform = `rotateX(${-a}deg) translateZ(${RADIUS}px)`;
      o.style.opacity = vis ? String(Math.max(0, Math.cos((a * Math.PI) / 180)) ** 2.2) : "0";
      o.classList.toggle("on", i === focal);
    });
  }
  function frame(t: number) {
    const dt = Math.min(0.05, (t - wLast) / 1000); wLast = t;
    pos += (target - pos) * (1 - Math.exp(-dt / 0.055));
    if (Math.abs(target - pos) < 0.003) { pos = target; drawWheel(); wRaf = 0; settled(); return; }
    drawWheel(); wRaf = requestAnimationFrame(frame);
  }
  /** The person has the wheel: stop any settling motion so it never fights their fingers. */
  function stop() { if (wRaf) { cancelAnimationFrame(wRaf); wRaf = 0; } }
  function animate() { if (reduced()) { pos = target; drawWheel(); settled(); return; } if (!wRaf) { wLast = performance.now(); wRaf = requestAnimationFrame(frame); } }
  /** The small "click" of a detent: the lens rim brightens and the chosen row firms up, once, when the wheel comes to rest. */
  function settled() {
    if (reduced()) return;
    const lens = el.querySelector(".rg-lens"); const on = el.querySelector(".rg-opt.on");
    for (const x of [lens, on]) { if (!x) continue; x.classList.remove("tick"); void (x as HTMLElement).offsetWidth; x.classList.add("tick"); }
  }
  function go(i: number) {
    const next = clampI(i); const changed = next !== target; target = next; animate();
    if (changed) choose(next);
    reason();
  }
  function choose(i: number) {
    if (model.mode !== "choosing" || drill) return;
    const e = model.entries[i]; if (e && e.key !== model.choice) emit({ type: "select", choice: e.key });
  }
  function reason() {
    const r = wRows[target]; const line = el.querySelector(".rg-reason"); if (!r || !line) return;
    line.textContent = r.available ? (r.key === "more" ? "Other destinations Recast connects to" : r.key.endsWith(":back") ? "" : `${rowEffect(r.key)}${r.sub.includes("stand-in") ? ". A local stand-in: nothing reaches the real service" : ""}`) : (r.reason ?? "");
    const drum = el.querySelector(".rg-drum"); drum?.setAttribute("aria-activedescendant", `rg-opt-${r.key.replace(":", "-")}`);
    el.querySelectorAll<HTMLElement>(".rg-opt").forEach((o, j) => o.setAttribute("aria-selected", String(j === target)));
    const open = el.querySelector<HTMLButtonElement>(".rg-actions [data-act=open]"); if (open) open.disabled = !r.available;
  }
  function rowEffect(key: string): string {
    if (model.mode !== "choosing") return "";
    if (drill) { const entry = model.entries.find((x) => x.key === drill)!; const m = entry.options[Number(key.split(":")[1])]; return m ? `${m.app}: ${m.effect.toLowerCase()}` : ""; }
    const o = model.entries.find((x) => x.key === key)?.options.find((x) => x.available);
    return o ? `${o.app}: ${o.effect.toLowerCase()}` : "";
  }
  function openSelected() {
    if (model.mode !== "choosing") return;
    const r = wRows[target]; if (!r) return;
    // "More" opens even when nothing in it fits: the person can still see what is there and why not.
    if (r.key === "more") { drill = "more"; update(model); return; }
    if (r.key.endsWith(":back")) { drill = null; update(model); return; }
    const entry = model.entries.find((x) => x.key === r.key);
    if (entry && entry.options.filter((o) => o.available).length > 1) { drill = entry.key; update(model); return; }
    if (!r.available || !r.destinationId) { const line = el.querySelector(".rg-reason"); line?.classList.remove("nudge"); void (line as HTMLElement | null)?.offsetWidth; line?.classList.add("nudge"); return; }
    emit({ type: "pick", destinationId: r.destinationId });
  }
  function renderWheel() {
    const side = q(".rg-side");
    const m = model;
    if (m.mode !== "choosing") { if (sig) { side.innerHTML = ""; sig = ""; } return; }
    const list = rows(m); const s = JSON.stringify([drill, list.map((r) => [r.key, r.available, r.sub, r.reason])]);
    // Into "More": land on the first place that takes this object, not on the first in the list.
    const want = drill ? (sig.startsWith(`["${drill}"`) ? target : Math.max(0, list.findIndex((r) => r.available && !r.key.endsWith(":back")))) : Math.max(0, m.entries.findIndex((e) => e.key === m.choice));
    if (s !== sig) {
      const fresh = !sig || JSON.parse(sig)[0] !== drill; sig = s; wRows = list;
      side.innerHTML = `<div class="rg-drum" role="listbox" tabindex="0" aria-label="${drill === "more" ? "More destinations" : drill ? "Which one" : "Where it goes"}" style="height:${DRUM_H}px">
        <div class="rg-lens" aria-hidden="true"></div><div class="rg-cyl">${list.map((r) =>
        `<div class="rg-opt${r.available ? "" : " off"}" role="option" id="rg-opt-${esc(r.key.replace(":", "-"))}" data-key="${esc(r.key)}" aria-disabled="${!r.available}"><span class="rg-ico">${svg(r.icon)}</span><span class="rg-name"><span class="rg-label">${esc(r.label)}</span><span class="rg-sub">${esc(r.sub)}</span></span><kbd class="rg-enter" aria-hidden="true">↵</kbd></div>`).join("")}</div></div>`;
      wire(q(".rg-drum"));
      if (fresh) { target = want; pos = want + (reduced() ? 0 : 0.6); }   // the cylinder turns into place as it appears
      animate();
    } else if (want !== target && !settleTimer && !drill) { target = want; animate(); }   // the state moved it (another tab, a test)
    reason();
  }
  function wire(drum: HTMLElement) {
    drum.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * ROW : e.deltaMode === 2 ? e.deltaY * DRUM_H : e.deltaY;
      // A mouse wheel sends whole notches (≈100px): one row per notch. A trackpad sends a stream of small deltas: the
      // cylinder follows the fingers (with a little resistance at the ends), then snaps to the nearest row.
      if (Math.abs(dy) >= 50) { const t = performance.now(); if (t - notchAt > 60) { notchAt = t; go(target + Math.sign(dy)); } return; }
      stop(); pos = Math.max(-0.35, Math.min(wRows.length - 1 + 0.35, pos + dy / ROW)); drawWheel();
      clearTimeout(settleTimer); settleTimer = window.setTimeout(() => { settleTimer = 0; go(Math.round(pos)); }, 110);
    }, { passive: false });
    drum.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "ArrowDown" || k === "ArrowRight") { e.preventDefault(); go(target + 1); }
      else if (k === "ArrowUp" || k === "ArrowLeft") { e.preventDefault(); go(target - 1); }
      else if (k === "Home") { e.preventDefault(); go(0); }
      else if (k === "End") { e.preventDefault(); go(wRows.length - 1); }
      else if (k === "Enter" || k === " ") { e.preventDefault(); openSelected(); }
    });
    drum.addEventListener("click", (e) => {
      const opt = (e.target as HTMLElement).closest<HTMLElement>(".rg-opt"); if (!opt || moved) return;
      const i = wRows.findIndex((r) => r.key === opt.dataset["key"]);
      if (i === target) openSelected(); else go(i);
      drum.focus();
    });
    // Touch and pen: drag the cylinder; it snaps when you let go.
    let sy: number | null = null, moved = false;
    drum.addEventListener("pointerdown", (e) => { moved = false; if (e.pointerType !== "mouse") { sy = e.clientY; drum.setPointerCapture?.(e.pointerId); } });
    drum.addEventListener("pointermove", (e) => {
      if (sy === null) return; const d = e.clientY - sy; if (Math.abs(d) > 4) moved = true;
      stop(); pos = Math.max(-0.35, Math.min(wRows.length - 1 + 0.35, pos - d / ROW)); sy = e.clientY; drawWheel();
    });
    const end = () => { if (sy === null) return; sy = null; if (moved) go(Math.round(pos)); setTimeout(() => { moved = false; }, 0); };
    drum.addEventListener("pointerup", end); drum.addEventListener("pointercancel", end);
  }

  // ---- everything else: rebuilt only when its text changes, keeping focus where it was ---------------------------------
  /** Recipes for this object, under the one main action: small, and only the ones that fit its kind. */
  function recipeChips(m: Extract<ModuleModel, { object: unknown }>): string {
    const offers = m.recipes ?? []; if (!offers.length) return "";
    return `<div class="rg-recipes" role="group" aria-label="Recipes"><span class="rg-recipes-label">Or run a recipe</span>${offers.map((o) =>
      `<button type="button" class="rg-chip rg-recipe" data-recipe="${esc(o.id)}"${o.available ? "" : ` disabled aria-describedby="rg-why-${esc(o.id)}"`} title="${esc(o.available ? o.description : o.reason ?? "")}">${esc(o.name)}</button>${o.available ? "" : `<span class="rg-why-line" id="rg-why-${esc(o.id)}">${esc(o.name)}: ${esc(o.reason ?? "")}</span>`}`).join("")}</div>`;
  }
  const STATUS: Record<string, string> = { ready: "", blocked: "Can't run", skipped: "Left out", waiting: "Waiting", running: "Sending…", done: "Done", failed: "Not added", unknown: "No answer", undoing: "Undoing…", undone: "Removed" };
  /** A recipe: each step, where it goes and what it uses; then each step's own outcome. */
  function runView(m: Extract<ModuleModel, { object: unknown }>, err: string, close: string) {
    const run = m.run!; const planning = m.mode === "plan";
    const items = run.steps.map((x) => {
      const where = x.app ? `${esc(x.app)}${x.standIn ? " · stand-in" : ""}` : "not connected";
      const tick = planning ? `<input type="checkbox" data-step="${esc(x.id)}" ${x.include ? "checked" : ""} ${x.status === "ready" ? "" : "disabled"} aria-label="${esc(x.label)}">` : `<span class="rg-step-status" data-status="${x.status}">${STATUS[x.status] ?? x.status}</span>`;
      const lines = [
        `<span class="rg-step-where">${where}</span>`,
        x.uses.length ? `<span class="rg-step-uses">Uses ${esc(x.uses.join(", "))}</span>` : "",
        x.note && planning ? `<span class="rg-step-note">${esc(x.note)}</span>` : "",
        x.reason && x.status === "blocked" ? `<span class="rg-step-why">${esc(x.reason.charAt(0).toUpperCase() + x.reason.slice(1))}</span>` : "",
        x.message ? `<span class="rg-step-why">${esc(x.message)}</span>` : "",
        x.status === "unknown" ? `<span class="rg-step-why">Check ${esc(x.app ?? "it")} before placing it there again. Recast will not send it again.</span>` : "",
      ].join("");
      const undo = m.mode === "ran" && x.status === "done" && x.undoable ? `<button type="button" class="rg-link" data-undo-step="${esc(x.id)}">Undo</button>` : "";
      return `<li data-step-id="${esc(x.id)}" data-status="${x.status}"><label class="rg-step">${tick}<span class="rg-step-text"><span class="rg-step-label">${esc(x.label)}</span>${lines}</span></label>${undo}</li>`;
    }).join("");
    const chosen = run.steps.filter((x) => x.include && x.status === "ready");
    const hold = chosen.some((x) => x.op?.risk.consent === "hold");
    const title = planning ? `Recipe: ${esc(run.name)}` : m.mode === "running" ? `Running ${esc(run.name)}…` : esc(m.text ?? run.name);
    const actions = planning
      ? `${hold ? `<button type="button" class="rg-btn primary hold" data-act="holdRecipe" ${chosen.length ? "" : "disabled"}>Hold to run ${chosen.length} ${chosen.length === 1 ? "step" : "steps"}</button>` : `<button type="button" class="rg-btn primary" data-act="runRecipe" ${chosen.length ? "" : "disabled"}>Run ${chosen.length} ${chosen.length === 1 ? "step" : "steps"}</button>`}<button type="button" class="rg-btn ghost" data-act="back">Cancel</button>`
      : m.mode === "ran" ? `<button type="button" class="rg-btn" data-act="dismiss">Done</button>` : "";
    const intro = planning ? `<p class="rg-hint">Nothing is written until you run it. Each step goes to its own place and gets its own result.</p>` : "";
    // The event itself still needs something (a title, a date): asked here, as in a review, then the steps are worked out again.
    const finish = planning && run.steps.some((x) => x.reason?.startsWith("the event is not complete")) ? detail(m) : "";
    return { title, head: planning ? close : "", facts: "", body: `${err}${intro}${finish}<ul class="rg-steps">${items}</ul>`, actions };
  }

  function detail(m: Extract<ModuleModel, { object: unknown }>): string {
    const v = m.object.view; const fields = (v.event?.fields ?? v.message?.fields ?? v.document?.fields ?? v.task?.fields ?? v.note?.fields ?? v.issue?.fields ?? {}) as Record<string, { value: unknown; origin: string } | undefined>;
    const rowsHtml = Object.entries(fields).filter(([, f]) => f).map(([k, f]) => `<div class="rg-row"><dt>${FIELD_LABEL[k] ?? k}</dt><dd>${esc(fmt(k, f!.value))} <span class="rg-origin">${(f!.origin === "extracted" && opts.capturedLabel) || (ORIGIN[f!.origin] ?? f!.origin)}</span></dd></div>`).join("");
    const missing = v.missing.map((x) => {
      const id = `rg-in-${x.field}`;
      return `<div class="rg-missing"><label for="${id}">${FIELD_LABEL[x.field] ?? x.field}</label><p class="rg-why">${esc(x.reason)}</p>${(x.suggestions ?? []).map((s) => `<button type="button" class="rg-chip" data-answer="${x.field}" data-value="${esc(s)}">Use “${esc(s)}”</button>`).join("")}<div class="rg-answer"><input id="${id}" data-field="${x.field}" placeholder="${INPUT_HINT[x.field] ?? ""}" autocomplete="off"><button type="button" class="rg-btn small ghost" data-submit="${x.field}">Set</button></div></div>`;
    }).join("");
    const conflicts = v.conflicts.map((c) => `<div class="rg-missing"><p class="rg-why">${FIELD_LABEL[c.field] ?? c.field}: the pieces disagree. Which one is right?</p>${c.options.map((o) => `<button type="button" class="rg-chip" data-choose="${c.field}" data-ingredient="${esc(o.fragmentId)}">${esc(o.original)}</button>`).join("")}</div>`).join("");
    const assumptions = v.assumptions.length ? `<ul class="rg-assume">${v.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : "";
    return `${rowsHtml ? `<dl class="rg-fields">${rowsHtml}</dl>` : ""}${missing || conflicts ? `<div class="rg-needs"><h3>Still needed</h3>${conflicts}${missing}</div>` : ""}${assumptions}`;
  }
  const iconBtn = (act: string, label: string, path: string) => `<button type="button" class="rg-x" data-act="${act}" aria-label="${esc(label)}" title="${esc(label)}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg></button>`;
  const X = "<path d='m4 4 8 8M12 4l-8 8'/>", LAYERS = "<path d='m8 2.5 5.5 3L8 8.5l-5.5-3z'/><path d='m2.5 8.5 5.5 3 5.5-3' opacity='.6'/>";
  function content(m: ModuleModel, error?: string): { title: string; head: string; facts: string; body: string; actions: string } {
    const close = iconBtn("close", "Close (Esc). Your composition is kept", X);
    if (m.mode === "off") return { title: "", head: "", facts: "", body: "", actions: "" };
    if (m.mode === "pill") return {
      title: esc(m.text), facts: "", body: "", actions: "",
      head: `${m.reopen ? `<button type="button" class="rg-pill-btn" data-act="reopen">Open</button>` : ""}${opts.takePage && !m.carrying ? `<button type="button" class="rg-pill-btn ghost" data-act="takePage">${esc(opts.takePage)}</button>` : ""}${opts.shortcut ? `<span class="rg-kbd" aria-hidden="true">${esc(opts.shortcut)}</span>` : ""}${iconBtn("turnOff", `Turn Recast off${opts.shortcut ? ` (${opts.shortcut})` : ""}`, X)}`,
    };
    const v = m.object.view; const facts = v.summary.filter(Boolean).slice(0, 3).map((s) => `<span>${esc(s)}</span>`).join("");
    const err = error ? `<p class="rg-error" role="alert">${esc(error.charAt(0).toUpperCase() + error.slice(1))}</p>` : "";
    const d = m.destination; const where = d ? d.label : "the destination";
    const dIcon = d ? `<span class="rg-dest" aria-hidden="true">${svg(d.key, 16)}</span>` : "";
    const standIn = d?.standIn ? `<p class="rg-note">Stand-in: ${esc(d.app)} here is a local stand-in. Nothing reaches the real ${esc(d.app)}.</p>` : "";
    switch (m.mode) {
      case "composed": return m.text
        ? { title: "Add to it?", head: "", facts: "", body: `<p class="rg-hint">${esc(m.text)}</p>`, actions: "" }
        : { title: "Ready to place", head: `${iconBtn("inspect", "Look inside", LAYERS)}${close}`, facts: "", body: err,
            actions: `<button type="button" class="rg-go" data-act="openWheel" aria-label="Choose where it goes (Enter)"><span>Choose where it goes</span><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg></button>${recipeChips(m)}` };
      case "plan": case "running": case "ran": return runView(m, err, close);
      case "choosing": return { title: drill === "more" ? "More places" : drill ? `${esc(m.entries.find((e) => e.key === drill)?.label ?? "")}: which one?` : "Where should it go?", head: close, facts, body: `${err}<p class="rg-reason" aria-live="polite"></p>`,
        actions: `<button type="button" class="rg-btn" data-act="open">Open <kbd>↵</kbd></button><button type="button" class="rg-btn ghost" data-act="back">Back</button>` };
      case "inspecting": return { title: "Inside this object", head: close, facts: "",
        body: `${err}<ul class="rg-ingredients">${m.object.ingredients.map((f) => `<li><span class="rg-kind">${esc(f.kind)}</span><span class="rg-what">${esc(f.text)}</span><span class="rg-src">from ${esc(f.from)} · <span class="rg-conf" title="How sure Recast is about this reading">${sure(f.confidence)} <span class="rg-num">${Math.round(f.confidence * 100)}%</span></span></span>${m.object.ingredients.length > 1 ? `<button type="button" class="rg-link" data-remove="${esc(f.id)}" aria-label="Take ${esc(f.text)} out">Take out</button>` : ""}</li>`).join("")}</ul>${detail(m)}`,
        actions: `${m.object.view.placeableAs.length ? `<button type="button" class="rg-btn" data-act="placeIt">Choose where it goes</button>` : ""}<button type="button" class="rg-btn${m.object.view.placeableAs.length ? " ghost" : ""}" data-act="back">Done</button>` };
      case "confirm": return { title: "Combine them?", head: "", facts: "", body: `<p>${esc(m.confirm ?? "")}</p>`,
        actions: `<button type="button" class="rg-btn" data-act="mergeYes">Combine</button><button type="button" class="rg-btn ghost" data-act="mergeNo">Keep apart</button>` };
      case "preview": {
        const op = m.placement?.op;
        const risk = op ? `<p class="rg-risk">${op.risk.tier === "low" ? "Low risk: adds an entry only you see, and it can be undone." : esc(riskWords(op.risk.reasons))}</p>` : "";
        const link = op && d?.opensOnly ? opts.linkFor?.(op) : undefined;
        if (op && d?.opensOnly) {
          // Open and prefill: nothing is written by Recast, so the review says so instead of a risk line.
          const open = link ? `<a class="rg-btn primary" data-act="place" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(op.proposal.effect)} in ${esc(d.app)}</a>` : `<button type="button" class="rg-btn primary" disabled>${esc(d.app)} cannot be opened from here</button>`;
          // The browser may refuse a new tab here (a pop-up blocker, or a page embedded without permission to open one).
          // Then nothing is claimed: the address is shown to open by hand.
          const refused = link && blocked === link ? `<p class="rg-error" role="alert">Your browser did not open a new tab: this page may not be allowed to. Open the address yourself:</p>${copyBox(link, d.app)}` : "";
          return { title: `${dIcon}${esc(where)}: review`, head: close, facts: "", body: `${err}${detail(m)}<p class="rg-risk">Opens ${esc(d.app)} in a new tab with this filled in. Recast saves nothing; you finish there.</p>${refused}`, actions: `${open}<button type="button" class="rg-btn ghost" data-act="back">Cancel</button>` };
        }
        const go = op ? (op.risk.consent === "hold" ? `<button type="button" class="rg-btn primary hold" data-act="hold">Hold to confirm: ${esc(op.proposal.effect.toLowerCase())}</button>` : `<button type="button" class="rg-btn primary" data-act="place">Confirm: ${esc(op.proposal.effect)}</button>`) : `<button type="button" class="rg-btn primary" disabled>Answer what is still needed</button>`;
        return { title: `${dIcon}${esc(where)}: review`, head: close, facts: "", body: `${err}${detail(m)}${risk}${standIn}`, actions: `${go}<button type="button" class="rg-btn ghost" data-act="back">Cancel</button>` };
      }
      case "executing": return { title: `${dIcon}${d?.opensOnly ? "Opening" : "Adding to"} ${esc(where)}…`, head: "", facts: "", body: `<p class="rg-hint">Waiting for ${esc(where)} to confirm.</p>${err}`, actions: "" };
      case "undoing": return { title: `${dIcon}Undoing in ${esc(where)}…`, head: "", facts: "", body: `<p class="rg-hint">Waiting for ${esc(where)} to confirm it is removed.</p>${err}`, actions: "" };
      case "succeeded": if (d?.opensOnly) return { title: `<span class="rg-dest done" aria-hidden="true">${svg(d.key, 16)}${checkIcon}</span>Opened ${esc(where)}`, head: "", facts: "",
          body: `<p class="rg-hint">${esc(where)} opened in a new tab with this filled in. Recast cannot see what you do there, so it does not say it was added.</p>${/^https:\/\//.test(m.placement?.receipt?.bridgeRef ?? "") ? `<p class="rg-hint">Did it not open, or open blank? Copy the address into a new tab:</p>${copyBox(m.placement!.receipt!.bridgeRef!, d.app)}` : ""}`,
          actions: `<button type="button" class="rg-btn" data-act="dismiss">Done</button>` };
        return { title: `${d ? `<span class="rg-dest done" aria-hidden="true">${svg(d.key, 16)}${checkIcon}</span>` : checkIcon}Added to ${esc(where)}`, head: "", facts: "",
        body: `${m.placement?.message ? `<p class="rg-error" role="alert">${esc(m.placement.message)}. It is still in ${esc(where)}.</p>` : ""}<p class="rg-hint">${esc(where)} confirmed it${d?.standIn ? " (stand-in)" : ""}.${m.placement?.undoable ? "" : " It cannot be undone from here."}</p>`,
        actions: `${m.placement?.undoable ? `<button type="button" class="rg-btn ghost" data-act="undo">Undo</button>` : ""}<button type="button" class="rg-btn" data-act="dismiss">Done</button>` };
      case "unknown": return { title: `${dIcon}No answer from ${esc(where)}`, head: "", facts: "",
        body: `${err}<p>${esc(m.placement?.message ?? "")}. It may or may not have been added. Recast does not send it again; it asks ${esc(where)} instead.</p>`,
        // Closing does not decide anything: the doubt is remembered, and placing it there again goes to this check.
        actions: `<button type="button" class="rg-btn" data-act="reconcile">Check ${esc(where)}</button><button type="button" class="rg-btn ghost" data-act="dismiss">Check later</button>` };
      case "failed": return { title: "Not added", head: close, facts: "", body: `<p>${esc(m.placement?.message ?? m.text ?? "")}</p>`, actions: `<button type="button" class="rg-btn" data-act="dismiss">Close</button>` };
    }
  }

  let shown = { title: "", head: "", facts: "", body: "", actions: "" };
  function copyBox(url: string, app: string) {
    return `<div class="rg-answer"><input class="rg-url" readonly value="${esc(url)}" aria-label="${esc(app)} address"><button type="button" class="rg-btn small ghost" data-copy="${esc(url)}">Copy</button></div>`;
  }
  function update(m: ModuleModel, extra: { error?: string } = {}) {
    if (m.mode !== "preview") blocked = null;
    const before = el.dataset["mode"]!; const prev = el.getBoundingClientRect();
    if (m.mode !== "choosing") drill = null;
    model = m; el.dataset["mode"] = m.mode; el.hidden = m.mode === "off";
    el.dataset["drill"] = drill ?? "";
    const t = opts.theme?.(); if (t) el.dataset["theme"] = t; else delete el.dataset["theme"];
    const c = content(m, extra.error);
    const focusKey = keyOf((el.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement | null);
    for (const k of ["title", "head", "facts", "body", "actions"] as const) {
      if (shown[k] === c[k]) continue;
      q({ title: ".rg-title", head: ".rg-head-actions", facts: ".rg-facts", body: ".rg-body", actions: ".rg-actions" }[k]).innerHTML = c[k];
    }
    shown = c;
    renderWheel();
    if (focusKey) el.querySelector<HTMLElement>(focusKey)?.focus();
    // One silhouette: the outline is revealed from its old shape to its new one. Layout takes the new size at once (so the
    // well, and the object in it, are where they will stay); only the clip and a slight lift animate.
    if (before !== m.mode && !el.hidden && !reduced() && prev.width && "animate" in el) {
      const next = el.getBoundingClientRect();
      const dx = Math.max(0, (next.width - prev.width) / 2), top = Math.max(0, next.height - prev.height);
      const r = before === "pill" || before === "off" ? prev.height / 2 : 26;
      if (dx + top > 2) el.animate([{ clipPath: `inset(${top}px ${dx}px 0 ${dx}px round ${r}px)` }, { clipPath: "inset(0 0 0 0 round 26px)" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
      if (before === "off") el.animate([{ opacity: 0, transform: "translateY(8px) scale(.94)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
      if (m.mode === "succeeded") el.animate([{ transform: "scale(.97)" }, { transform: "scale(1.012)" }, { transform: "none" }], { duration: 260, easing: "ease-out" });
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
    // A link (an open-and-prefill destination) is followed by the browser as usual; its click also records the placement.
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button, a[data-act]"); if (!b || b.disabled) return;
    if (b instanceof HTMLAnchorElement && b.dataset["act"] === "place") {
      // Opened here, from the person's click, so the result is known: a refused tab is reported, not called "opened".
      e.preventDefault();
      if (opts.openLink) { if (!opts.openLink(b.href)) { blocked = b.getAttribute("href"); update(model); return; } }
      else {
        const w = window.open(b.href, "_blank");
        if (!w) { blocked = b.getAttribute("href"); update(model); return; }
        try { w.opener = null; } catch { /* another origin already */ }
      }
      return emit({ type: "place" });
    }
    if (b.dataset["copy"] !== undefined) {
      const input = b.parentElement?.querySelector<HTMLInputElement>(".rg-url"); input?.select();
      const done = () => { b.textContent = "Copied"; };
      if (navigator.clipboard) navigator.clipboard.writeText(b.dataset["copy"]!).then(done, () => { if (document.execCommand?.("copy")) done(); });
      else if (document.execCommand?.("copy")) done();
      return;
    }
    if (b.dataset["answer"]) return emit({ type: "answer", field: b.dataset["answer"] as AnswerField, value: b.dataset["value"]! });
    if (b.dataset["submit"]) return submit(b.dataset["submit"]);
    if (b.dataset["choose"]) return emit({ type: "choose", field: b.dataset["choose"] as EventField, ingredientId: b.dataset["ingredient"]! });
    if (b.dataset["remove"]) return emit({ type: "remove", ingredientId: b.dataset["remove"] });
    if (b.dataset["recipe"]) return emit({ type: "openRecipe", recipeId: b.dataset["recipe"] });
    if (b.dataset["undoStep"]) return emit({ type: "undoStep", stepId: b.dataset["undoStep"] });
    switch (b.dataset["act"]) {
      case "turnOff": return emit({ type: "turnOff" });
      case "reopen": return emit({ type: "reopen" });
      case "placeIt": return emit({ type: "placeIt" });
      case "takePage": return emit({ type: "takePage" });
      case "close": return emit({ type: "close" });
      case "back": if (drill) { drill = null; update(model); return; } return emit({ type: "back" });
      case "openWheel": return emit({ type: "openWheel" });
      case "open": return openSelected();
      case "inspect": return emit({ type: "inspect" });
      case "place": return emit({ type: "place" });
      case "undo": return emit({ type: "undo" });
      case "dismiss": return emit({ type: "dismiss" });
      case "reconcile": return emit({ type: "reconcile" });
      case "mergeYes": return emit({ type: "confirmMerge", yes: true });
      case "mergeNo": return emit({ type: "confirmMerge", yes: false });
      case "runRecipe": return emit({ type: "runRecipe" });
    }
  });
  el.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement; if (t.matches("input[data-step]")) emit({ type: "toggleStep", stepId: t.dataset["step"]! });
  });
  el.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.matches("input[data-field]")) { e.preventDefault(); submit(t.dataset["field"]!); }
  });
  function submit(field: string) { const i = el.querySelector<HTMLInputElement>(`input[data-field="${CSS.escape(field)}"]`); const v = i?.value.trim(); if (v) emit({ type: "answer", field: field as AnswerField, value: v }); }
  el.addEventListener("pointerdown", (e) => { if ((e.target as HTMLElement).closest("[data-act=hold], [data-act=holdRecipe]")) holdStart = performance.now(); });
  el.addEventListener("pointerup", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-act=hold]")) emit({ type: "place", heldMs: performance.now() - holdStart });
    else if (t.closest("[data-act=holdRecipe]")) emit({ type: "runRecipe", heldMs: performance.now() - holdStart });
  });

  return {
    el, update,
    well: () => { if (el.hidden || model.mode === "pill" || model.mode === "off" || model.mode === "confirm") return null; const r = q(".rg-well").getBoundingClientRect(); return r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; },
    // Focus goes where the next decision is: the wheel; else what is still needed; else the primary action. Never to
    // Cancel first, so a stray Enter cannot throw away a review.
    focus: () => { const t = el.querySelector<HTMLElement>(".rg-drum") ?? el.querySelector<HTMLElement>(".rg-needs button, .rg-needs input") ?? el.querySelector<HTMLElement>(".rg-actions button:not([disabled]):not(.ghost), .rg-actions a.rg-btn") ?? el.querySelector<HTMLElement>(".rg-actions button:not([disabled])") ?? el.querySelector<HTMLElement>("button"); t?.focus(); },
    destroy: () => { cancelAnimationFrame(wRaf); el.remove(); },
  };
}
export const HOLD_TO_CONFIRM_MS = HOLD_MS;

const checkIcon = '<svg class="rg-check" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

const rgba = (c: readonly number[]) => (c.length === 4 ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})` : `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
const vars = (t: (typeof GLASS_TOKENS)["light" | "dark"], x: { edge: string; edge2: string; line: string; sel: string; shadow: string; sheen: string; well: string }) =>
  `--g-tint: ${rgba(t.tint)}; --g-solid: ${rgba(t.solid)}; --g-ink: ${rgba(t.ink)}; --g-muted: ${rgba(t.muted)}; --g-accent: ${rgba(t.accent)}; --g-edge: ${x.edge}; --g-edge2: ${x.edge2}; --g-line: ${x.line}; --g-sel: ${x.sel}; --g-shadow: ${x.shadow}; --g-sheen: ${x.sheen}; --g-well: ${x.well};`;
const LIGHT = vars(GLASS_TOKENS.light, { edge: "rgba(255,255,255,.95)", edge2: "rgba(255,255,255,.25)", line: "rgba(60,40,20,.12)", sel: "rgba(255,255,255,.82)", shadow: "rgba(40,28,14,.18)", sheen: "rgba(255,255,255,.55)", well: "rgba(60,40,20,.05)" });
const DARK = vars(GLASS_TOKENS.dark, { edge: "rgba(255,255,255,.22)", edge2: "rgba(255,255,255,.04)", line: "rgba(255,255,255,.10)", sel: "rgba(255,255,255,.09)", shadow: "rgba(0,0,0,.55)", sheen: "rgba(255,255,255,.10)", well: "rgba(0,0,0,.22)" });

/** Styles for the instrument. Self-contained (a shadow root sees none of the page's styles), light and dark, with fallbacks. */
export const GLASS_CSS = `
.rg { ${LIGHT}
  position: fixed; z-index: 2147482990; left: 50%; bottom: var(--rg-bottom, 16px); translate: -50% 0;
  width: min(var(--rg-w, 380px), calc(100vw - 32px)); max-height: calc(100vh - var(--rg-bottom, 16px) - 24px); box-sizing: border-box;
  display: flex; flex-direction: column; overflow: hidden; border-radius: 26px; color: var(--g-ink); isolation: isolate;
  font: 400 14px/1.4 var(--rg-font, "Inter", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  /* Optical glass: a tint that is lighter at the top (light falls from above), a blur that keeps the backdrop's colour, a
     hairline rim that is bright along the top edge and fades round the sides, and two shadows (contact and ambient). */
  background: linear-gradient(180deg, color-mix(in srgb, var(--g-tint) 100%, white 6%), var(--g-tint) 42%, color-mix(in srgb, var(--g-tint) 100%, black 2%));
  -webkit-backdrop-filter: blur(22px) saturate(180%) brightness(1.04); backdrop-filter: blur(22px) saturate(180%) brightness(1.04);
  box-shadow: inset 0 1px 0 var(--g-edge), inset 0 -1px 0 var(--g-edge2), inset 0 0 0 0.5px var(--g-line),
    0 1px 1px rgba(0,0,0,.06), 0 6px 14px -4px var(--g-shadow), 0 26px 60px -18px var(--g-shadow);
  pointer-events: auto; -webkit-font-smoothing: antialiased; }
.rg[hidden] { display: none; }
.rg *, .rg *::before, .rg *::after { box-sizing: border-box; }
@media (prefers-color-scheme: dark) { .rg:not([data-theme="light"]) { ${DARK} } }
.rg[data-theme="dark"] { ${DARK} }
/* The specular highlight: a soft spot of light near the top, drifting toward the pointer. */
.rg-sheen { position: absolute; inset: 0; z-index: -1; pointer-events: none; border-radius: inherit;
  background: radial-gradient(120% 70% at var(--mx, 30%) calc(var(--my, 0%) - 40%), var(--g-sheen), transparent 55%);
  transition: background-position .3s; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .rg { background: var(--g-solid); } }
@media (prefers-reduced-transparency: reduce) { .rg { background: var(--g-solid); -webkit-backdrop-filter: none; backdrop-filter: none; } .rg-sheen { display: none; } }
@media (prefers-contrast: more) { .rg { background: var(--g-solid); border: 1px solid var(--g-ink); } .rg-sheen { display: none; } }

/* Sizes: one silhouette, several shapes. */
.rg[data-mode="pill"] { width: auto; max-width: calc(100vw - 32px); border-radius: 999px; }
.rg[data-mode="composed"] { --rg-w: 360px; }
.rg[data-mode="choosing"] { --rg-w: 470px; }
.rg[data-mode="preview"], .rg[data-mode="inspecting"] { --rg-w: 390px; }
.rg[data-mode="executing"], .rg[data-mode="undoing"], .rg[data-mode="succeeded"], .rg[data-mode="unknown"], .rg[data-mode="failed"] { --rg-w: 340px; }
.rg[data-mode="plan"], .rg[data-mode="running"], .rg[data-mode="ran"] { --rg-w: 400px; }
/* Recipes: under the one main action, quiet until wanted. */
.rg-recipes { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 2px; }
.rg-recipes-label { font-size: 11px; color: var(--g-muted); margin-right: 2px; }
.rg-recipe[disabled] { opacity: .55; cursor: not-allowed; }
.rg-why-line { flex-basis: 100%; font-size: 11px; color: var(--g-muted); }
.rg-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rg-steps li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 12px; background: var(--g-sel); box-shadow: inset 0 0 0 0.5px var(--g-line); }
.rg-steps li[data-status="blocked"], .rg-steps li[data-status="skipped"] { opacity: .7; }
.rg-step { flex: 1; min-width: 0; display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.rg-step input { margin-top: 3px; accent-color: var(--g-accent); }
.rg-step-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rg-step-label { font-weight: 600; font-size: 13px; }
.rg-step-where, .rg-step-uses, .rg-step-note { font-size: 11.5px; color: var(--g-muted); overflow-wrap: anywhere; }
.rg-step-why { font-size: 12px; color: var(--g-ink); }
.rg-step-status { flex: none; min-width: 64px; font-size: 11px; font-weight: 600; color: var(--g-muted); padding-top: 2px; }
.rg-step-status[data-status="done"] { color: var(--g-accent); }
.rg-step-status[data-status="failed"], .rg-step-status[data-status="unknown"] { color: var(--g-ink); }

.rg-head { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 8px 8px 0 16px; }
.rg[data-mode="pill"] .rg-head { min-height: 40px; padding: 4px 6px 4px 14px; }
.rg-mark { flex: none; width: 9px; height: 9px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--g-accent) 60%, white), var(--g-accent) 70%);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-accent) 18%, transparent); }
.rg-title { flex: 1; min-width: 0; margin: 0; font-weight: 600; font-size: 13px; letter-spacing: -.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 8px; }
.rg[data-mode="pill"] .rg-title { font-weight: 500; }
.rg-head-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.rg-kbd { font-family: inherit; font-size: 11px; font-weight: 500; color: var(--g-muted); padding: 3px 7px; border-radius: 7px; box-shadow: inset 0 0 0 0.5px var(--g-line), inset 0 -1px 0 var(--g-line); background: var(--g-sel); margin-right: 2px; }
.rg-x { width: 30px; height: 30px; border: 0; border-radius: 50%; display: grid; place-items: center; background: transparent; color: var(--g-muted); cursor: pointer; }
.rg-x:hover { background: var(--g-sel); color: var(--g-ink); }
.rg-pill-btn { border: 0; border-radius: 999px; padding: 6px 12px; background: var(--g-ink); color: var(--g-solid); font-family: inherit; font-weight: 600; font-size: 12px; line-height: 1; cursor: pointer; }
.rg-pill-btn.ghost { background: transparent; color: var(--g-ink); box-shadow: inset 0 0 0 1px var(--g-line); margin-left: 4px; }
.rg-pill-btn.ghost:hover { background: var(--g-sel); }
.rg :focus-visible { outline: 2px solid var(--g-accent); outline-offset: 2px; }

/* The stage: the object on the left (its well), and on the right whatever the instrument is doing with it. */
.rg-stage { display: none; gap: 12px; padding: 8px 12px 0; align-items: center; }
.rg-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.rg-well { height: 72px; border-radius: 22px; background: var(--g-well); box-shadow: inset 0 1px 3px rgba(0,0,0,.10), inset 0 0 0 0.5px var(--g-line), 0 1px 0 var(--g-edge2); }
.rg-facts { display: none; flex-wrap: wrap; justify-content: center; gap: 2px 0; font-size: 12px; color: var(--g-muted); text-align: center; }
.rg-facts span + span::before { content: "·"; margin: 0 6px; }
.rg-side { flex: none; }
.rg-side:empty { display: none; }
.rg:is([data-mode="composed"], [data-mode="choosing"], [data-mode="preview"], [data-mode="executing"], [data-mode="undoing"], [data-mode="succeeded"], [data-mode="unknown"], [data-mode="failed"], [data-mode="inspecting"], [data-mode="plan"], [data-mode="running"], [data-mode="ran"]) .rg-stage { display: flex; }
.rg:is([data-mode="preview"], [data-mode="inspecting"], [data-mode="executing"], [data-mode="undoing"], [data-mode="succeeded"], [data-mode="unknown"], [data-mode="failed"]) .rg-well { height: 60px; }
.rg[data-mode="choosing"] .rg-facts { display: flex; }
.rg[data-mode="choosing"] .rg-left { align-self: center; }
.rg[data-mode="choosing"] .rg-well { height: 96px; border-radius: 28px; }
.rg[data-mode="composed"] .rg-stage { padding-bottom: 2px; }
.rg[data-mode="composed"] .rg-head { padding-top: 6px; }

.rg-body { padding: 0 16px; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.rg-body:not(:empty) { padding-top: 10px; }
.rg-body p { margin: 0; }
.rg-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px 14px; }
.rg-actions:empty { display: none; }
.rg-btn { display: inline-flex; align-items: center; gap: 8px; border: 0; text-decoration: none; border-radius: 999px; padding: 9px 16px; background: var(--g-ink); color: var(--g-solid); font-family: inherit; font-weight: 600; font-size: 13px; line-height: 1.1; cursor: pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 1px 2px rgba(0,0,0,.2); }
.rg-btn.primary { box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 0 0 1.5px var(--g-accent), 0 2px 8px color-mix(in srgb, var(--g-accent) 30%, transparent); }
.rg-btn.ghost { background: transparent; color: var(--g-ink); box-shadow: inset 0 0 0 1px var(--g-line); }
.rg-btn.small { padding: 6px 12px; }
.rg-btn[disabled] { opacity: .45; cursor: not-allowed; }
.rg-btn kbd, .rg-enter { font-family: inherit; font-weight: 600; font-size: 11px; line-height: 1; padding: 3px 5px; border-radius: 5px; background: color-mix(in srgb, currentColor 16%, transparent); }
/* The resting capsule's one affordance: a glass button that says where it goes next. */
.rg-go { flex: 1; display: inline-flex; align-items: center; justify-content: space-between; gap: 10px; border: 0; border-radius: 999px; padding: 10px 14px 10px 16px; cursor: pointer;
  background: var(--g-ink); color: var(--g-solid); font-family: inherit; font-weight: 600; font-size: 13px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 0 0 1.5px var(--g-accent), 0 4px 14px color-mix(in srgb, var(--g-accent) 28%, transparent); }
.rg[data-mode="composed"] .rg-actions { padding-top: 10px; }
.rg-hint { font-size: 12px; color: var(--g-muted); }
.rg-note, .rg-risk { font-size: 12px; color: var(--g-muted); }
.rg-error { font-size: 13px; color: var(--g-ink); padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--g-accent) 14%, transparent); }
.rg-dest { flex: none; position: relative; width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: var(--g-sel); box-shadow: inset 0 0 0 0.5px var(--g-line), inset 0 1px 0 var(--g-edge); }
.rg-dest.done { color: var(--g-ink); }
.rg-dest .rg-check { position: absolute; right: -5px; bottom: -5px; width: 14px; height: 14px; padding: 1px; border-radius: 50%; background: var(--g-accent); color: #fff; }

/* The wheel: a short cylinder of destinations behind a fixed glass lens. The lens has an ember rim on its leading edge. */
.rg-drum { position: relative; width: 210px; border-radius: 20px; outline: none; touch-action: none; perspective: 620px; overflow: hidden;
  background: linear-gradient(180deg, color-mix(in srgb, var(--g-ink) 6%, transparent), transparent 30%, transparent 70%, color-mix(in srgb, var(--g-ink) 6%, transparent));
  box-shadow: inset 0 0 0 0.5px var(--g-line), inset 0 8px 14px -10px rgba(0,0,0,.18), inset 0 -8px 14px -10px rgba(0,0,0,.18); }
.rg-drum:focus-visible { outline: 1.5px solid color-mix(in srgb, var(--g-accent) 75%, transparent); outline-offset: 3px; }
.rg-lens { position: absolute; left: 6px; right: 6px; top: 50%; height: ${ROW}px; margin-top: -${ROW / 2}px; border-radius: 14px; z-index: 0;
  background: var(--g-sel); box-shadow: inset 0 1px 0 var(--g-edge), inset 0 0 0 0.5px var(--g-line), 0 4px 12px -4px var(--g-shadow); }
.rg-lens::before { content: ""; position: absolute; left: -1px; top: 10px; bottom: 10px; width: 3px; border-radius: 3px; background: var(--g-accent); box-shadow: 0 0 8px color-mix(in srgb, var(--g-accent) 60%, transparent); }
.rg-lens.tick { animation: rg-tick 160ms ease-out; }
@keyframes rg-tick { 40% { box-shadow: inset 0 1px 0 var(--g-edge), inset 0 0 0 1px color-mix(in srgb, var(--g-accent) 55%, transparent), 0 4px 12px -4px var(--g-shadow); } }
.rg-cyl { position: absolute; inset: 0; transform-style: preserve-3d; transform: translateZ(-${RADIUS.toFixed(1)}px); z-index: 1; }
.rg-opt { position: absolute; left: 6px; right: 6px; top: 50%; height: ${ROW}px; margin-top: -${ROW / 2}px; display: flex; align-items: center; gap: 12px; padding: 0 12px 0 14px;
  cursor: pointer; backface-visibility: hidden; -webkit-backface-visibility: hidden; color: var(--g-ink); }
.rg-opt .rg-ico { flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; background: color-mix(in srgb, var(--g-ink) 7%, transparent); box-shadow: inset 0 0 0 0.5px var(--g-line); }
.rg-opt.on .rg-ico { background: var(--g-ink); color: var(--g-solid); box-shadow: inset 0 1px 0 rgba(255,255,255,.22), 0 0 0 1.5px var(--g-accent); }
.rg-opt.off .rg-ico { background: transparent; color: var(--g-muted); }
.rg-opt.on.tick .rg-ico { animation: rg-firm 160ms ease-out; }
@keyframes rg-firm { 50% { transform: scale(1.06); } }
.rg-name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rg-label { font-weight: 600; font-size: 14px; letter-spacing: -.005em; }
.rg-opt:not(.on) .rg-label { font-weight: 500; }
.rg-opt.off .rg-label { text-decoration: line-through; text-decoration-thickness: 1px; text-decoration-color: var(--g-muted); color: var(--g-muted); }
.rg-sub { font-size: 11px; color: var(--g-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rg-enter { visibility: hidden; }
.rg-opt.on:not(.off) .rg-enter { visibility: visible; }
.rg-reason { min-height: 34px; font-size: 12px; color: var(--g-muted); }
.rg-reason.nudge { animation: rg-nudge 240ms ease-out; }
@keyframes rg-nudge { 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
/* Review */
.rg-fields { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.rg-row { display: grid; grid-template-columns: 72px 1fr; gap: 8px; }
.rg-row dt { color: var(--g-muted); font-size: 12px; }
.rg-row dd { margin: 0; min-width: 0; overflow-wrap: anywhere; white-space: pre-line; }
.rg-origin { font-size: 10.5px; color: var(--g-muted); border: 0.5px solid var(--g-line); border-radius: 999px; padding: 0 6px; white-space: nowrap; }
.rg-needs { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: 16px; background: color-mix(in srgb, var(--g-accent) 9%, transparent); box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--g-accent) 40%, transparent); }
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
.rg-num { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace; font-size: 10.5px; }
.rg-link { grid-column: 3; grid-row: 1 / span 2; border: 0; background: none; color: var(--g-ink); text-decoration: underline; cursor: pointer; font-family: inherit; font-size: 12px; }
.rg-check { color: var(--g-accent); stroke-dasharray: 20; stroke-dashoffset: 0; animation: rg-check 280ms ease-out; }
@keyframes rg-check { from { stroke-dashoffset: 20; } }
@media (max-width: 520px) {
  .rg:not([data-mode="pill"]) { left: 16px; right: 16px; width: auto; translate: none; }
  .rg[data-mode="choosing"] .rg-stage { flex-direction: column; align-items: stretch; }
  .rg[data-mode="choosing"] .rg-left { align-self: stretch; }
  .rg[data-mode="choosing"] .rg-well { height: 72px; }
  .rg[data-mode="choosing"] .rg-drum { width: 100%; height: 168px !important; }
}
@media (prefers-reduced-motion: reduce) { .rg-check, .rg-reason.nudge, .rg-lens.tick, .rg-opt.on.tick .rg-ico { animation: none; } .rg-sheen { transition: none; } }
`;
