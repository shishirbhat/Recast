import { commit, resolve, undo, InMemoryEventLog } from "@recast/core";
import type { Bridge, CapabilityContract, Operation, Receipt, SemanticObject } from "@recast/core";
import { initialState, reduce, selectView } from "@recast/interaction";
import type { Candidate, Destination, Effect, Event, State } from "@recast/interaction";
import { mountOverlay } from "@recast/overlay";
import { classifyElement, extractPage } from "@recast/extract-web";
import type { Candidate as RawCandidate } from "@recast/core";

// ---- destination contracts (what each window says it can accept) -------------------------------------------
const contracts: Record<string, CapabilityContract> = {
  calendar: { destination: "google-calendar.event-editor", app: "Google Calendar", targetKind: "Event", reliability: "official-api",
    accepts: [
      { relationId: "person-event-attendee", effect: "Add attendee", effectFlags: ["notifies-third-party"], dataMoved: ["Person.name", "Person.email"] },
      { relationId: "location-event-location", effect: "Set location", dataMoved: ["Location.name", "Location.address"] }] },
  mail: { destination: "mail.compose-send", app: "Mail", targetKind: "Message", reliability: "structured-interface", accepts: [{ relationId: "person-message-recipient", effect: "Send to person", effectFlags: ["send"], dataMoved: ["Person.email"] }] },
  tasks: { destination: "tasks.task", app: "Tasks", targetKind: "Task", reliability: "deep-link", accepts: [{ relationId: "document-task-reference", effect: "Attach reference", dataMoved: ["Document.title", "Document.url"] }] },
};

/** A real destination: placing changes the page you can see, and undo puts it back. */
class DomBridge implements Bridge {
  constructor(private key: string) {}
  describe() { return contracts[this.key]!; }
  async execute(op: Operation) {
    const v = (p: string) => op.dataMoved.find((d) => d.path === p)?.value ?? "";
    const id = `placed-${Math.random().toString(36).slice(2, 8)}`;
    if (this.key === "calendar" && op.proposal.relationId === "person-event-attendee") {
      const li = document.createElement("li"); li.id = id; li.dataset["placed"] = "attendee"; li.textContent = `${v("Person.name")} <${v("Person.email")}>`;
      document.getElementById("attendees")!.appendChild(li);
    } else if (this.key === "calendar") {
      const el = document.getElementById("location")!; el.dataset["before"] = el.textContent ?? ""; el.dataset["placed"] = id; el.textContent = v("Location.name") || v("Location.address");
    } else if (this.key === "mail") {
      const li = document.createElement("li"); li.id = id; li.dataset["placed"] = "recipient"; li.textContent = v("Person.email");
      document.getElementById("to")!.appendChild(li);
    }
    return { ref: id };
  }
  async undo(r: Receipt) {
    const el = document.getElementById(r.bridgeRef ?? "");
    if (el) { el.remove(); return; }
    const loc = document.getElementById("location")!;
    if (loc.dataset["placed"] === r.bridgeRef) { loc.textContent = loc.dataset["before"] ?? ""; delete loc.dataset["placed"]; }
  }
}
const bridges: Record<string, DomBridge> = { calendar: new DomBridge("calendar"), mail: new DomBridge("mail"), tasks: new DomBridge("tasks") };

// ---- host: connects the pure engine to the page --------------------------------------------------------------
const params = new URLSearchParams(location.search);
const LIFT_KEY = params.get("liftKey") ?? "Alt";
if (params.get("theme")) document.documentElement.dataset["theme"] = params.get("theme")!;

let state: State = initialState(performance.now());
const eventLog = new InMemoryEventLog();
const marks: Record<string, number> = {};
let shift = false;

const overlay = mountOverlay({ onUndo: () => dispatch({ type: "undoRequest", now: performance.now() }) });
if (params.get("theme")) overlay.host.dataset["theme"] = params.get("theme")!;

const rectOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
const cssPathOf = (c: RawCandidate) => Object.values(c.fields)[0]!.evidence[0]!.locator.value;

// Structured data the page publishes (Layer 1). When the pointer is on an element that evidences one of these
// objects, that object is lifted: it carries real confidence, so a low-risk placement can happen on release.
const structured = extractPage(document, { url: location.href, now: new Date().toISOString() }).objects;
function structuredAt(el: Element): { object: SemanticObject; unit: Element } | null {
  let best: { object: SemanticObject; unit: Element; conf: number } | null = null;
  for (const o of structured) for (const [k, meta] of Object.entries(o.fields)) for (const ev of meta.evidence) {
    if (ev.locator.kind !== "css") continue;
    const unit = document.querySelector(ev.locator.value);
    if (!unit || !(unit === el || unit.contains(el))) continue;
    const conf = Math.min(...Object.values(o.fields).map((f) => f.confidence));
    if (!best || conf > best.conf) best = { object: o, unit, conf };
    void k;
  }
  return best ? { object: best.object, unit: best.unit } : null;
}

/** What is liftable under a point? The element classifier decides; by default only confident readings count. */
function candidateAt(p: { x: number; y: number }, minConfidence: number): Candidate | null {
  const el = document.elementsFromPoint(p.x, p.y).find((e) => e.tagName !== "RECAST-OVERLAY" && e !== document.documentElement && e !== document.body && !e.closest("[data-destination]"));
  if (!el) return null;
  const s = structuredAt(el);
  if (s) return { id: `structured:${s.object.id}`, rect: rectOf(s.unit), object: s.object };
  const now = new Date().toISOString();
  const readings = classifyElement(el, { url: location.href, now })
    .filter((c) => Math.min(...Object.values(c.fields).map((f) => f.confidence)) >= minConfidence);
  const best = readings[0];
  if (!best) return null;
  let object: SemanticObject;
  try { object = resolve(best); } catch { return null; }
  const unit = document.querySelector(cssPathOf(best));
  return unit ? { id: cssPathOf(best), rect: rectOf(unit), object } : null;
}
function destinationAt(p: { x: number; y: number }): Destination | null {
  const el = document.elementsFromPoint(p.x, p.y).find((e) => e instanceof HTMLElement && e.dataset["destination"]) as HTMLElement | undefined;
  return el ? { id: el.dataset["destination"]!, label: el.dataset["label"]!, rect: rectOf(el), contract: contracts[el.dataset["destination"]!]! } : null;
}
function allCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const el of document.querySelectorAll("#source h3, #source address, #source .plain")) {
    const r = el.getBoundingClientRect();
    const c = candidateAt({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, shift ? 0.4 : 0.5);
    if (c && !out.some((o) => o.id === c.id)) out.push(c);
  }
  return out;
}

function run(effects: Effect[]) {
  for (const f of effects) {
    if (f.type === "hitTest") queueMicrotask(() => dispatch({ type: "hitResult", seq: f.seq, candidate: candidateAt(f.p, shift ? 0.4 : 0.5), destination: destinationAt(f.p), now: performance.now() }));
    else if (f.type === "enumerate") queueMicrotask(() => dispatch({ type: "enumerated", candidates: allCandidates(), destinations: [...document.querySelectorAll<HTMLElement>("[data-destination]")].map((el) => ({ id: el.dataset["destination"]!, label: el.dataset["label"]!, rect: rectOf(el), contract: contracts[el.dataset["destination"]!]! })), now: performance.now() }));
    else if (f.type === "commit") {
      const key = Object.keys(contracts).find((k) => contracts[k]!.destination === f.op.proposal.destination.destination)!;
      commit(f.op, f.consent, { bridge: bridges[key]!, log: eventLog, now: () => new Date().toISOString() })
        .then((receipt) => dispatch({ type: "committed", receipt, now: performance.now() }), (e: unknown) => dispatch({ type: "commitFailed", message: e instanceof Error ? e.message : String(e), now: performance.now() }));
    } else if (f.type === "undo") {
      const key = Object.keys(contracts).find((k) => contracts[k]!.destination === f.receipt.destination)!;
      undo(f.receipt, { bridge: bridges[key]!, log: eventLog, now: () => new Date().toISOString() })
        .then((receipt) => dispatch({ type: "undone", receipt, now: performance.now() }), (e: unknown) => dispatch({ type: "undoFailed", message: e instanceof Error ? e.message : String(e), now: performance.now() }));
    }
  }
}

// Two clocks, because they need different rates: a hold fill needs every frame; toast expiry needs about 4 a second.
let raf = 0, slow = 0;
function ensureTicking() {
  if (state.phase === "confirming" && state.hold.startedAt !== null && !raf) {
    const loop = () => { raf = 0; dispatch({ type: "tick", now: performance.now() }); if (state.phase === "confirming" && state.hold.startedAt !== null) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
  }
  if (state.toast && !slow) {
    slow = window.setInterval(() => { dispatch({ type: "tick", now: performance.now() }); if (!state.toast) { clearInterval(slow); slow = 0; } }, 250);
  }
}

function dispatch(e: Event) {
  const before = state.phase;
  const r = reduce(state, e);
  state = r.state;
  if (before !== "previewing" && state.phase === "previewing") marks["preview-start"] = performance.now();
  if (e.type === "pointerUp" || (e.type === "key" && e.key === "Enter" && e.down)) marks["release"] = performance.now();
  overlay.update(selectView(state));
  run(r.effects);
  ensureTicking();
}

// Latency marks: when the ghost and the toast are actually painted (next animation frame after they enter the DOM).
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) if (n instanceof HTMLElement) {
    const t = n.dataset["testid"];
    if (t === "ghost") requestAnimationFrame(() => { marks["ghost-painted"] = performance.now(); });
    if (t === "toast") requestAnimationFrame(() => { marks["toast-painted"] = performance.now(); });
  }
}).observe(overlay.host.shadowRoot!, { childList: true, subtree: true });

// ---- input ---------------------------------------------------------------------------------------------------
addEventListener("keydown", (ev) => {
  if (ev.key === "Shift") shift = true;
  if (ev.key === LIFT_KEY && !ev.repeat) { dispatch({ type: "liftKey", down: true, now: performance.now() }); return; }
  if (ev.key.toLowerCase() === "l" && ev.ctrlKey && ev.shiftKey) { ev.preventDefault(); dispatch({ type: "keyboardLift", now: performance.now() }); return; }
  if (state.phase !== "idle" && ["Tab", "Enter", "Escape"].includes(ev.key)) { ev.preventDefault(); if (ev.repeat) return; dispatch({ type: "key", key: ev.key, down: true, shift: ev.shiftKey, now: performance.now() }); }
});
addEventListener("keyup", (ev) => {
  if (ev.key === "Shift") shift = false;
  if (ev.key === LIFT_KEY) dispatch({ type: "liftKey", down: false, now: performance.now() });
  if (state.phase !== "idle" && ev.key === "Enter") dispatch({ type: "key", key: "Enter", down: false, now: performance.now() });
});
addEventListener("pointermove", (ev) => dispatch({ type: "pointerMove", p: { x: ev.clientX, y: ev.clientY }, now: performance.now() }), { passive: true });
addEventListener("pointerdown", (ev) => { if (state.phase !== "idle") ev.preventDefault(); dispatch({ type: "pointerDown", p: { x: ev.clientX, y: ev.clientY }, now: performance.now() }); }, true);
addEventListener("pointerup", (ev) => dispatch({ type: "pointerUp", p: { x: ev.clientX, y: ev.clientY }, now: performance.now() }), true);
addEventListener("blur", () => { if (state.phase !== "idle") dispatch({ type: "key", key: "Escape", down: true, now: performance.now() }); });

(globalThis as unknown as { __recast: unknown }).__recast = { state: () => state, marks, log: () => eventLog.entries() };
