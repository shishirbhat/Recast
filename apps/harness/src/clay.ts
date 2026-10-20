// The clay page: pick pieces off pages in different tabs, press them together into one object, carry it to a calendar.
// Runs the real core (clumps, compose, propose, plan, consent, commit, undo), the real state machine and the clay renderer.
// The "browser" (tabs and pages) and the destinations are stand-ins inside this page; the browser extension does the same
// across real tabs (apps/extension).
import { commit, InMemoryEventLog, newClump, canMerge, OutcomeUnknownError, undo as coreUndo } from "@recast/core";
import type { Bridge, CapabilityContract, Fragment, Operation, Receipt } from "@recast/core";
import { initialClumpState, reduceClump, viewOf, type ClumpEffect, type ClumpEvent, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
import { CLAY_CSS, createClay, type ClayItem } from "@recast/overlay/src/clay";

const params = new URLSearchParams(location.search);
const NOW = () => (params.get("now") ? Date.parse(params.get("now")!) : Date.now());
const TZ = params.get("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const reducedMotion = () => params.get("motion") === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

// ---- destinations: what each one accepts, and an in-page stand-in that really changes what you see ----------------
const calendarContract: CapabilityContract = { destination: "calendar.week", app: "Calendar", targetKind: "Calendar", reliability: "official-api", accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title", "Event.start", "Event.end", "Event.location", "Event.timezone", "Event.description"] }] };
const draftsContract: CapabilityContract = { destination: "mail.drafts", app: "Mail", targetKind: "Drafts", reliability: "official-api", accepts: [{ relationId: "message-draft-entry", effect: "Save as draft", dataMoved: ["Message.to", "Message.snippet"] }] };

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
const DESTS: DestinationSpec[] = [{ id: "cal", label: "Calendar", contract: calendarContract, slots: slots() }, { id: "mail", label: "Mail drafts", contract: draftsContract }];

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
let state: ClumpState = initialClumpState({ now: NOW(), timezone: TZ, destinations: DESTS });
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

/** The event without its clock reading, for every member of the union (plain Omit would collapse the union). */
type Input = ClumpEvent extends infer E ? (E extends ClumpEvent ? Omit<E, "now"> : never) : never;
function dispatch(e: Input) {
  const r = reduceClump(state, { ...e, now: NOW() } as ClumpEvent);
  lastError = r.error ?? "";
  const before = state; state = r.state;
  if (state.phase === "merging" && before.phase !== "merging") {
    const m = state.merging!;
    void clay.fuse(m.id, m.incomingId).then(() => { dispatch({ type: "settled" }); });
  }
  for (const eff of r.effects) void perform(eff);
  render();
  return r;
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
    source: { app: "browser", url: tab.dataset["url"]!, title: tab.dataset["title"]! },
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
  for (const id of state.desk) {
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

function render() { renderPass(); renderPass(); }   // labels first, then positions by their new widths
function renderPass() {
  const spots = deskSpots(); const t = performance.now();
  const items: ClayItem[] = [];
  const carriedPos = carriedPosition();
  for (const id of [...state.desk, ...(state.carried ? [state.carried] : [])]) {
    const v = viewOf(state, id); const carried = id === state.carried;
    const a = anchors.get(id); let spot = carried ? carriedPos : (a && a.until > t ? a : spots.get(id)!);
    // Attraction: a target that would accept the carried object leans toward it, so the two surfaces start to join.
    if (!carried && state.carried && state.target?.kind === "object" && state.target.id === id && state.verdict?.ok && !reducedMotion()) {
      const dx = carriedPos.x - spot.x, dy = carriedPos.y - spot.y, d = Math.hypot(dx, dy) || 1, pull = Math.min(14, d * 0.25);
      spot = { x: spot.x + (dx / d) * pull, y: spot.y + (dy / d) * pull };
    }
    if (a && a.until <= t) anchors.delete(id);
    const targetMode = state.target?.kind === "object" && state.target.id === id ? (state.verdict?.ok ? "accepts" : "refuses") : null;
    items.push({ id, x: spot.x, y: spot.y, label: v.label, ...(v.type !== "Fragment" ? { detail: v.summary.join(" · ") } : { detail: v.summary[0]! }), count: state.objects[id]!.ingredients.length, kind: kindOf(id), mode: carried ? "carried" : targetMode ?? "rest", proposed: v.proposed, focused: false });
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
  renderHint(); renderSheet(); renderToast();
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

// ---- hint, sheets, toast -----------------------------------------------------------------------------------------
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
const FIELD_LABEL: Record<string, string> = { title: "Title", start: "When", end: "Ends", allDay: "All day", timezone: "Time zone", location: "Where", description: "Notes", to: "To", snippet: "Message", subject: "Subject" };
const INPUT_HINT: Record<string, string> = { start: "2026-10-23T19:30", end: "2026-10-23T21:00", title: "Dinner with Maya", to: "maya@example.com" };
const fmt = (field: string, v: unknown) => {
  if (Array.isArray(v)) return v.join(", ");
  if ((field === "start" || field === "end") && typeof v === "string") { const d = new Date(v.length === 10 ? `${v}T00:00` : v); return isNaN(+d) ? v : d.toLocaleString("en", { weekday: "short", day: "numeric", month: "short", ...(v.length > 10 ? { hour: "numeric", minute: "2-digit" } : {}) }); }
  return String(v);
};
const ORIGIN: Record<string, string> = { extracted: "from the page", inferred: "Recast's reading", default: "a default", user: "you" };

function objectDetail(id: string): string {
  const v = viewOf(state, id); const c = state.objects[id]!;
  const fields = v.event?.fields ?? v.message?.fields ?? {};
  const rows = Object.entries(fields).map(([k, f]) => `<div class="row"><dt>${FIELD_LABEL[k] ?? k}</dt><dd>${esc(fmt(k, f!.value))} <span class="origin">${ORIGIN[f!.origin] ?? f!.origin}</span></dd></div>`).join("");
  const missing = v.missing.map((m) => {
    const sug = (m.suggestions ?? []).map((s) => `<button type="button" class="chip-btn" data-answer="${m.field}" data-value="${esc(s)}">Use “${esc(s)}”</button>`).join("");
    const inputId = `in-${id}-${m.field}`;
    return `<div class="missing"><label for="${inputId}">${FIELD_LABEL[m.field] ?? m.field}</label><p class="why">${esc(m.reason)}</p>${sug}<div class="answer"><input id="${inputId}" data-field="${m.field}" placeholder="${INPUT_HINT[m.field] ?? ""}" autocomplete="off"><button type="button" class="btn small" data-submit="${m.field}">Set</button></div></div>`;
  }).join("");
  const conflicts = v.conflicts.map((cf) => `<div class="missing"><p class="why">${FIELD_LABEL[cf.field] ?? cf.field}: the pieces disagree. Which one is right?</p>${cf.options.map((o) => `<button type="button" class="chip-btn" data-choose="${cf.field}" data-ingredient="${o.fragmentId}">${esc(o.original)}</button>`).join("")}</div>`).join("");
  const ingredients = c.ingredients.map((f) => `<li><span class="kind">${f.kind}</span><span class="what">${esc(f.text)}</span><span class="src">from ${esc(f.source?.title ?? "")}</span>${c.ingredients.length > 1 ? `<button type="button" class="link" data-remove="${f.id}" aria-label="Take ${esc(f.text)} out">Take out</button>` : ""}</li>`).join("");
  const assumptions = v.assumptions.length ? `<ul class="assume">${v.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : "";
  return `${rows ? `<dl class="fields">${rows}</dl>` : ""}${missing || conflicts ? `<div class="needs"><h3>Still needed</h3>${conflicts}${missing}</div>` : ""}${assumptions}<h3>Made from</h3><ul class="ingredients">${ingredients}</ul>`;
}

function renderSheet() {
  const sheet = $("#sheet"); const body = $("#sheet-body"); const title = $("#sheet-title"); const actions = $("#sheet-actions");
  let html = "", heading = "", buttons = "";
  if (state.phase === "inspecting" && state.inspecting) {
    const v = viewOf(state, state.inspecting);
    heading = v.label + (v.proposed ? " (proposed)" : "");
    html = objectDetail(state.inspecting);
    buttons = `<button type="button" class="btn" data-act="pickup">Pick up</button><button type="button" class="btn ghost" data-act="close">Done</button>`;
  } else if (state.phase === "confirmingMerge" && state.pendingMerge) {
    heading = "Combine them?"; html = `<p>Pressing these together ${esc(state.pendingMerge.reason)}. Placing it will then add an event instead of saving a message.</p>`;
    buttons = `<button type="button" class="btn" data-act="merge-yes">Combine</button><button type="button" class="btn ghost" data-act="merge-no">Keep apart</button>`;
  } else if (["previewing", "executing", "succeeded", "failed", "unknown"].includes(state.phase) && state.placement) {
    const p = state.placement; const d = DESTS.find((x) => x.id === p.destinationId)!; const v = viewOf(state, p.objectId);
    heading = state.phase === "previewing" ? `Add to ${d.label}?` : state.phase === "executing" ? `Adding to ${d.label}…` : state.phase === "succeeded" ? `Added to ${d.label}` : state.phase === "unknown" ? "No answer from the calendar" : "Not added";
    html = `<p class="lead">${esc(v.label)}</p>${objectDetail(p.objectId)}`;
    if (p.op) html += `<p class="risk">${p.op.risk.tier === "low" ? "Low risk: adds an entry only you can see, and it can be undone." : esc(p.op.risk.reasons.join("; "))}</p>`;
    if (state.phase === "previewing") buttons = p.op ? (p.op.risk.consent === "hold" ? `<button type="button" class="btn hold" data-act="hold">Press and hold to ${d.contract.accepts[0]!.effect.toLowerCase()}</button>` : `<button type="button" class="btn" data-act="place">${esc(d.contract.accepts[0]!.effect)}</button>`) + `<button type="button" class="btn ghost" data-act="cancel">Not now</button>` : `<button type="button" class="btn" disabled>Answer what is still needed</button><button type="button" class="btn ghost" data-act="cancel">Not now</button>`;
    if (state.phase === "succeeded") buttons = `${p.undoable ? `<button type="button" class="btn ghost" data-act="undo">Undo</button>` : ""}<button type="button" class="btn" data-act="dismiss">Done</button>`;
    if (state.phase === "unknown") { html = `<p>${esc(p.message ?? "")}. It may or may not have been added. Recast does not send it again; it asks the calendar instead.</p>`; buttons = `<button type="button" class="btn" data-act="reconcile">Check the calendar</button>`; }
    if (state.phase === "failed") { html = `<p>${esc(p.message ?? "")}</p>`; buttons = `<button type="button" class="btn" data-act="dismiss">Close</button>`; }
  }
  const open = !!heading;
  if (open && (sheet.hidden || title.textContent !== heading || body.dataset["html"] !== html || actions.dataset["html"] !== buttons)) {
    const focusId = (document.activeElement as HTMLElement | null)?.id;
    title.textContent = heading; body.innerHTML = html; body.dataset["html"] = html; actions.innerHTML = buttons; actions.dataset["html"] = buttons;
    const wasHidden = sheet.hidden; sheet.hidden = false;
    if (focusId && document.getElementById(focusId)) document.getElementById(focusId)!.focus();
    else if (wasHidden) ($("button:not([disabled])", actions) ?? title).focus();
  }
  if (!open && !sheet.hidden) { sheet.hidden = true; }
}

function renderToast() {
  const t = $("#toast");
  const show = state.last && ["placed", "undone", "refused", "removed"].includes(state.last.kind) && NOW() - state.last.at < 6000 && sheetClosed();
  t.hidden = !show; if (show) t.textContent = state.last!.text;
}
const sheetClosed = () => $("#sheet").hidden;

function renderDestinations() {
  const cal = bridges["cal"]!;
  for (const el of $$("[data-dest='cal'][data-slot]")) {
    const slot = DESTS[0]!.slots!.find((s) => s.id === el.dataset["slot"])!;
    const here = [...cal.entries.values()].filter((e) => e["start"] === slot.start);
    $(".slot-events", el).innerHTML = here.map((e) => `<span class="placed" data-placed="event">${esc(e["title"] ?? "")}${e["location"] ? ` · ${esc(e["location"].split(",")[0]!)}` : ""}</span>`).join("");
  }
  const other = [...cal.entries.values()].filter((e) => !DESTS[0]!.slots!.some((s) => s.start === e["start"]));
  $("#cal-other").innerHTML = other.map((e) => `<li data-placed="event">${esc(e["title"] ?? "")} · ${esc(fmt("start", e["start"]))}${e["location"] ? ` · ${esc(e["location"])}` : ""}</li>`).join("");
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
  if (state.carried) return;
  mode = "pointer"; pointer = { x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" };
  press = { kind: "piece", el, x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType !== "mouse", started: false };
  // On touch, a long press lifts (so the page can still scroll); with a mouse, moving a few pixels does.
  if (press.touch) press.timer = window.setTimeout(() => { if (press && !press.started) begin(); }, LONG_PRESS_MS);
}
function startObjectPress(id: string, e: PointerEvent) {
  if (state.carried || state.phase === "merging" || state.phase === "executing") return;
  e.preventDefault(); mode = "pointer"; pointer = { x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" };
  press = { kind: "object", id, x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType !== "mouse", started: false };
}
function begin() {
  if (!press) return; press.started = true; navigator.vibrate?.(8);
  if (press.kind === "piece") capture(press.el!, true);
  else { if (state.phase !== "idle" && state.phase !== "inspecting" && state.phase !== "succeeded" && state.phase !== "failed") dispatch({ type: "cancel" }); dispatch({ type: "pickUp", id: press.id! }); }
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
addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement;
  if (e.key === "Escape") {
    if (state.carried || !sheetClosed()) { e.preventDefault(); pageTarget = null; dispatch({ type: state.phase === "confirmingMerge" ? "confirmMerge" : "cancel", ...(state.phase === "confirmingMerge" ? { yes: false } : {}) } as never); }
    return;
  }
  if (el.matches("input, textarea")) { if (e.key === "Enter" && el.dataset["field"]) { e.preventDefault(); submitAnswer(el.dataset["field"]!); } return; }
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
function afterKeyboardDrop() { mode = "pointer"; setTimeout(() => { const first = $("#sheet:not([hidden]) button:not([disabled])"); (first ?? clay.label(state.desk.at(-1) ?? "") ?? document.body).focus?.(); }, 30); }
function moveTab(el: HTMLElement, dir: number, select = false) {
  const tabs = $$("[role=tab]"); const i = (tabs.indexOf(el) + dir + tabs.length) % tabs.length; const next = tabs[i]!;
  if (select || state.carried) showTab(next.dataset["for"]!); next.focus();
}

// ---- sheet actions ----------------------------------------------------------------------------------------------
function submitAnswer(field: string) {
  const id = state.placement?.objectId ?? state.inspecting; if (!id) return;
  const input = document.getElementById(`in-${id}-${field}`) as HTMLInputElement | null; if (!input?.value.trim()) return;
  dispatch({ type: "answer", objectId: id, field: field as never, value: input.value.trim() });
}
let holdStart = 0;
$("#sheet").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button"); if (!b) return;
  const id = state.placement?.objectId ?? state.inspecting;
  if (b.dataset["answer"] && id) dispatch({ type: "answer", objectId: id, field: b.dataset["answer"] as never, value: b.dataset["value"]! });
  else if (b.dataset["submit"]) submitAnswer(b.dataset["submit"]);
  else if (b.dataset["choose"] && id) dispatch({ type: "choose", objectId: id, field: b.dataset["choose"] as never, ingredientId: b.dataset["ingredient"]! });
  else if (b.dataset["remove"] && id) dispatch({ type: "remove", objectId: id, ingredientId: b.dataset["remove"] });
  else switch (b.dataset["act"]) {
    case "close": dispatch({ type: "inspect", id: null }); break;
    case "pickup": { const i = state.inspecting!; dispatch({ type: "pickUp", id: i }); mode = "keyboard"; pointer = { x: innerWidth / 2, y: innerHeight / 2, touch: false }; render(); setTimeout(() => clay.label(i)?.blur(), 0); break; }
    case "merge-yes": dispatch({ type: "confirmMerge", yes: true }); break;
    case "merge-no": dispatch({ type: "confirmMerge", yes: false }); break;
    case "place": dispatch({ type: "place", consent: { kind: "confirm" } }); break;
    case "cancel": dispatch({ type: "cancel" }); break;
    case "undo": dispatch({ type: "undo" }); break;
    case "dismiss": dispatch({ type: "dismiss" }); break;
    case "reconcile": dispatch({ type: "reconcile" }); break;
  }
});
$("#sheet").addEventListener("pointerdown", (e) => { if ((e.target as HTMLElement).closest("[data-act=hold]")) holdStart = performance.now(); });
$("#sheet").addEventListener("pointerup", (e) => { if ((e.target as HTMLElement).closest("[data-act=hold]")) dispatch({ type: "place", consent: { kind: "hold", heldMs: performance.now() - holdStart } }); });

// ---- wiring --------------------------------------------------------------------------------------------------------
for (const el of $$(".grab")) {
  el.tabIndex = 0; el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${el.textContent!.trim()}, ${el.dataset["kind"]}. Enter to pick up`);
  el.addEventListener("pointerdown", (e) => startPiecePress(el, e));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
for (const b of $$("[role=tab]")) b.addEventListener("click", () => { if (!state.carried) showTab(b.dataset["for"]!); });
$<HTMLInputElement>("#silent").addEventListener("change", (e) => { bridges["cal"]!.silent = (e.target as HTMLInputElement).checked; });
addEventListener("resize", () => render()); addEventListener("scroll", () => render(), { passive: true, capture: true });
const style = document.createElement("style"); style.textContent = CLAY_CSS; document.head.appendChild(style);
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
