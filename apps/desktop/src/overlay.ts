// The overlay: Recast on top of the app in front. A transparent page over the whole screen that draws only blobs and the
// wheel, and takes the mouse only where it draws (the app tells the window which rectangles those are). Turned on by the
// trigger key, it shows each grabbed selection as a blob where it was grabbed; click a blob and the wheel opens right
// beside it (choose a place, review, place); drag a blob onto another to press them together. Nothing else opens.
// The same clay objects, glass module and state machine as the browser and the try-it page.
import { commit, InMemoryEventLog, pieceOfSelection, type Fragment, type Receipt, type Verification } from "@recast/core";
import { CONTRACTS, REGISTRY } from "@recast/bridges/src/contracts";
import { appleMapsDirections, googleMapsDirections, LinkBridge, linkFor } from "@recast/bridges/src/links";
import { doubtNote, escapeEvent, initialClumpState, moduleModel, reduceClump, viewOf, type ClumpEffect, type ClumpEvent, type ClumpInput, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
import { CLAY_CSS, createClay, type ClayItem } from "@recast/overlay/src/clay";
import { createGlass, GLASS_CSS, intentEvents, type GlassIntent } from "@recast/overlay/src/glass";

interface Point { x: number; y: number }
interface Origin { app?: string; title?: string; url?: string }
interface Settings { trigger: string; platform: string; grabReady: boolean; listening: boolean }
interface SavedInbox { state: ClumpState; pos: Record<string, Point> }
interface OverlayApi {
  boot(): Promise<{ settings: Settings; inbox: SavedInbox | ClumpState | null; theme: "dark" | "light"; on: boolean; workflows?: unknown[]; presets?: unknown }>;
  saveWorkflows(items: unknown[]): Promise<boolean>;
  savePresets(p: unknown): Promise<boolean>;
  status(): Promise<Record<string, unknown>>;
  act(route: "commit" | "reconcile" | "undo" | "verify", body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  openExternal(url: string): Promise<boolean>;
  saveInbox(state: unknown): Promise<boolean>;
  interactive(over: boolean, rects: { x: number; y: number; width: number; height: number }[], own: { x: number; y: number; width: number; height: number }[]): Promise<boolean>;
  off(): Promise<boolean>;
  keys(want: boolean): Promise<boolean>;
  copy(text: string): Promise<boolean>;
  historyAdd(entry: unknown): Promise<boolean>;
  historyPlaced(ids: string[], where: string, link?: string): Promise<boolean>;
  historyUndone(ids: string[], where: string): Promise<boolean>;
  on(channel: string, fn: (v: any) => void): void;
}
const api = (window as unknown as { recastDesktop: OverlayApi }).recastDesktop;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MAC = navigator.userAgent.includes("Mac");

// ---- destinations: the person's connections, as the bridge registry's contracts --------------------------------------------
const LINK: Record<string, string> = { "link:google-calendar": "calendar", "link:gmail-drafts": "gmail", "link:google-tasks": "tasks", "link:google-tasks-due": "tasks", "link:google-docs": "docs", "link:github": "github", "link:linear": "linear", "link:outlook-calendar": "outlook", "link:todoist": "todoist", "link:todoist-due": "todoist", "link:outlook-mail": "outlook-mail", "link:mstodo": "mstodo", "link:mstodo-due": "mstodo", "link:notion": "notion", "link:webhook-event": "webhook", "link:webhook-page": "webhook", "link:webhook-note": "webhook" };
const MAPS: DestinationSpec[] = [{ id: "open:google-maps", label: "Google Maps", contract: CONTRACTS.googleMaps }, ...(MAC ? [{ id: "open:apple-maps", label: "Apple Maps", contract: CONTRACTS.appleMaps }] : [])];
async function destinations(): Promise<DestinationSpec[]> {
  const st = await api.status().catch(() => ({} as Record<string, unknown>));
  const out: DestinationSpec[] = [];
  if (st["connected"]) {
    out.push({ id: "link:google-calendar", label: "Google Calendar", contract: CONTRACTS.googleCalendarEvent });
    if (st["gmail"]) out.push({ id: "link:gmail-drafts", label: "Gmail drafts", contract: CONTRACTS.gmailMessageDraft });
    if (st["tasks"]) out.push({ id: "link:google-tasks", label: "Google Tasks", contract: CONTRACTS.googleTasks }, { id: "link:google-tasks-due", label: "Google Tasks", contract: CONTRACTS.googleTasksEntry });
    if (st["docs"]) out.push({ id: "link:google-docs", label: "Google Docs", contract: CONTRACTS.googleDocs });
  }
  if (typeof st["webhook"] === "string") { const n = st["webhook"]; out.push({ id: "link:webhook-event", label: n, contract: CONTRACTS.webhookEvent }, { id: "link:webhook-page", label: n, contract: CONTRACTS.webhookPage }, { id: "link:webhook-note", label: n, contract: CONTRACTS.webhookNote }); }
  if (typeof st["notion"] === "string") out.push({ id: "link:notion", label: `Notion · ${st["notion"]}`, contract: CONTRACTS.notion });
  if (st["outlookMail"]) out.push({ id: "link:outlook-mail", label: "Outlook drafts", contract: CONTRACTS.outlookMessageDraft });
  if (st["mstodo"]) out.push({ id: "link:mstodo", label: "Microsoft To Do", contract: CONTRACTS.msTodoTask }, { id: "link:mstodo-due", label: "Microsoft To Do", contract: CONTRACTS.msTodoEntry });
  if (st["todoist"]) out.push({ id: "link:todoist", label: "Todoist", contract: CONTRACTS.todoistTask }, { id: "link:todoist-due", label: "Todoist", contract: CONTRACTS.todoistEntry });
  if (st["outlook"]) out.push({ id: "link:outlook-calendar", label: "Outlook Calendar", contract: CONTRACTS.outlookCalendarEvent });
  if (typeof st["github"] === "string") out.push({ id: "link:github", label: `GitHub ${st["github"]}`, contract: CONTRACTS.githubIssue });
  if (typeof st["linear"] === "string") out.push({ id: "link:linear", label: `Linear ${st["linear"]}`, contract: CONTRACTS.linearIssue });
  return [...out, ...MAPS];
}

// ---- state ------------------------------------------------------------------------------------------------------------
let state: ClumpState = { ...initialClumpState({ now: Date.now(), timezone: TZ }), armed: true };
let lastError = "";
let settings: Settings | null = null;
let on = false;
const pos = new Map<string, Point>();      // where each blob sits on the screen
let lastAt: Point = { x: innerWidth / 2, y: innerHeight / 2 };
const log = new InMemoryEventLog();

const clay = createClay($("#clay"), { reducedMotion, onPointerDown: (id, e) => startObjectPress(id, e) });
const glass = createGlass($("#glass"), {
  onIntent: (i) => onIntent(i), onLayout: () => requestAnimationFrame(() => { renderPass(); placeGlass(); }), reducedMotion,
  linkFor: (op) => linkFor(op.proposal.destination.destination)?.url(op),
  openLink: (url) => { void api.openExternal(url); return true; },
  capturedLabel: "grabbed",
  copyText: (t) => api.copy(t).catch(() => false),
  theme: () => (document.documentElement.dataset["theme"] as "light" | "dark" | undefined),
});

let saveTimer = 0;
function dispatch(e: ClumpInput) {
  const r = reduceClump(state, { ...e, now: Date.now() } as ClumpEvent);
  if (!r.stale) lastError = r.error ?? "";
  const before = state; state = r.state;
  if (state.phase === "merging" && before.phase !== "merging") { const m = state.merging!; void clay.fuse(m.id, m.incomingId).then(() => dispatch({ type: "settled" })); }
  for (const eff of r.effects) void perform(eff);
  // A blob that has no spot yet (a fresh capture, the result of pressing two together) sits where the action was.
  for (const id of state.desk) if (!pos.has(id)) pos.set(id, { ...lastAt });
  render();
  clearTimeout(saveTimer); saveTimer = window.setTimeout(() => void api.saveInbox({ state, pos: Object.fromEntries(pos) } satisfies SavedInbox), 250);
  return r;
}
function onIntent(i: GlassIntent) {
  for (const e of intentEvents(i, state)) dispatch(e);
  if (["reopen", "openWheel", "pick", "inspect", "placeIt", "openRecipe"].includes(i.type)) setTimeout(() => glass.focus(), 0);
}

/** The pieces an object was made from, for the library's "placed in …". */
const piecesOf = (objectId: string) => state.objects[objectId]?.ingredients.map((f) => f.id) ?? [];
const labelOf = (destinationId: string) => state.destinations.find((d) => d.id === destinationId)?.label ?? destinationId;

/** Effects go to the person's connections through the app; a map link was already opened from their click. */
async function perform(eff: ClumpEffect) {
  // Saved, renamed or deleted by the person: the definitions only, into their own private file.
  if (eff.type === "storeWorkflows") { void api.saveWorkflows(eff.items); return; }
  if (eff.type === "storePresets") { void api.savePresets(eff.presets); return; }
  const now = () => new Date().toISOString();
  // The object being placed, as this page knows it (a receipt names it by the operation's own id).
  const pieces = piecesOf(state.run?.objectId ?? state.placement?.objectId ?? "");
  if (eff.destinationId.startsWith("open:")) {
    if (eff.type !== "commit") return;
    const spec = eff.destinationId === "open:apple-maps" ? appleMapsDirections : googleMapsDirections;
    try {
      const receipt = await commit(eff.op, eff.consent, { bridge: new LinkBridge(spec), log, now });
      void api.historyPlaced(pieces, labelOf(eff.destinationId), spec.url(eff.op));
      dispatch({ type: "committed", receipt, undoable: false });
    } catch (e) { dispatch({ type: "commitFailed", opId: eff.op.opId, message: e instanceof Error ? e.message : String(e) }); }
    return;
  }
  const destination = LINK[eff.destinationId]; if (!destination) return;
  if (eff.type === "commit") {
    const opId = eff.op.opId;
    let r: Awaited<ReturnType<OverlayApi["act"]>>;
    try { r = await api.act("commit", { destination, op: eff.op, consent: eff.consent }); }
    catch { dispatch({ type: "outcomeUnknown", opId, message: "Recast lost the answer" }); return; }
    const b = r.body;
    if (b["outcome"] === "done") {
      const receipt = b["receipt"] as Receipt;
      void api.historyPlaced(pieces, labelOf(eff.destinationId));
      dispatch({ type: "committed", receipt, undoable: receipt.reversible });
    } else if (b["outcome"] === "unknown") dispatch({ type: "outcomeUnknown", opId, message: String(b["message"]) });
    else dispatch({ type: "commitFailed", opId, message: String(b["message"] ?? b["error"] ?? `answered ${r.status}`) });
  } else if (eff.type === "reconcile") {
    const r = await api.act("reconcile", { destination, op: eff.op }).catch(() => null);
    if (!r) return;
    if (r.body["checkable"] === false) { lastError = String(r.body["message"]); render(); return; }
    dispatch({ type: "reconciled", opId: eff.op.opId, found: !!r.body["found"], ...(r.body["receipt"] ? { receipt: r.body["receipt"] as Receipt } : {}) });
  } else if (eff.type === "verify") {
    // Read it back through the program: "verified" is the provider's own answer, never the write's success.
    const r = await api.act("verify", { destination, op: eff.op, receipt: eff.receipt }).catch(() => null);
    const v = r?.body["verification"] as Verification | undefined;
    // The destination's own link to what was placed, read back with it: the library keeps it beside the entry.
    if (v?.link && /^https:\/\//.test(v.link)) void api.historyPlaced(pieces, labelOf(eff.destinationId), v.link);
    dispatch({ type: "verified", opId: eff.op.opId, verification: v ?? { ok: false, at: new Date().toISOString(), fields: [], note: "Recast lost the answer, so this was not checked" } });
  } else if (eff.type === "undo") {
    const opId = eff.receipt.opId;
    const r = await api.act("undo", { destination, receipt: eff.receipt }).catch(() => null);
    if (r?.body["outcome"] === "undone") void api.historyUndone(pieces, labelOf(eff.destinationId));
    dispatch(r?.body["outcome"] === "undone" ? { type: "undone", opId } : { type: "undoFailed", opId, message: String(r?.body["message"] ?? "Recast lost the answer; it may still be there") });
  }
}

// ---- grabbing ----------------------------------------------------------------------------------------------------------
let seq = 0;
/** A selection from the app in front, as a piece where it was grabbed: read as a time, a person, an error or text. */
function capture(text: string, origin: Origin, at: Point, how: { carry?: boolean; from?: "selection" | "highlight" | "library"; id?: string } = {}) {
  const t = text.replace(/\s+/g, " ").trim(); if (!t) return;
  const { kind, value, confidence } = pieceOfSelection(text, { now: new Date().toISOString(), timezone: TZ });
  const source = { app: origin.app ?? "Another app", ...(origin.url && /^https?:/.test(origin.url) ? { url: origin.url } : {}), ...(origin.title ? { title: origin.title.slice(0, 200) } : {}) };
  // From the library: the same piece again (its own id), so it is not listed twice and is recognised if already on the desk.
  const f: Fragment = { id: how.id && /^g[\w-]{1,60}$/.test(how.id) ? how.id : `g${Date.now()}-${++seq}`, kind, text: t.slice(0, 1000), confidence: confidence ?? 0.9, ...(value ? { value } : {}),
    evidence: [{ locator: { kind: "user", value: how.from ?? "selection" }, excerpt: t.slice(0, 200) }], source };
  lastAt = how.carry ? { ...at } : spotNear(at);
  const r = dispatch({ type: "capture", fragment: f, ...(how.carry ? { carry: true } : {}) });
  if (r.captured && !r.error) { pos.set(r.captured, { ...lastAt }); render(); }
  void api.historyAdd({ id: f.id, text: f.text, kind, source });
}
/** A free spot beside the pointer: blobs do not land on one another. */
function spotNear(at: Point): Point {
  const p = { x: Math.min(Math.max(at.x + 90, 100), innerWidth - 100), y: Math.min(Math.max(at.y + 30, 40), innerHeight - 40) };
  for (let i = 0; i < 12 && [...pos.values()].some((q) => Math.abs(q.x - p.x) < 150 && Math.abs(q.y - p.y) < 44); i++) p.y = p.y + 50 > innerHeight - 40 ? 40 : p.y + 50;
  return p;
}
api.on("recast:capture", (v: { text: string; at?: Point; id?: string } & Origin) => { if (v.text.trim()) capture(v.text, v, v.at ?? lastAt, v.id ? { id: v.id, from: "library" } : {}); });
api.on("recast:grab-problem", (v: { reason: string; message: string; at?: Point }) => toast(v.message, v.at));
api.on("recast:on", (next: boolean) => {
  on = next;
  if (next) { state = { ...state, armed: true }; void destinations().then((d) => { state = { ...state, destinations: d }; render(); }); toast(idleLine()); }
  else { pressCleanup(); kbd = false; keysAsked = false; spots = []; spotPress = null; renderSpots(); $("#toast").hidden = true; for (const ev of closeAll()) dispatch(ev); }
  render();
});
api.on("recast:escape", () => escape());

// ---- highlights: what on the screen Recast reads as likely pieces (a time, an email address, an error, a link) -------------
// Click one and it is a blob beside it; drag one and it is a blob in hand (drop it on another to press them together).
// Anything not highlighted can still be selected by hand.
interface Spot { kind: string; text: string; x: number; y: number; width: number; height: number }
let spots: Spot[] = [];
let spotSource: Origin = {};
let spotPress: { spot: Spot; x: number; y: number } | null = null;
const SPOT_WORD: Record<string, string> = { time: "Time", person: "Person", error: "Error", link: "Link", phone: "Phone", code: "Code" };
api.on("recast:spots", (v: { spots: Spot[]; source?: Origin; note?: string }) => {
  spots = on ? v.spots ?? [] : []; spotSource = v.source ?? {};
  if (v.note && on) toast(v.note);
  renderSpots(); report(true);
});
function renderSpots() {
  const host = $("#spots"); host.replaceChildren();
  for (const sp of spots) {
    const el = document.createElement("button"); el.type = "button"; el.className = "spot"; el.dataset["kind"] = sp.kind;
    // A little room around the words, in proportion to their size (OCR boxes sit tight, and a little inside, on some fonts).
    const px = Math.max(3, Math.round(sp.height * 0.3)), py = Math.max(2, Math.round(sp.height * 0.12));
    el.style.left = `${sp.x - px}px`; el.style.top = `${sp.y - py}px`; el.style.width = `${sp.width + 2 * px}px`; el.style.height = `${sp.height + 2 * py}px`;
    el.setAttribute("aria-label", `${SPOT_WORD[sp.kind] ?? "Piece"}: ${sp.text}. Click to grab it`); el.title = `${SPOT_WORD[sp.kind] ?? "Piece"}: click to grab, or drag onto a blob`;
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); pointer = { x: e.clientX, y: e.clientY }; spotPress = { spot: sp, x: e.clientX, y: e.clientY }; report(true); });
    el.addEventListener("click", (e) => { if (e.detail === 0) take(sp, false); });   // keyboard
    host.append(el);
  }
}
/** A highlight becomes a blob: beside it (a click), or in hand (a drag). It is no longer highlighted. */
function take(sp: Spot, carry: boolean) {
  spots = spots.filter((x) => x !== sp); renderSpots();
  const origin = { ...spotSource };
  capture(sp.text, origin, carry ? pointer : { x: sp.x + sp.width, y: sp.y }, { carry, from: "highlight" });
}
function escape() {
  const ev = escapeEvent(state);
  if (ev && ev.type !== "disarm") dispatch(ev); else void api.off();
}
/** Turning off: the wheel closes; blobs stay (they come back with Recast, and the library keeps them). */
function closeAll(): ClumpInput[] { return ["idle", "succeeded", "failed"].includes(state.phase) ? [] : intentEvents({ type: "close" }, state); }

// ---- blobs: drag one onto another to press them together; click one to open the wheel beside it ---------------------------
let pointer: Point = { x: 0, y: 0 };
let press: { id: string; x: number; y: number; started: boolean } | null = null;
function startObjectPress(id: string, e: PointerEvent) {
  if (state.carried || ["merging", "executing", "running", "unknown"].includes(state.phase)) return;
  e.preventDefault(); pointer = { x: e.clientX, y: e.clientY }; press = { id, x: e.clientX, y: e.clientY, started: false };
  report(true);
}
function pressCleanup() { press = null; if (state.carried) dispatch({ type: "drop" }); }
addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (spotPress && Math.hypot(e.clientX - spotPress.x, e.clientY - spotPress.y) > 6) { const sp = spotPress.spot; spotPress = null; take(sp, true); }
  if (press && !press.started && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
    press.started = true;
    if (!["idle", "inspecting", "succeeded", "failed", "composed", "choosing"].includes(state.phase)) for (const ev of intentEvents({ type: "close" }, state)) dispatch(ev);
    dispatch({ type: "pickUp", id: press.id });
  }
  if (state.carried) { hitTest(); renderPass(); }
  report();
}, { passive: true });
// The pointer left Recast's shapes (on Linux the window is only those shapes): it is over the app underneath again.
document.documentElement.addEventListener("pointerleave", () => { if (!press && !state.carried && !spotPress) { pointer = { x: -1, y: -1 }; report(); } });
addEventListener("blur", () => { if (!press && !state.carried && !spotPress) { pointer = { x: -1, y: -1 }; report(); } });
addEventListener("pointerup", () => {
  // A click lands the keys on the overlay (a Mac and Windows focus what is clicked); a click that opens nothing hands them back.
  requestAnimationFrame(() => { if (!wantKeys()) { keysAsked = false; void api.keys(false); } });
  if (spotPress) { const sp = spotPress.spot; spotPress = null; take(sp, false); report(); return; }
  if (press && !press.started) { const id = press.id; press = null; lastAt = pos.get(id) ?? lastAt; dispatch({ type: "inspect", id }); report(); return; }
  press = null;
  if (state.carried) {
    hitTest();
    const id = state.carried; const merging = state.target?.kind === "object" ? state.target.id : null;
    // Let go on nothing: the blob stays where it was put down. On another blob: they press together there.
    if (!merging) pos.set(id, { ...pointer }); else lastAt = pos.get(merging) ?? pointer;
    dispatch({ type: "drop" });
  }
  report();
});
function hitTest() {
  let best: { id: string; d: number } | null = null;
  for (const id of state.desk) { const b = clay.box(id); if (!b) continue; const d = Math.hypot(b.x - pointer.x, b.y - pointer.y); if (d < Math.max(b.w / 2, 56) && (!best || d < best.d)) best = { id, d }; }
  const target: Target | null = best ? { kind: "object", id: best.id } : null;
  if (JSON.stringify(target) !== JSON.stringify(state.target)) dispatch({ type: "approach", target });
}

// ---- where the overlay takes the mouse ---------------------------------------------------------------------------------
/** Recast's own rectangles: every blob and the wheel. Everywhere else, clicks go to the app underneath. */
function rects(withToast = true, withSpots = true) {
  const out: DOMRect[] = [];
  for (const id of [...state.desk, ...(state.carried ? [state.carried] : [])]) { const el = clay.label(id); if (el) out.push(el.getBoundingClientRect()); }
  if (!glass.el.hidden && !["off", "pill"].includes(glass.el.dataset["mode"] ?? "off")) out.push(glass.el.getBoundingClientRect());
  if (withSpots) for (const el of document.querySelectorAll<HTMLElement>(".spot")) out.push(el.getBoundingClientRect());
  // The quiet line is drawn too (on Linux the window is only these shapes), though it never takes a click on a Mac or Windows.
  const toastEl = $("#toast"); if (withToast && !toastEl.hidden) out.push(toastEl.getBoundingClientRect());
  return out.filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }));
}
let reported = "";
/** Tells the app whether the pointer is on Recast (so the window takes the click) and where Recast's shapes are. */
function report(force = false) {
  const rs = rects(); const busy = !!press || !!state.carried || !!spotPress;
  const over = busy || rects(false).some((r) => pointer.x >= r.x && pointer.x <= r.x + r.width && pointer.y >= r.y && pointer.y <= r.y + r.height);
  const shapes = busy ? [{ x: 0, y: 0, width: innerWidth, height: innerHeight }] : rs;
  const own = rects(false, false);   // the blobs and the wheel: what a fresh look at the screen must not mistake for the app's words
  const key = `${over}|${JSON.stringify(shapes)}|${JSON.stringify(own)}`;
  if (key === reported && !force) return;
  reported = key; void api.interactive(over, shapes, own);
}

// ---- the keyboard ---------------------------------------------------------------------------------------------------------
// The app in front keeps the keys. Recast asks for them only while its wheel is open (there may be an answer to type) or
// after the person moved the keyboard onto it (the keys shortcut); then it hands them straight back.
let kbd = false, keysAsked = false;
const wheelOpen = () => !glass.el.hidden && !["off", "pill"].includes(glass.el.dataset["mode"] ?? "off");
const wantKeys = () => on && (kbd || wheelOpen());
function askKeys() {
  const want = wantKeys();
  if (want !== keysAsked) { keysAsked = want; void api.keys(want); }
  // Back on the desk after the wheel closed: the keyboard stays on a blob, never lost on the page.
  if (want && kbd && !wheelOpen() && (document.activeElement === document.body || !document.activeElement)) focusables()[0]?.focus();
}
/** What the keyboard moves between: the blobs, then the highlights. */
const focusables = () => [...document.querySelectorAll<HTMLElement>("#clay .clay-item"), ...document.querySelectorAll<HTMLElement>("#spots .spot")];
api.on("recast:keys", (take: boolean) => {
  kbd = take && on; keysAsked = kbd;
  if (kbd) { focusables()[0]?.focus(); toast(keysLine()); } else toast(idleLine());
});
const keysLine = () => `Keyboard on Recast · Tab between pieces · Enter opens · Space picks up · Esc gives the keys back`;

// ---- drawing ------------------------------------------------------------------------------------------------------------
let inWell: string | null = null;
function kindOf(id: string): ClayItem["kind"] {
  const v = viewOf(state, id); const f = state.objects[id]!.ingredients[0]!;
  return v.type === "Event" ? "event" : v.type === "Message" ? "message" : v.type === "People" ? "people" : v.type === "Note" ? "note" : v.type === "Issue" ? "issue" : f.kind;
}
const anchorId = () => state.run?.objectId ?? state.placement?.objectId ?? state.inspecting ?? state.focus;
/** The wheel opens right beside its blob: below it when there is room, above it when not, always on the screen. */
function placeGlass() {
  const id = anchorId(); const a = (id && pos.get(id)) || lastAt;
  const w = glass.el.offsetWidth || 380, h = glass.el.offsetHeight || 300;
  const left = Math.min(Math.max(12, a.x - w / 2), innerWidth - w - 12);
  const top = a.y + 40 + h < innerHeight - 12 ? a.y + 40 : Math.max(12, a.y - h - 40);
  glass.el.style.setProperty("--ov-left", `${Math.round(left)}px`); glass.el.style.setProperty("--ov-top", `${Math.round(top)}px`);
}
function render() {
  glass.update(moduleModel(state, REGISTRY), lastError && !state.carried ? { error: lastError } : {});
  placeGlass();
  const w = glass.well(); const id = anchorId();
  inWell = w && id && state.desk.includes(id) && state.carried !== id ? id : null;
  renderPass();
  document.body.classList.toggle("on", on);
  // With the wheel closed, what just happened (or why something was refused) shows briefly by the blob.
  if (glass.el.dataset["mode"] === "pill" || glass.el.dataset["mode"] === "off") {
    if (lastError) toast(lastError.charAt(0).toUpperCase() + lastError.slice(1));
    else if (state.last && state.last.at !== shownAt && ["refused", "cancelled", "removed", "discarded", "placed", "undone", "failed"].includes(state.last.kind)) toast(state.last.text);
  }
  shownAt = state.last?.at ?? shownAt;
  requestAnimationFrame(() => { report(); askKeys(); });
}
let shownAt = 0;
function renderPass() {
  const well = inWell ? glass.well() : null; const items: ClayItem[] = [];
  for (const id of [...state.desk, ...(state.carried ? [state.carried] : [])]) {
    const v = viewOf(state, id); const carried = id === state.carried;
    const at = carried ? pointer : id === inWell && well ? well : pos.get(id) ?? lastAt;
    const mode = carried ? "carried" : state.target?.kind === "object" && state.target.id === id ? (state.verdict?.ok ? "accepts" : "refuses") : "rest";
    items.push({ id, x: at.x, y: at.y, label: v.label, ...(id === inWell ? {} : { detail: doubtNote(state, id) ?? (v.type === "Fragment" ? v.summary[0]! : v.summary.join(" · ")) }),
      count: state.objects[id]!.ingredients.length, kind: kindOf(id), mode, proposed: v.proposed, focused: false });
  }
  clay.update(items);
  for (const it of items) { const el = clay.label(it.id); if (el) { el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-description", "Enter or click to choose where it goes; Space, or drag, to pick it up and press it into another; Delete to remove"); } }
}
let toastTimer = 0;
/** The status pill, at the bottom centre while Recast is on (like a dictation app's): how to use it, or what just
 *  happened. Never next to the pointer, so it never covers what the person is about to select or click. */
const idleLine = () => `Recast is on · click a highlight or select text · Esc to turn off`;
function toast(t: string, _at?: Point) {
  const el = $("#toast"); el.textContent = t; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { if (on) el.textContent = idleLine(); else el.hidden = true; report(); }, 3200);
  report();
}

// The same path as the try-it page and the extension (D48). On a blob: Enter opens the wheel on it; Space picks it up.
// With one in hand, Enter on another presses them together, Enter (or Space) on the one in hand puts it back down.
// Arrows move between blobs and highlights as Tab does. Escape steps back; at rest it gives the keys back to the app.
let keepTimer = 0;
addEventListener("keydown", (e) => {
  clearTimeout(keepTimer);   // the next key wins over a pending "keep the keyboard here"
  const el = e.target as HTMLElement;
  if (e.key === "Escape") {
    e.preventDefault();
    if (state.carried) { const id = state.carried; dispatch({ type: "drop" }); clay.label(id)?.focus(); return; }
    const ev = escapeEvent(state);
    if (ev && ev.type !== "disarm") { dispatch(ev); return; }
    kbd = false; keysAsked = false; toast(idleLine()); void api.keys(false); return;
  }
  if (glass.el.contains(el) || el.matches("input, textarea")) return;
  if (e.key.startsWith("Arrow")) {
    const all = focusables(); if (!all.length) return;
    e.preventDefault();
    const i = all.indexOf(el.classList.contains("clay-item") || el.classList.contains("spot") ? el : clay.label(state.carried ?? "") ?? el), step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = all[(i < 0 ? 0 : i + step + all.length) % all.length]!; next.focus();
    if (state.carried) { const b = next.getBoundingClientRect(); pointer = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; renderPass(); }
    return;
  }
  if (!el.classList.contains("clay-item")) return;
  const id = el.dataset["id"]!;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (state.carried && state.carried !== id && e.key === "Enter") {
      lastAt = pos.get(id) ?? lastAt;
      dispatch({ type: "approach", target: { kind: "object", id } }); dispatch({ type: "drop" });
    } else if (state.carried === id) dispatch({ type: "drop" });
    else if (e.key === " ") {
      if (state.carried || ["merging", "executing", "running", "unknown"].includes(state.phase)) return;
      if (!["idle", "inspecting", "succeeded", "failed", "composed", "choosing"].includes(state.phase)) for (const ev of intentEvents({ type: "close" }, state)) dispatch(ev);
      pointer = { ...(pos.get(id) ?? lastAt) }; dispatch({ type: "pickUp", id });
    } else { lastAt = pos.get(id) ?? lastAt; dispatch({ type: "inspect", id }); setTimeout(() => glass.focus(), 0); return; }
    // Keep the keyboard on the desk: on what is in hand, or on the blob it went into (again once a fusion has settled).
    const keep = () => (clay.label(state.carried ?? id) ?? clay.label(state.desk.at(-1) ?? ""))?.focus();
    keep(); keepTimer = window.setTimeout(keep, 30);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault(); pos.delete(id); dispatch({ type: "discard", id });
    keepTimer = window.setTimeout(() => focusables()[0]?.focus(), 30);
  }
});
addEventListener("blur", () => { if (kbd) { kbd = false; keysAsked = wheelOpen(); } });

// ---- start -----------------------------------------------------------------------------------------------------------------
function setTheme(t: "dark" | "light") { document.documentElement.dataset["theme"] = t; render(); }
api.on("recast:theme", (t: "dark" | "light") => setTheme(t));
api.on("recast:settings", (s: Settings) => { settings = s; });
const style = document.createElement("style"); style.textContent = CLAY_CSS + GLASS_CSS; document.head.appendChild(style);
addEventListener("resize", () => render());
void (async () => {
  const b = await api.boot();
  settings = b.settings; on = b.on; setTheme(b.theme);
  const saved = b.inbox && typeof b.inbox === "object" ? ("state" in b.inbox ? b.inbox : { state: b.inbox as ClumpState, pos: {} }) : null;
  if (saved && Array.isArray(saved.state?.desk)) { state = recover(saved.state); for (const [k, v] of Object.entries(saved.pos ?? {})) pos.set(k, v); }
  state = { ...state, armed: true, destinations: await destinations() };
  // The saved workflows live in their own file and are checked as they are read, every start (never trusted from the inbox).
  state = reduceClump(state, { type: "setWorkflows", items: Array.isArray(b.workflows) ? b.workflows : [], known: REGISTRY.map((c) => c.destination), now: Date.now() }).state;
  state = reduceClump(state, { type: "loadPresets", presets: b.presets ?? {}, now: Date.now() }).state;
  render();
})();

/**
 * After a restart: nothing that was in flight is assumed to have worked or failed. A write whose answer never came is
 * unknown (checked, never resent); an undo in flight is reported as not confirmed; a merge simply settles.
 */
function recover(saved: ClumpState): ClumpState {
  let s: ClumpState = { ...saved, now: Date.now(), timezone: TZ, carried: null, target: null, verdict: null, desk: saved.carried ? [...saved.desk, saved.carried] : saved.desk };
  const step = (ev: ClumpInput) => { s = reduceClump(s, { ...ev, now: Date.now() } as ClumpEvent).state; };
  if (s.phase === "merging") step({ type: "settled" });
  else if (s.phase === "executing" && s.placement?.op) step({ type: "outcomeUnknown", opId: s.placement.op.opId, message: "Recast closed before the answer came" });
  else if (s.phase === "undoing" && s.placement?.op) step({ type: "undoFailed", opId: s.placement.op.opId, message: "Recast closed before the undo was confirmed" });
  else if (s.phase === "running" && s.run) {
    for (const x of s.run.steps) if (x.status === "running" && x.op) step({ type: "outcomeUnknown", opId: x.op.opId, message: "Recast closed before the answer came" });
    if (s.phase === "running") s = { ...s, phase: "ran", run: { ...s.run!, steps: s.run!.steps.map((x) => (x.status === "waiting" ? { ...x, status: "skipped" } : x)) } };
  } else if (["carrying", "approaching", "confirmingMerge"].includes(s.phase)) s = { ...s, phase: "idle", pendingMerge: null };
  return s;
}
