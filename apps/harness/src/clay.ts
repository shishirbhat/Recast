// The clay page: turn Recast on, pick pieces off pages in different tabs, press them together into one object, choose where
// it goes in the glass module (or carry it to a calendar), review, place.
// Runs the real core (clumps, compose, propose, plan, consent, commit, undo), the real state machine, the bridge registry's
// contracts, the clay renderer and the glass module.
// The "browser" (tabs and pages) and the destinations are stand-ins inside this page; the browser extension does the same
// across real tabs (apps/extension).
import { commit, verify as coreVerify, InMemoryEventLog, newClump, canMerge, OutcomeUnknownError, pieceOfSelection, undo as coreUndo } from "@recast/core";
import type { Bridge, CapabilityContract, Fragment, Operation, Receipt, Verification } from "@recast/core";
import { CONTRACTS, REGISTRY } from "@recast/bridges/src/contracts";
import { googleMapsDirections, LinkBridge, linkFor } from "@recast/bridges/src/links";
import { commandEvents, createControlTrigger, doubtNote, escapeEvent, initialClumpState, moduleModel, reduceClump, viewOf, type ClumpEffect, type ClumpEvent, type ClumpInput, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
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
// local stand-in, never Google. So are the Docs tab (Google Docs' contract) and the issues on the Build tab (GitHub's). Tasks are in the registry but not connected here.
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
// Google Maps is not a stand-in: it opens the real Google Maps with directions (open and prefill; nothing is written).
const DESTS: DestinationSpec[] = [{ id: "cal", label: "Calendar", contract: calendarContract, slots: slots(), standIn: true }, { id: "mail", label: "Mail", contract: draftsContract, standIn: true }, { id: "docs", label: "Docs", contract: CONTRACTS.googleDocs, standIn: true }, { id: "issues", label: "Issues", contract: CONTRACTS.githubIssue, standIn: true }, { id: "gmaps", label: "Google Maps", contract: CONTRACTS.googleMaps }];
// The review's link opens the map from the person's own click; this bridge only records what was opened.
const maps = new LinkBridge(googleMapsDirections);

class StandIn implements Bridge {
  readonly entries = new Map<string, Record<string, string>>();
  // Test controls, one per way a real destination misbehaves (all off by default):
  /** It writes, then the answer is lost. Recast must then reconcile, not retry. */
  silent = false;
  /** It refuses before writing anything. */
  refuse = false;
  /** Undo is refused: the entry stays. */
  undoFails = false;
  /** Hold every answer until released, to act while a write or undo is in flight. */
  gate: Promise<void> | null = null;
  /** Someone edits the entry right after it is written (its title changes), so the read-back has something to catch. */
  drift = false;
  constructor(private contract: CapabilityContract, private onChange: () => void) {}
  describe() { return this.contract; }
  async execute(op: Operation) {
    await sleep(reducedMotion() ? 50 : 420); if (this.gate) await this.gate;
    if (this.refuse) throw new Error(`${this.contract.app} refused it; nothing was added`);
    // Keyed by the operation id (derived from the content), so the same operation written twice is one entry: the
    // stand-in is idempotent the way a provider with a client-chosen id is.
    const ref = `${this.contract.targetKind.toLowerCase()}-${op.opId}`;
    this.entries.set(ref, Object.fromEntries(op.dataMoved.map((d) => [d.path.split(".")[1]!, d.value])));
    if (this.drift) { const e = this.entries.get(ref)!; if (e["title"]) e["title"] = `${e["title"]} (edited)`; }
    this.onChange();
    if (this.silent) throw new OutcomeUnknownError(`${this.contract.app} did not answer in time`, ref);
    return { ref };
  }
  /** Read the entry back and compare every moved field with the plan: what a destination's read-back does. */
  async verify(r: Receipt, op: Operation): Promise<Verification> {
    await sleep(reducedMotion() ? 20 : 180);
    const e = this.entries.get(r.bridgeRef ?? "");
    const fields = op.dataMoved.map((d) => { const actual = e ? (e[d.path.split(".")[1]!] ?? null) : null; return { path: d.path, expected: d.value, actual, match: actual === d.value }; });
    return { ok: !!e && fields.every((f) => f.match), at: new Date(NOW()).toISOString(), fields, ...(e ? {} : { note: `it is not in ${this.contract.app}` }) };
  }
  async undo(r: Receipt) {
    await sleep(reducedMotion() ? 20 : 200); if (this.gate) await this.gate;
    if (this.undoFails) throw new Error(`${this.contract.app} refused the delete`);
    this.entries.delete(r.bridgeRef ?? ""); this.onChange();
  }
}
const bridges: Record<string, StandIn> = { cal: new StandIn(calendarContract, () => renderDestinations()), mail: new StandIn(draftsContract, () => renderDestinations()), docs: new StandIn(CONTRACTS.googleDocs, () => renderDestinations()), issues: new StandIn(CONTRACTS.githubIssue, () => renderDestinations()) };
const log = new InMemoryEventLog();

// ---- state ------------------------------------------------------------------------------------------------------
let state: ClumpState = initialClumpState({ now: NOW(), timezone: TZ, destinations: DESTS });   // off until invoked
// The person's saved workflows, in this browser only: definitions (steps and destinations), checked as they are read.
const WF_KEY = "recast.workflows";
function storedWorkflows(): unknown[] { try { const v = JSON.parse(localStorage.getItem(WF_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
state = reduceClump(state, { type: "setWorkflows", items: storedWorkflows(), known: Object.values(CONTRACTS).map((c) => c.destination), now: NOW() }).state;
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
const SHORTCUT = MAC ? "⌃ ⌃" : "Ctrl Ctrl";            // to turn on
const OFF_KEY = MAC ? "⌃" : "Ctrl";                     // once, to turn off
const SHORTCUT_WORDS = MAC ? "press Control twice" : "press Ctrl twice";
const glass = createGlass($("#glass"), { onIntent: (i) => onIntent(i), onLayout: () => requestAnimationFrame(() => { renderPass(); }), reducedMotion, shortcut: OFF_KEY, linkFor: (op) => linkFor(op.proposal.destination.destination)?.url(op), theme: () => (document.documentElement.dataset["theme"] as "light" | "dark" | undefined) });

function dispatch(e: ClumpInput) {
  const r = reduceClump(state, { ...e, now: NOW() } as ClumpEvent);
  if (!r.stale) lastError = r.error ?? "";   // a late answer for an earlier action is ignored, not shown
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
  if (["reopen", "openWheel", "pick", "inspect", "placeIt"].includes(i.type)) setTimeout(() => glass.focus(), 0);
}

async function perform(eff: ClumpEffect) {
  if (eff.type === "storeWorkflows") { try { localStorage.setItem(WF_KEY, JSON.stringify(eff.items)); } catch { lastError = "This browser would not keep the workflow; it lasts until the page is closed"; render(); } return; }
  const now = () => new Date(NOW()).toISOString();
  if (eff.destinationId === "gmaps") {
    if (eff.type !== "commit") return;   // nothing to check or undo: it was only opened
    try { const receipt = await commit(eff.op, eff.consent, { bridge: maps, log, now }); dispatch({ type: "committed", receipt, undoable: false }); }
    catch (e) { dispatch({ type: "commitFailed", opId: eff.op.opId, message: e instanceof Error ? e.message : String(e) }); }
    return;
  }
  const bridge = bridges[eff.destinationId]!;
  if (eff.type === "commit") {
    const opId = eff.op.opId;
    try { const receipt = await commit(eff.op, eff.consent, { bridge, log, now }); dispatch({ type: "committed", receipt, undoable: receipt.reversible }); }
    catch (e) {
      if (e instanceof OutcomeUnknownError) dispatch({ type: "outcomeUnknown", opId, message: e.message });
      else dispatch({ type: "commitFailed", opId, message: e instanceof Error ? e.message : String(e) });
    }
  } else if (eff.type === "reconcile") {
    // Ask the destination; never send the write again.
    const ref = `${bridge.describe().targetKind.toLowerCase()}-${eff.op.opId}`;
    await sleep(reducedMotion() ? 20 : 250);
    if (bridge.entries.has(ref)) {
      const receipt: Receipt = { receiptId: `rc-${eff.op.opId}`, opId: eff.op.opId, at: now(), status: "done", objectId: eff.op.proposal.object.id, destination: eff.op.proposal.destination.destination, relationId: eff.op.proposal.relationId, effect: eff.op.proposal.effect, reversible: eff.op.proposal.reversible, bridgeRef: ref };
      await log.append({ kind: "commit", at: receipt.at, receipt });
      dispatch({ type: "reconciled", opId: eff.op.opId, found: true, receipt });
    } else dispatch({ type: "reconciled", opId: eff.op.opId, found: false });
  } else if (eff.type === "verify") {
    // Read it back: "verified" is the destination's own answer, never the write's success.
    try { const verification = await coreVerify(eff.receipt, eff.op, { bridge, log, now }); dispatch({ type: "verified", opId: eff.op.opId, verification }); }
    catch (e) { dispatch({ type: "verified", opId: eff.op.opId, verification: { ok: false, at: now(), fields: [], note: e instanceof Error ? e.message : String(e) } }); }
  } else if (eff.type === "undo") {
    // Only a confirmed reversal is "undone"; anything else is reported as a failed undo, and the placement stands.
    try { await coreUndo(eff.receipt, { bridge, log, now }); dispatch({ type: "undone", opId: eff.receipt.opId }); }
    catch (e) { dispatch({ type: "undoFailed", opId: eff.receipt.opId, message: e instanceof Error ? e.message : String(e) }); }
  }
}

// ---- pieces on the pages -------------------------------------------------------------------------------------------
let captureSeq = 0;
function fragmentOf(el: HTMLElement): Fragment {
  const tab = el.closest<HTMLElement>("[data-tab]")!;
  const kind = el.dataset["kind"] as Fragment["kind"];
  const text = (el.dataset["text"] ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const value = { ...(el.dataset["name"] ? { name: el.dataset["name"] } : {}), ...(el.dataset["address"] ? { address: el.dataset["address"] } : {}), ...(el.dataset["email"] ? { email: el.dataset["email"] } : {}), ...(el.dataset["url"] ? { url: el.dataset["url"] } : {}) };
  return {
    id: `${el.id}-${++captureSeq}`, kind, text, confidence: Number(el.dataset["confidence"] ?? 0.9), ...(Object.keys(value).length ? { value } : {}),
    evidence: [{ locator: { kind: "css", value: `#${el.id}` }, excerpt: text }],
    source: { app: "browser", url: tab.dataset["url"]!, title: el.dataset["sourceTitle"] ?? tab.dataset["title"]! },
  };
}
const centreOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };

function capture(el: HTMLElement, carry: boolean) {
  const r = dispatch({ type: "capture", fragment: fragmentOf(el), carry });
  const id = r.captured ?? `obj-${state.seq}`; const c = centreOf(el);
  anchors.set(id, { ...c, until: performance.now() + (carry ? 0 : 60) });
  // A selection blob is used up: the selection becomes the object, and the blob goes.
  if (el === selBlob) { selBlob.remove(); selBlob = null; getSelection()?.removeAllRanges(); }
  else flash(el);
  render();
  return r;
}

// ---- phase two: any selected text is a piece -------------------------------------------------------------------------
// With Recast on, selecting text on a page shows a blob beside it: the selection, read as a time, a person (an email
// address), an error or text. The blob is a piece like the highlighted ones, so it is dragged, tapped onto the desk or
// picked up with the keyboard in exactly the same way.
let selBlob: HTMLElement | null = null; let selSeq = 0;
const SEL_MAX = 1000;
const SEL_GLYPH: Record<string, string> = { time: "◷", person: "●", error: "⚠", text: "❝", place: "⌖", page: "▤" };
// A reading Recast is less sure of says so on the blob ("Place?"), before anything is made from it.
const SEL_KIND: Record<string, string> = { time: "Time", person: "Person", error: "Error", text: "Text", place: "Place?", page: "Document", phone: "Phone", code: "Code" };
function selectionInPage(): { range: Range; text: string; tab: HTMLElement } | null {
  const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0); const node = range.commonAncestorContainer;
  const host = node instanceof Element ? node : node.parentElement;
  const tab = host?.closest<HTMLElement>("[data-tab]");
  if (!tab || tab.hidden || host!.closest(".sel-blob")) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  return text && text.length <= SEL_MAX ? { range, text, tab } : null;
}
function updateSelectionBlob() {
  if (selBlob && press?.el === selBlob) return;                       // being pressed: keep it where it is
  // Not while the module is open: the person is busy there, and the blob must never cover its buttons.
  const sel = state.armed && !state.carried && moduleClosed() ? selectionInPage() : null;
  if (!sel) { if (selBlob) { selBlob.remove(); selBlob = null; } return; }
  if (!selBlob || selBlob.dataset["text"] !== sel.text || !sel.tab.contains(selBlob)) {
    selBlob?.remove();
    const { kind, value, confidence } = pieceOfSelection(sel.text, { now: new Date(NOW()).toISOString(), timezone: TZ });
    const b = document.createElement("span");
    b.className = "grab sel-blob"; b.id = `sel-${++selSeq}`; b.tabIndex = 0; b.setAttribute("role", "button");
    b.dataset["kind"] = kind; b.dataset["text"] = sel.text; if (value?.email) b.dataset["email"] = value.email;
    if (value?.name) b.dataset["name"] = value.name; if (value?.address) b.dataset["address"] = value.address; if (value?.url) b.dataset["url"] = value.url; if (confidence) b.dataset["confidence"] = String(confidence);
    const short = sel.text.length > 42 ? `${sel.text.slice(0, 40)}…` : sel.text;
    b.innerHTML = `<span class="sel-glyph" aria-hidden="true">${SEL_GLYPH[kind] ?? "❝"}</span><span class="sel-text">${esc(short)}</span><span class="sel-kind">${SEL_KIND[kind] ?? "Text"}</span>`;
    b.setAttribute("aria-label", `Selected text: ${sel.text.slice(0, 120)}, ${(SEL_KIND[kind] ?? "text").toLowerCase()}. Enter to pick up`);
    // Pressing the blob must not clear the selection it stands for.
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); startPiecePress(b, e); });
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    sel.tab.appendChild(b); selBlob = b;
  }
  // Beside the end of the selection, kept on screen.
  const rects = [...sel.range.getClientRects()]; const end = rects.at(-1) ?? sel.range.getBoundingClientRect();
  const w = selBlob.offsetWidth || 160;
  selBlob.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, end.right + 6))}px`;
  selBlob.style.top = `${Math.max(8, Math.min(innerHeight - 48, end.bottom + 6))}px`;
}
let selFrame = 0;
document.addEventListener("selectionchange", () => { if (!selFrame) selFrame = requestAnimationFrame(() => { selFrame = 0; updateSelectionBlob(); }); });
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
function render() { renderModule(); renderPass(); renderPass(); updateSelectionBlob(); renderGuide(); }

// ---- the guide: four steps, offered from the demo line, each ticked off as the person does it --------------------------------
let placedOnce = false;
function renderGuide() {
  const g = document.querySelector<HTMLOListElement>("#guide"); if (!g) return;
  if (state.phase === "succeeded" || state.run?.steps.some((x) => x.status === "done")) placedOnce = true;
  const done: Record<string, boolean> = {
    on: state.armed || placedOnce,
    press: Object.values(state.objects).some((o) => o.ingredients.length >= 2) || placedOnce,
    choose: ["previewing", "executing", "succeeded", "planning", "running", "ran"].includes(state.phase) || placedOnce,
    place: placedOnce,
  };
  let now = false;
  for (const li of g.querySelectorAll<HTMLElement>("li")) {
    const k = li.dataset["step"]!; li.dataset["state"] = done[k] ? "done" : now ? "" : "now"; if (!done[k]) now = true;
  }
}
$("#guide-open").addEventListener("click", (e) => {
  const g = $("#guide"); g.hidden = !g.hidden; (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!g.hidden));
  (e.currentTarget as HTMLElement).textContent = g.hidden ? "Show me how" : "Hide the steps"; renderGuide();
});   // the module first (it decides the well), then labels, then positions
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
  trig.querySelector(".trigger-kbd")!.textContent = state.armed ? OFF_KEY : SHORTCUT;
  trig.setAttribute("aria-description", state.armed ? "Or press Control once to turn it off" : "Or press Control twice");
  for (const el of $$(".grab")) { el.tabIndex = state.armed ? 0 : -1; if (state.armed) el.setAttribute("role", "button"); else el.removeAttribute("role"); }
  $("#desk-empty").textContent = state.armed
    ? `Press ${OFF_KEY === "⌃" ? "Control" : "Ctrl"} once to turn Recast off. Drag a highlighted name, place or time onto another to press them into one object, or select any text and drag the blob that appears. On a phone, press and hold first. Hold an object over a tab to switch tabs. Keyboard: Tab to a piece, Enter to pick it up.`
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
    items.push({ id, x: spot.x, y: spot.y, label: v.label, ...(id === inWell && glass.el.dataset["mode"] === "choosing" && innerWidth > 520 ? { compact: true } : {}), ...(id === inWell ? {} : doubtNote(state, id) ? { detail: doubtNote(state, id)! } : v.type !== "Fragment" ? { detail: v.summary.join(" · ") } : { detail: v.summary[0]! }), count: state.objects[id]!.ingredients.length, kind: kindOf(id), mode: carried ? "carried" : targetMode ?? "rest", proposed: v.proposed, focused: false });
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
  const show = state.last && ["placed", "undone", "refused", "removed", "discarded"].includes(state.last.kind) && NOW() - state.last.at < 6000 && moduleClosed();
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
  $("#docs-list").innerHTML = [...bridges["docs"]!.entries.values()].map((e) => `<li data-placed="doc"><strong>${esc(e["title"] ?? "")}</strong><span class="doc-body">${esc(e["body"] ?? "")}</span></li>`).join("") || `<li class="none">No documents yet</li>`;
  $("#issues-list").innerHTML = [...bridges["issues"]!.entries.values()].map((e) => `<li data-placed="issue"><strong>${esc(e["title"] ?? "")}</strong><span class="doc-body">${esc(e["body"] ?? "")}</span></li>`).join("") || `<li class="none">No issues yet</li>`;
}

// ---- tabs ----------------------------------------------------------------------------------------------------------
function showTab(name: string) {
  for (const b of $$("[role=tab]")) { const on = b.dataset["for"] === name; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if (on) b.scrollIntoView({ block: "nearest", inline: "nearest" }); }
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
    const id = r.captured ?? `obj-${state.seq}`; anchors.set(id, { ...centreOf(el), until: performance.now() + 900 });
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
// The Control key, from anywhere on the page: twice to turn Recast on, once to turn it off. Control used in a shortcut
// (Ctrl+C), held, or with a click never counts. Off is refused (and ignored) while a write is in progress.
const trigger = createControlTrigger();
const onTrigger = (r: "on" | "off" | null) => { if (r === "on") invoke(true); else if (r === "off") dispatch({ type: "disarm" }); };
addEventListener("keydown", (e) => onTrigger(trigger({ type: "keydown", key: e.key, repeat: e.repeat, at: e.timeStamp }, state.armed)), true);
addEventListener("keyup", (e) => onTrigger(trigger({ type: "keyup", key: e.key, at: e.timeStamp }, state.armed)), true);
addEventListener("pointerdown", (e) => { trigger({ type: "pointerdown", at: e.timeStamp }, state.armed); }, true);
addEventListener("blur", (e) => { trigger({ type: "blur", at: e.timeStamp }, state.armed); });
document.addEventListener("visibilitychange", (e) => { trigger({ type: "blur", at: e.timeStamp }, state.armed); });   // switching tabs forgets a half-press
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
if (!document.documentElement.lang) document.documentElement.lang = "en";   // when hosted inside a page skeleton without one
// The tab strip scrolls sideways when the tabs do not fit (phones); fades mark the side with more tabs.
const tabStrip = $(".tabs");
const tabEdges = () => { tabStrip.classList.toggle("more-left", tabStrip.scrollLeft > 2); tabStrip.classList.toggle("more-right", tabStrip.scrollLeft + tabStrip.clientWidth < tabStrip.scrollWidth - 2); };
tabStrip.addEventListener("scroll", tabEdges, { passive: true }); addEventListener("resize", tabEdges); tabEdges();
for (const el of $$(".grab")) {
  el.tabIndex = 0; el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${el.textContent!.trim()}, ${el.dataset["kind"]}. Enter to pick up`);
  el.addEventListener("pointerdown", (e) => startPiecePress(el, e));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
for (const b of $$("[role=tab]")) b.addEventListener("click", () => { if (!state.carried) showTab(b.dataset["for"]!); });
$("#recast-trigger").addEventListener("click", (e) => invoke((e as PointerEvent).detail === 0));
$<HTMLInputElement>("#silent").addEventListener("change", (e) => { bridges["cal"]!.silent = (e.target as HTMLInputElement).checked; });
$<HTMLInputElement>("#drift").addEventListener("change", (e) => { bridges["cal"]!.drift = (e.target as HTMLInputElement).checked; });
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
