// The clay page: turn Recast on, pick pieces off pages in different tabs, press them together into one object, choose where
// it goes in the glass module (or carry it to a calendar), review, place.
// Runs the real core (clumps, compose, propose, plan, consent, commit, undo), the real state machine, the bridge registry's
// contracts, the clay renderer and the glass module.
// The "browser" (tabs and pages) and the destinations are stand-ins inside this page; the browser extension does the same
// across real tabs (apps/extension).
import { commit, InMemoryEventLog, newClump, canMerge, OutcomeUnknownError, undo as coreUndo } from "@recast/core";
import type { Bridge, CapabilityContract, Fragment, Operation, Receipt } from "@recast/core";
import { CONTRACTS, REGISTRY } from "@recast/bridges/src/contracts";
import { commandEvents, createDoubleTap, escapeEvent, initialClumpState, moduleModel, reduceClump, viewOf, type ClumpEffect, type ClumpEvent, type ClumpInput, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
import { CLAY_CSS, createClay, type ClayItem } from "@recast/overlay/src/clay";
import { createGlass, GLASS_CSS, intentEvents, type GlassIntent } from "@recast/overlay/src/glass";

const params = new URLSearchParams(location.search);
const NOW = () => (params.get("now") ? Date.parse(params.get("now")!) : Date.now());
const TZ = params.get("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const reducedMotion = () => params.get("motion") === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

// ---- destinations: the registry's own contracts, performed by in-page stand-ins that really change what you see --------
// The calendar and the drafts are the Google Calendar and Gmail contracts from the bridge registry; what runs them here is a
// local stand-in, never Google. Tasks and Documents are in the registry but not connected on this page.
const calendarContract: CapabilityContract = CONTRACTS.googleCalendarEvent;
const draftsContract: CapabilityContract = CONTRACTS.gmailMessageDraft;

/** Next Friday and Saturday evenings, in the person's own calendar days. */
function slots(): NonNullable<DestinationSpec["slots"]> {
  const now = new Date(NOW()); const out: NonNullable<DestinationSpec["slots"]> = [];
  for (const [dow, name] of [[5, "Fri"], [6, "Sat"]] as const) {
    const d = new Date(now); d.setDate(now.getDate() + ((dow - now.getDay() + 7) % 7 || 7));
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    for (const [hm, label] of [["19:30", "7:30 PM"], ["20:30", "8:30 PM"]] as const) out.push({ id: `${name.toLowerCase()}-${hm.replace(":", "")}`, label: `${name} ${d.getDate()}, ${label}`, start: `${ymd}T${hm}` });
  }
  return out;
}
const DESTS: DestinationSpec[] = [{ id: "cal", label: "Calendar", contract: calendarContract, slots: slots(), standIn: true }, { id: "mail", label: "Mail", contract: draftsContract, standIn: true }];

class StandIn implements Bridge {
  readonly entries = new Map<string, Record<string, string>>();
  /** Test control: the destination writes, then does not answer. Recast must then reconcile, not retry. */
  silent = false;
  constructor(private contract: CapabilityContract, private onChange: () => void) {}
  describe() { return this.contract; }
  async execute(op: Operation) {
    await sleep(reducedMotion() ? 50 : 420);
    const ref = `${this.contract.targetKind.toLowerCase()}-${op.opId}`;
    this.entries.set(ref, Object.fromEntries(op.dataMoved.map((d) => [d.path.split(".")[1]!, d.value])));
    this.onChange();
    if (this.silent) throw new OutcomeUnknownError(`${this.contract.app} did not answer in time`, ref);
    return { ref };
  }
  async undo(r: Receipt) { this.entries.delete(r.bridgeRef ?? ""); this.onChange(); }
}
const bridges: Record<string, StandIn> = { cal: new StandIn(calendarContract, () => renderDestinations()), mail: new StandIn(draftsContract, () => renderDestinations()) };
const log = new InMemoryEventLog();

// ---- state ------------------------------------------------------------------------------------------------------
let state: ClumpState = initialClumpState({ now: NOW(), timezone: TZ, destinations: DESTS });   // off until invoked
let mode: "pointer" | "keyboard" = "pointer";
let pointer = { x: 0, y: 0, touch: false };
/** Where an object should be drawn for a moment (where it was lifted from, or where it is being pressed into). */
const anchors = new Map<string, { x: number; y: number; until: number }>();
let pageTarget: HTMLElement | null = null;   // a piece on the page the carried object is over (pressing into it captures it first)
let lastError = "";

const clay = createClay($("#clay"), {
  reducedMotion,
  onPointerDown: (id, e) => startObjectPress(id, e),
});
// The trigger: press Control twice (Control on a Mac, Ctrl on Windows). The button in the bar does the same.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SHORTCUT = MAC ? "⌃ ⌃" : "Ctrl Ctrl";
const SHORTCUT_WORDS = MAC ? "press Control twice" : "press Ctrl twice";
const glass = createGlass($("#glass"), { onIntent: (i) => onIntent(i), onLayout: () => requestAnimationFrame(() => { renderPass(); }), reducedMotion, shortcut: SHORTCUT, theme: () => (document.documentElement.dataset["theme"] as "light" | "dark" | undefined) });

function dispatch(e: ClumpInput) {
  const r = reduceClump(state, { ...e, now: NOW() } as ClumpEvent);
  lastError = r.error ?? "";
  const before = state; state = r.state;
  if (state.phase === "merging" && before.phase !== "merging") {
    const m = state.merging!;
    void clay.fuse(m.id, m.incomingId).then(() => { dispatch({ type: "settled" }); if (mode === "keyboard" || (document.activeElement as HTMLElement | null)?.classList.contains("clay-item")) glass.focus(); });
  }
  for (const eff of r.effects) void perform(eff);
  render();
  return r;
}

// ---- the trigger and the module -----------------------------------------------------------------------------------
/** The one Recast command (the button in the bar, or Control twice): on; reopen the composition; off. Never a second module. */
function invoke(fromKeyboard: boolean) {
  const evs = commandEvents(state);
  for (const e of evs) dispatch(e);
  if (fromKeyboard && glass.well()) glass.focus();
}
function objectInModule(): string | null { return state.placement?.objectId ?? state.inspecting ?? state.focus; }
function closeModule() { for (const e of intentEvents({ type: "close" }, state)) dispatch(e); }
function onIntent(i: GlassIntent) {
  for (const e of intentEvents(i, state)) dispatch(e);
  // Keep the keyboard in the module as it changes shape.
  if (["reopen", "openWheel", "pick", "inspect"].includes(i.type)) setTimeout(() => glass.focus(), 0);
}

async function perform(eff: ClumpEffect) {
  const bridge = bridges[eff.destinationId]!; const now = () => new Date(NOW()).toISOString();
  if (eff.type === "commit") {
    try { const receipt = await commit(eff.op, eff.consent, { bridge, log, now }); dispatch({ type: "committed", receipt, undoable: receipt.reversible }); }
    catch (e) {
      if (e instanceof OutcomeUnknownError) dispatch({ type: "outcomeUnknown", message: e.message });
      else dispatch({ type: "commitFailed", message: e instanceof Error ? e.message : String(e) });
    }
  } else if (eff.type === "reconcile") {
    // Ask the destination; never send the write again.
    const ref = `${bridge.describe().targetKind.toLowerCase()}-${eff.op.opId}`;
    await sleep(reducedMotion() ? 20 : 250);
    if (bridge.entries.has(ref)) {
      const receipt: Receipt = { receiptId: `rc-${eff.op.opId}`, opId: eff.op.opId, at: now(), status: "done", objectId: eff.op.proposal.object.id, destination: eff.op.proposal.destination.destination, relationId: eff.op.proposal.relationId, effect: eff.op.proposal.effect, reversible: eff.op.proposal.reversible, bridgeRef: ref };
      await log.append({ kind: "commit", at: receipt.at, receipt });
      dispatch({ type: "reconciled", found: true, receipt });
    } else dispatch({ type: "reconciled", found: false });
  } else if (eff.type === "undo") {
    await coreUndo(eff.receipt, { bridge, log, now }); dispatch({ type: "undone" });
  }
}

// ---- pieces on the pages -------------------------------------------------------------------------------------------
let captureSeq = 0;
function fragmentOf(el: HTMLElement): Fragment {
  const tab = el.closest<HTMLElement>("[data-tab]")!;
  const kind = el.dataset["kind"] as Fragment["kind"];
  const text = (el.dataset["text"] ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const value = { ...(el.dataset["name"] ? { name: el.dataset["name"] } : {}), ...(el.dataset["address"] ? { address: el.dataset["address"] } : {}), ...(el.dataset["email"] ? { email: el.dataset["email"] } : {}) };
  return {
    id: `${el.id}-${++captureSeq}`, kind, text, confidence: 0.9, ...(Object.keys(value).length ? { value } : {}),
    evidence: [{ locator: { kind: "css", value: `#${el.id}` }, excerpt: text }],
    source: { app: "browser", url: tab.dataset["url"]!, title: el.dataset["sourceTitle"] ?? tab.dataset["title"]! },
  };
}
const centreOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };

function capture(el: HTMLElement, carry: boolean) {
  const r = dispatch({ type: "capture", fragment: fragmentOf(el), carry });
  const id = `obj-${state.seq}`; const c = centreOf(el);
  anchors.set(id, { ...c, until: performance.now() + (carry ? 0 : 60) });
  flash(el);
  render();
  return r;
}
function flash(el: HTMLElement) { el.classList.remove("lifted"); void el.offsetWidth; el.classList.add("lifted"); }

// ---- layout: where each object rests -----------------------------------------------------------------------------
function deskSpots(): Map<string, { x: number; y: number }> {
  // A flow layout by each object's drawn width, so a grown object pushes the others along instead of overlapping them.
  const desk = $("#desk-objects"); const r = desk.getBoundingClientRect(); const out = new Map<string, { x: number; y: number }>();
  let x = r.x, row = 0;
  for (const id of state.desk.filter((d) => d !== inWell)) {
    const w = Math.min(r.width, (clay.label(id)?.offsetWidth ?? 180) * 1.0);
    if (x > r.x && x + w > r.right) { x = r.x; row++; }
    out.set(id, { x: x + w / 2, y: r.y + 30 + row * 64 }); x += w + 14;
  }
  desk.style.minHeight = `${(row + 1) * 64 - 4}px`;
  return out;
}

function kindOf(id: string): ClayItem["kind"] {
  const v = viewOf(state, id); const f = state.objects[id]!.ingredients[0]!;
  if (v.type === "Event") return "event"; if (v.type === "Message") return "message"; if (v.type === "People") return "people";
  return f.kind;
}

let inWell: string | null = null;
function render() { renderModule(); renderPass(); renderPass(); }   // the module first (it decides the well), then labels, then positions
function renderModule() {
  glass.update(moduleModel(state, REGISTRY), lastError && !state.carried ? { error: lastError } : {});
  const deskH = $("#desk").offsetHeight;
  // Float just above the desk when there is room; on a short screen, over it.
  glass.el.style.setProperty("--rg-bottom", `${innerHeight - deskH > 560 ? deskH + 12 : 12}px`);
  const w = glass.well(); const id = objectInModule();
  const shown = state.carried && state.focus !== state.carried ? state.focus : id;
  inWell = w && shown && state.desk.includes(shown) && state.carried !== shown ? shown : null;
  document.body.classList.toggle("recast-on", state.armed);
  const trig = $("#recast-trigger"); trig.setAttribute("aria-pressed", String(state.armed)); trig.querySelector(".trigger-label")!.textContent = state.armed ? "Recast on" : "Recast";
  for (const el of $$(".grab")) { el.tabIndex = state.armed ? 0 : -1; if (state.armed) el.setAttribute("role", "button"); else el.removeAttribute("role"); }
  $("#desk-empty").textContent = state.armed
    ? "Drag a highlighted name, place or time onto another to press them into one object. On a phone, press and hold first. Hold an object over a tab to switch tabs. Keyboard: Tab to a piece, Enter to pick it up."
    : `Recast is off, so pages behave normally. Press Recast in the address bar, or ${SHORTCUT_WORDS}, to start picking things up.`;
}
function renderPass() {
  const spots = deskSpots(); const t = performance.now();
  const well = inWell ? glass.well() : null;
  const items: ClayItem[] = [];
  const carriedPos = carriedPosition();
  for (const id of [...state.desk, ...(state.carried ? [state.carried] : [])]) {
    const v = viewOf(state, id); const carried = id === state.carried;
    const a = anchors.get(id); let spot = carried ? carriedPos : id === inWell && well ? well : (a && a.until > t ? a : spots.get(id)!);
    // Attraction: a target that would accept the carried object leans toward it, so the two surfaces start to join.
    if (!carried && state.carried && state.target?.kind === "object" && state.target.id === id && state.verdict?.ok && !reducedMotion()) {
      const dx = carriedPos.x - spot.x, dy = carriedPos.y - spot.y, d = Math.hypot(dx, dy) || 1, pull = Math.min(14, d * 0.25);
      spot = { x: spot.x + (dx / d) * pull, y: spot.y + (dy / d) * pull };
    }
    if (a && a.until <= t) anchors.delete(id);
    const targetMode = state.target?.kind === "object" && state.target.id === id ? (state.verdict?.ok ? "accepts" : "refuses") : null;
    // In the module's well the facts are shown under it, so the object carries only its name.
    items.push({ id, x: spot.x, y: spot.y, label: v.label, ...(id === inWell && glass.el.dataset["mode"] === "choosing" && innerWidth > 520 ? { compact: true } : {}), ...(id === inWell ? {} : v.type !== "Fragment" ? { detail: v.summary.join(" · ") } : { detail: v.summary[0]! }), count: state.objects[id]!.ingredients.length, kind: kindOf(id), mode: carried ? "carried" : targetMode ?? "rest", proposed: v.proposed, focused: false });
  }
  clay.update(items);
  for (const it of items) { const el = clay.label(it.id)!; el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-description", it.mode === "carried" ? "in hand. Tab to a target, Enter to drop, Escape to put back" : "Enter to open, Space to pick up"); }
  if (anchors.size) setTimeout(renderPass, 80);

  // Targets on the page and destinations show what would happen.
  for (const el of $$(".grab")) { el.classList.toggle("accepts", el === pageTarget && pageVerdict(el).ok); el.classList.toggle("refuses", el === pageTarget && !pageVerdict(el).ok); }
  for (const el of $$("[data-dest]")) {
    const on = state.target?.kind === "destination" && state.target.id === el.dataset["dest"] && (state.target.slot ?? "") === (el.dataset["slot"] ?? "");
    el.classList.toggle("accepts", on && !!state.verdict?.ok); el.classList.toggle("refuses", on && !state.verdict?.ok);
  }
  document.body.classList.toggle("carrying", !!state.carried);
  $("#desk-empty").hidden = state.desk.length > 0 || !!state.carried;
  renderHint(); renderToast();
}

function carriedPosition() {
  if (mode === "keyboard") {
    const f = document.activeElement as HTMLElement | null;
    if (f && f !== document.body && !f.classList.contains("clay-item")) { const r = f.getBoundingClientRect(); return { x: Math.min(innerWidth - 100, Math.max(100, r.x + r.width / 2)), y: Math.max(40, r.y - 34) }; }
    const desk = $("#desk").getBoundingClientRect(); return { x: desk.x + desk.width / 2, y: desk.y - 30 };
  }
  return { x: pointer.x, y: pointer.y - (pointer.touch ? 64 : 0) };
}

function pageVerdict(el: HTMLElement): { ok: boolean; reason?: string; becomes?: string } {
  if (!state.carried) return { ok: false };
  const c = canMerge(newClump("page", fragmentOf(el)), state.objects[state.carried]!);
  return c.ok ? { ok: true, becomes: c.becomes } : { ok: false, reason: c.reason };
}

// ---- hint and toast -----------------------------------------------------------------------------------------
function renderHint() {
  const h = $("#hint"); let text = "";
  if (state.carried) {
    const v = viewOf(state, state.carried);
    if (pageTarget) { const pv = pageVerdict(pageTarget); text = pv.ok ? `Let go to press ${v.label} into ${pageTarget.textContent!.trim()}` : `Won't combine: ${pv.reason}`; }
    else if (state.target?.kind === "object") text = state.verdict?.ok ? `Let go to press it in${state.verdict.change ? ` (this turns the ${state.verdict.change.from.toLowerCase()} into an ${state.verdict.change.to.toLowerCase()})` : ""}` : `Won't combine: ${state.verdict?.reason ?? ""}`;
    else if (state.target?.kind === "destination") text = state.verdict?.ok ? "Let go to review it here. Nothing is added until you confirm." : `Not here: ${state.verdict?.reason ?? ""}`;
    else text = mode === "keyboard" ? `Carrying ${v.label}. Tab to another piece, an object, a tab or a calendar slot; Enter to drop; Escape to put it back.` : `Carrying ${v.label}. Drop it on another piece to combine, hover a tab to switch, or let go to put it down.`;
  } else text = state.last?.text ?? "";
  if (lastError && !state.carried) text = lastError.charAt(0).toUpperCase() + lastError.slice(1);
  h.textContent = text; h.hidden = !text;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (v: string) => { const d = new Date(v); return isNaN(+d) ? v : d.toLocaleString("en", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };

function renderToast() {
  const t = $("#toast");
  const show = state.last && ["placed", "undone", "refused", "removed"].includes(state.last.kind) && NOW() - state.last.at < 6000 && moduleClosed();
  t.hidden = !show; if (show) t.textContent = state.last!.text;
}
const moduleClosed = () => { const m = glass.el.dataset["mode"]; return m === "off" || m === "pill"; };

function renderDestinations() {
  const cal = bridges["cal"]!;
  for (const el of $$("[data-dest='cal'][data-slot]")) {
    const slot = DESTS[0]!.slots!.find((s) => s.id === el.dataset["slot"])!;
    const here = [...cal.entries.values()].filter((e) => e["start"] === slot.start);
    $(".slot-events", el).innerHTML = here.map((e) => `<span class="placed" data-placed="event">${esc(e["title"] ?? "")}${e["location"] ? ` · ${esc(e["location"].split(",")[0]!)}` : ""}</span>`).join("");
  }
  const other = [...cal.entries.values()].filter((e) => !DESTS[0]!.slots!.some((s) => s.start === e["start"]));
  $("#cal-other").innerHTML = other.map((e) => `<li data-placed="event">${esc(e["title"] ?? "")} · ${esc(fmt(e["start"] ?? ""))}${e["location"] ? ` · ${esc(e["location"])}` : ""}</li>`).join("");
  $("#cal-other-wrap").hidden = !other.length;
  $("#drafts-list").innerHTML = [...bridges["mail"]!.entries.values()].map((e) => `<li data-placed="draft"><strong>To ${esc(e["to"] ?? "")}</strong><span>${esc(e["snippet"] ?? "")}</span></li>`).join("") || `<li class="none">No drafts yet</li>`;
}

// ---- tabs ----------------------------------------------------------------------------------------------------------
function showTab(name: string) {
  for (const b of $$("[role=tab]")) { const on = b.dataset["for"] === name; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
  for (const p of $$("[data-tab]")) p.hidden = p.dataset["tab"] !== name;
  $("#address").textContent = $(`[data-tab='${name}']`).dataset["url"]!;
  pageTarget = null; render();
}

// ---- pointer and touch -----------------------------------------------------------------------------------------------
let press: { kind: "piece" | "object"; el?: HTMLElement; id?: string; x: number; y: number; t: number; touch: boolean; timer?: number; started: boolean } | null = null;
let tabHover: { el: HTMLElement; timer: number } | null = null;
const DRAG_PX = 6, LONG_PRESS_MS = 320, TAB_HOVER_MS = 450;

function startPiecePress(el: HTMLElement, e: PointerEvent) {
  if (state.carried || !state.armed) return;   // off: the page is just a page (text selection works as usual)
  mode = "pointer"; pointer = { x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" };
  press = { kind: "piece", el, x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType !== "mouse", started: false };
  // On touch, a long press lifts (so the page can still scroll); with a mouse, moving a few pixels does.
  if (press.touch) press.timer = window.setTimeout(() => { if (press && !press.started) begin(); }, LONG_PRESS_MS);
}
function startObjectPress(id: string, e: PointerEvent) {
  if (state.carried || !state.armed || state.phase === "merging" || state.phase === "executing" || state.phase === "unknown") return;
  e.preventDefault(); mode = "pointer"; pointer = { x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" };
  press = { kind: "object", id, x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType !== "mouse", started: false };
}
function begin() {
  if (!press) return; press.started = true; navigator.vibrate?.(8);
  if (press.kind === "piece") capture(press.el!, true);
  else { if (!["idle", "inspecting", "succeeded", "failed", "composed", "choosing"].includes(state.phase)) closeModule(); dispatch({ type: "pickUp", id: press.id! }); }
}
addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" };
  if (press && !press.started) {
    const far = Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX;
    if (far && (!press.touch || press.kind === "object")) begin();
    else if (far && press.touch && press.timer) { clearTimeout(press.timer); press = null; return; }   // a scroll, not a lift
  }
  if (state.carried && mode === "pointer") { hitTest(e.clientX, e.clientY); render(); }
}, { passive: true });
addEventListener("pointerup", (e) => {
  if (press && !press.started) {
    clearTimeout(press.timer);
    // A tap: a piece is picked up onto your desk; an object opens.
    if (press.kind === "piece") capture(press.el!, false);
    else if (press.kind === "object") dispatch({ type: "inspect", id: press.id! });
    press = null; return;
  }
  press = null;
  if (state.carried && mode === "pointer") { hitTest(e.clientX, e.clientY); drop(); }
});
// Once something is lifted, the finger moves the object, not the page: stop the browser from turning the drag into a scroll
// (a scroll would cancel the pointer and drop the object).
addEventListener("touchmove", (e) => { if (state.carried || press?.started) e.preventDefault(); }, { passive: false });
addEventListener("pointercancel", () => { press = null; if (state.carried && mode === "pointer") { pageTarget = null; dispatch({ type: "approach", target: null }); dispatch({ type: "drop" }); } });

function hitTest(x: number, y: number) {
  const carried = state.carried!;
  // 1) another object
  let best: { id: string; d: number } | null = null;
  for (const id of state.desk) { const b = clay.box(id); if (!b) continue; const d = Math.hypot(b.x - x, b.y - (y - (pointer.touch ? 64 : 0))); if (d < Math.max(b.w / 2, 56) && (!best || d < best.d)) best = { id, d }; }
  const under = document.elementsFromPoint(x, pointer.touch ? y - 64 : y);
  const piece = under.find((el) => (el as HTMLElement).classList?.contains("grab")) as HTMLElement | undefined;
  const dest = under.find((el) => (el as HTMLElement).dataset?.["dest"]) as HTMLElement | undefined;
  const tab = (document.elementsFromPoint(x, y).find((el) => (el as HTMLElement).getAttribute?.("role") === "tab") as HTMLElement | undefined);
  pageTarget = null;
  let target: Target | null = null;
  if (best) target = { kind: "object", id: best.id };
  else if (piece && piece.offsetParent) { pageTarget = piece; }
  else if (dest) target = { kind: "destination", id: dest.dataset["dest"]!, ...(dest.dataset["slot"] ? { slot: dest.dataset["slot"] } : {}) };
  const same = JSON.stringify(target) === JSON.stringify(state.target);
  if (!same) dispatch({ type: "approach", target });
  // Spring-loaded tabs: hold the object over a tab to open it, without letting go.
  if (tab && tab.getAttribute("aria-selected") !== "true") {
    if (tabHover?.el !== tab) { if (tabHover) clearTimeout(tabHover.timer); tab.classList.add("springing"); tabHover = { el: tab, timer: window.setTimeout(() => { tab.classList.remove("springing"); showTab(tab.dataset["for"]!); tabHover = null; }, TAB_HOVER_MS) }; }
  } else if (tabHover) { clearTimeout(tabHover.timer); tabHover.el.classList.remove("springing"); tabHover = null; }
  void carried;
}

/** Let go. Over a piece on the page: that piece is captured and the carried object is pressed into it. */
function drop() {
  if (tabHover) { clearTimeout(tabHover.timer); tabHover.el.classList.remove("springing"); tabHover = null; }
  if (pageTarget) {
    const el = pageTarget; pageTarget = null;
    if (!pageVerdict(el).ok) { dispatch({ type: "approach", target: null }); dispatch({ type: "drop" }); lastError = `kept apart: ${pageVerdict(el).reason ?? ""}`; render(); return; }
    const carried = state.carried!;
    // Capture the page piece onto the desk under the pointer, then press the carried object into it.
    const r = reduceClump(state, { type: "capture", fragment: fragmentOf(el), carry: false, now: NOW() }); state = r.state;
    const id = `obj-${state.seq}`; anchors.set(id, { ...centreOf(el), until: performance.now() + 900 });
    flash(el); render();
    dispatch({ type: "approach", target: { kind: "object", id } }); dispatch({ type: "drop" });
    void carried; return;
  }
  dispatch({ type: "drop" });
}

// ---- keyboard ------------------------------------------------------------------------------------------------------
function targetOfElement(el: HTMLElement): { target: Target | null; piece?: HTMLElement; tab?: HTMLElement } {
  if (el.classList.contains("clay-item") && el.dataset["id"] !== state.carried) return { target: { kind: "object", id: el.dataset["id"]! } };
  if (el.classList.contains("grab")) return { target: null, piece: el };
  if (el.dataset["dest"]) return { target: { kind: "destination", id: el.dataset["dest"]!, ...(el.dataset["slot"] ? { slot: el.dataset["slot"] } : {}) } };
  if (el.getAttribute("role") === "tab") return { target: null, tab: el };
  return { target: null };
}
addEventListener("focusin", (e) => {
  const el = e.target as HTMLElement;
  if (state.carried && mode === "keyboard") { const t = targetOfElement(el); pageTarget = t.piece ?? null; if (JSON.stringify(t.target) !== JSON.stringify(state.target)) dispatch({ type: "approach", target: t.target }); else render(); }
});
// Control twice, from anywhere on the page. Control used in a shortcut (Ctrl+C), held, or with a click never counts.
const doubleTap = createDoubleTap();
addEventListener("keydown", (e) => { if (doubleTap({ type: "keydown", key: e.key, repeat: e.repeat, at: e.timeStamp })) invoke(true); }, true);
addEventListener("keyup", (e) => { if (doubleTap({ type: "keyup", key: e.key, at: e.timeStamp })) invoke(true); }, true);
addEventListener("pointerdown", (e) => { doubleTap({ type: "pointerdown", at: e.timeStamp }); }, true);
addEventListener("blur", (e) => { doubleTap({ type: "blur", at: e.timeStamp }); });
addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement;
  if (e.key === "Escape") {
    const ev = escapeEvent(state);
    if (ev) { e.preventDefault(); pageTarget = null; const wasModule = !moduleClosed(); dispatch(ev); if (wasModule && !moduleClosed()) glass.focus(); }
    return;
  }
  if (glass.el.contains(el) || el.id === "recast-trigger") return;   // the module and the trigger handle their own keys
  if (!state.armed) return;            // off: keys belong to the page
  if (el.matches("input, textarea")) return;
  const enter = e.key === "Enter", space = e.key === " ";
  if (!enter && !space) { if (state.carried && mode === "keyboard" && el.getAttribute("role") === "tab" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { e.preventDefault(); moveTab(el, e.key === "ArrowRight" ? 1 : -1); } else if (!state.carried && el.getAttribute("role") === "tab" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { e.preventDefault(); moveTab(el, e.key === "ArrowRight" ? 1 : -1, true); } return; }
  if (state.carried && mode === "keyboard") {
    e.preventDefault();
    const t = targetOfElement(el);
    if (t.tab) { showTab(t.tab.dataset["for"]!); t.tab.focus(); return; }
    if (t.piece) { pageTarget = t.piece; drop(); afterKeyboardDrop(); return; }
    dispatch({ type: "drop" }); afterKeyboardDrop(); return;
  }
  if (el.classList.contains("grab")) { e.preventDefault(); mode = "keyboard"; capture(el, true); return; }
  if (el.classList.contains("clay-item")) {
    e.preventDefault(); const id = el.dataset["id"]!;
    if (space) { mode = "keyboard"; if (state.phase === "inspecting") dispatch({ type: "inspect", id: null }); dispatch({ type: "pickUp", id }); }
    else dispatch({ type: "inspect", id });
  }
});
function afterKeyboardDrop() { mode = "pointer"; setTimeout(() => { if (!moduleClosed()) glass.focus(); else (clay.label(state.desk.at(-1) ?? "") ?? document.body).focus?.(); }, 30); }
function moveTab(el: HTMLElement, dir: number, select = false) {
  const tabs = $$("[role=tab]"); const i = (tabs.indexOf(el) + dir + tabs.length) % tabs.length; const next = tabs[i]!;
  if (select || state.carried) showTab(next.dataset["for"]!); next.focus();
}

// ---- wiring --------------------------------------------------------------------------------------------------------
for (const el of $$(".grab")) {
  el.tabIndex = 0; el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${el.textContent!.trim()}, ${el.dataset["kind"]}. Enter to pick up`);
  el.addEventListener("pointerdown", (e) => startPiecePress(el, e));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
for (const b of $$("[role=tab]")) b.addEventListener("click", () => { if (!state.carried) showTab(b.dataset["for"]!); });
$("#recast-trigger").addEventListener("click", (e) => invoke((e as PointerEvent).detail === 0));
$(".trigger-kbd").textContent = SHORTCUT;
$<HTMLInputElement>("#silent").addEventListener("change", (e) => { bridges["cal"]!.silent = (e.target as HTMLInputElement).checked; });
addEventListener("resize", () => render()); addEventListener("scroll", () => render(), { passive: true, capture: true });
const style = document.createElement("style"); style.textContent = CLAY_CSS + GLASS_CSS; document.head.appendChild(style);
function renderCalendarGrid() {
  const byDay = new Map<string, NonNullable<DestinationSpec["slots"]>>();
  for (const sl of DESTS[0]!.slots!) { const day = sl.label.split(",")[0]!; byDay.set(day, [...(byDay.get(day) ?? []), sl]); }
  $("#cal-grid").innerHTML = [...byDay].map(([day, list]) => `<div class="day"><h2>${esc(day)}</h2>${list.map((sl) => `<div class="drop slot" data-dest="cal" data-slot="${sl.id}" tabindex="0" role="button" aria-label="Calendar, ${esc(sl.label)}"><span class="slot-label">${esc(sl.label.split(", ")[1]!)}</span><span class="slot-events"></span></div>`).join("")}</div>`).join("");
}
renderCalendarGrid();
document.documentElement.style.setProperty("--desk-h", `${$("#desk").offsetHeight}px`);
new ResizeObserver(() => { document.documentElement.style.setProperty("--desk-h", `${$("#desk").offsetHeight}px`); render(); }).observe($("#desk"));
showTab(params.get("tab") ?? "profile"); renderDestinations(); render();
setInterval(() => { if (state.last && NOW() - state.last.at < 7000) renderToast(); }, 1000);

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
// For tests and for the curious: the live state, read-only.
(window as unknown as { recast: unknown }).recast = { get state() { return state; }, bridges };
