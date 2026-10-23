// The capsule window: the same clay objects, glass module and state machine as the browser, on the desktop.
// Pieces come from what the person types or dictates (macOS: press Fn for dictation; Windows: Win+H) and from what they
// copied anywhere (the capture shortcut). Destinations are the person's own connections, through the app.
import { commit, InMemoryEventLog, pieceOfSelection, type Fragment, type Receipt } from "@recast/core";
import { CONTRACTS, REGISTRY } from "@recast/bridges/src/contracts";
import { appleMapsDirections, googleMapsDirections, LinkBridge, linkFor } from "@recast/bridges/src/links";
import { doubtNote, escapeEvent, initialClumpState, moduleModel, reduceClump, viewOf, type ClumpEffect, type ClumpEvent, type ClumpInput, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
import { CLAY_CSS, createClay, type ClayItem } from "@recast/overlay/src/clay";
import { createGlass, GLASS_CSS, intentEvents, type GlassIntent } from "@recast/overlay/src/glass";

interface DesktopApi {
  boot(): Promise<{ settings: DesktopSettings; inbox: ClumpState | null; theme: "dark" | "light" }>;
  status(): Promise<Record<string, unknown>>;
  act(route: "commit" | "reconcile" | "undo", body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  openExternal(url: string): Promise<boolean>;
  saveInbox(state: unknown): Promise<boolean>;
  clipboard(): Promise<string>;
  settings(p: unknown): Promise<DesktopSettings>;
  window(what: "hide" | "minimize" | "connections" | "playground" | "signin"): Promise<boolean>;
  size(mode: "compact" | "open"): Promise<string>;
  permission(): Promise<boolean>;
  on(channel: "recast:capture" | "recast:theme" | "recast:settings" | "recast:grab-problem" | "recast:expand", fn: (v: any) => void): void;
}
interface DesktopSettings { theme: "system" | "dark" | "light"; keepOnTop: boolean; shortcuts: { open: string; capture: string }; platform: string; shortcutProblems: string[]; serverNote: string; version: string; grabReady: boolean }
const api = (window as unknown as { recastDesktop: DesktopApi }).recastDesktop;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MAC = navigator.userAgent.includes("Mac");
const pretty = (a: string) => (MAC ? a.replace("CommandOrControl", "⌘").replace("Control", "⌃").replace("Alt", "⌥").replace("Shift", "⇧").replace(/\+/g, "") : a.replace("CommandOrControl", "Ctrl"));

// ---- destinations: the person's connections, as the bridge registry's contracts --------------------------------------------
const LINK: Record<string, string> = { "link:google-calendar": "calendar", "link:gmail-drafts": "gmail", "link:google-tasks": "tasks", "link:google-tasks-due": "tasks", "link:google-docs": "docs", "link:github": "github", "link:linear": "linear" };
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
  if (typeof st["github"] === "string") out.push({ id: "link:github", label: `GitHub ${st["github"]}`, contract: CONTRACTS.githubIssue });
  if (typeof st["linear"] === "string") out.push({ id: "link:linear", label: `Linear ${st["linear"]}`, contract: CONTRACTS.linearIssue });
  return [...out, ...MAPS];
}

// ---- state ------------------------------------------------------------------------------------------------------------
let state: ClumpState = { ...initialClumpState({ now: Date.now(), timezone: TZ }), armed: true };
let lastError = "";
let settings: DesktopSettings | null = null;
const log = new InMemoryEventLog();

const clay = createClay($("#clay"), { reducedMotion, onPointerDown: (id, e) => startObjectPress(id, e) });
const glass = createGlass($("#glass"), {
  onIntent: (i) => onIntent(i), onLayout: () => requestAnimationFrame(() => renderPass()), reducedMotion,
  linkFor: (op) => linkFor(op.proposal.destination.destination)?.url(op),
  openLink: (url) => { void api.openExternal(url); return true; },
  capturedLabel: "captured",
  theme: () => (document.documentElement.dataset["theme"] as "light" | "dark" | undefined),
});

let saveTimer = 0;
function dispatch(e: ClumpInput) {
  const r = reduceClump(state, { ...e, now: Date.now() } as ClumpEvent);
  if (!r.stale) lastError = r.error ?? "";
  const before = state; state = r.state;
  if (state.phase === "merging" && before.phase !== "merging") { const m = state.merging!; void clay.fuse(m.id, m.incomingId).then(() => dispatch({ type: "settled" })); }
  for (const eff of r.effects) void perform(eff);
  render();
  // The inbox: what is on the desk survives a restart (on this computer only).
  clearTimeout(saveTimer); saveTimer = window.setTimeout(() => void api.saveInbox(state), 250);
  return r;
}
function onIntent(i: GlassIntent) {
  for (const e of intentEvents(i, state)) dispatch(e);
  if (["reopen", "openWheel", "pick", "inspect", "placeIt", "openRecipe"].includes(i.type)) setTimeout(() => glass.focus(), 0);
}

/** Effects go to the person's connections through the app; a map link was already opened from their click. */
async function perform(eff: ClumpEffect) {
  const now = () => new Date().toISOString();
  if (eff.destinationId.startsWith("open:")) {
    if (eff.type !== "commit") return;
    const spec = eff.destinationId === "open:apple-maps" ? appleMapsDirections : googleMapsDirections;
    try { const receipt = await commit(eff.op, eff.consent, { bridge: new LinkBridge(spec), log, now }); dispatch({ type: "committed", receipt, undoable: false }); }
    catch (e) { dispatch({ type: "commitFailed", opId: eff.op.opId, message: e instanceof Error ? e.message : String(e) }); }
    return;
  }
  const destination = LINK[eff.destinationId]; if (!destination) return;
  if (eff.type === "commit") {
    const opId = eff.op.opId;
    let r: Awaited<ReturnType<DesktopApi["act"]>>;
    try { r = await api.act("commit", { destination, op: eff.op, consent: eff.consent }); }
    catch { dispatch({ type: "outcomeUnknown", opId, message: "Recast lost the answer" }); return; }
    const b = r.body;
    if (b["outcome"] === "done") dispatch({ type: "committed", receipt: b["receipt"] as Receipt, undoable: (b["receipt"] as Receipt).reversible });
    else if (b["outcome"] === "unknown") dispatch({ type: "outcomeUnknown", opId, message: String(b["message"]) });
    else dispatch({ type: "commitFailed", opId, message: String(b["message"] ?? b["error"] ?? `answered ${r.status}`) });
  } else if (eff.type === "reconcile") {
    const r = await api.act("reconcile", { destination, op: eff.op }).catch(() => null);
    if (!r) return;
    if (r.body["checkable"] === false) { lastError = String(r.body["message"]); render(); return; }
    dispatch({ type: "reconciled", opId: eff.op.opId, found: !!r.body["found"], ...(r.body["receipt"] ? { receipt: r.body["receipt"] as Receipt } : {}) });
  } else {
    const opId = eff.receipt.opId;
    const r = await api.act("undo", { destination, receipt: eff.receipt }).catch(() => null);
    dispatch(r?.body["outcome"] === "undone" ? { type: "undone", opId } : { type: "undoFailed", opId, message: String(r?.body["message"] ?? "Recast lost the answer; it may still be there") });
  }
}

// ---- capturing ---------------------------------------------------------------------------------------------------------
let seq = 0;
/** Typed, dictated or copied text as a piece: read as a time, a person (an email address), an error or text. */
interface Origin { app?: string; title?: string; url?: string }
/**
 * A piece from what the person selected in another app (with the app, and the page for a browser), typed or dictated here,
 * or copied: read as a time, a person (an email address), an error or text. Only what the system said is recorded.
 */
function capture(text: string, from: "typed" | "clipboard" | "selection", origin: Origin = {}) {
  const t = text.replace(/\s+/g, " ").trim(); if (!t) return;
  const { kind, value } = pieceOfSelection(text, { now: new Date().toISOString(), timezone: TZ });
  const source = from === "selection"
    ? { app: origin.app ?? "Another app", ...(origin.url && /^https?:/.test(origin.url) ? { url: origin.url } : {}), ...(origin.title ? { title: origin.title.slice(0, 200) } : {}) }
    : { app: "Recast", title: from === "typed" ? "Typed or dictated" : `Copied ${new Date().toLocaleString()}` };
  const f: Fragment = { id: `d${Date.now()}-${++seq}`, kind, text: t.slice(0, 1000), confidence: from === "typed" ? 1 : 0.9, ...(value ? { value } : {}),
    evidence: [{ locator: { kind: "user", value: from }, excerpt: t.slice(0, 200) }], source };
  dispatch({ type: "capture", fragment: f });
  if (from === "selection") status(`Grabbed from ${origin.app ?? "another app"}`);
}
const input = $<HTMLInputElement>("#say");
$("#say-form").addEventListener("submit", (e) => { e.preventDefault(); capture(input.value, "typed"); input.value = ""; input.focus(); });
$("#paste").addEventListener("click", async () => { const t = await api.clipboard(); if (t.trim()) capture(t, "clipboard"); else flash("Nothing is copied yet"); });
api.on("recast:capture", (v: { text: string; from?: string } & Origin) => {
  if (!v.text.trim()) { status("Select some text first"); return; }
  capture(v.text, v.from === "selection" ? "selection" : "clipboard", v);
});
api.on("recast:grab-problem", (v: { reason: string; message: string }) => {
  if (v.reason === "permission") { needPermission = true; expanded = true; render(); }
  status(v.message);
});
let needPermission = false, expanded = false;
$("#btn-permission").addEventListener("click", async () => { if (await api.permission()) { needPermission = false; render(); } });
function expand() { expanded = true; render(); setTimeout(() => input.focus(), 50); }
$("#btn-expand").addEventListener("click", expand);
api.on("recast:expand", expand);
/** The pill's one line: what just happened, or how to start. */
let statusTimer = 0;
function status(t: string) { const el = $("#status"); el.textContent = t; clearTimeout(statusTimer); statusTimer = window.setTimeout(() => { el.textContent = idleHint(); }, 4000); }
const idleHint = () => `Select text, then ${settings ? pretty(settings.shortcuts.capture) : "the shortcut"}`;

// ---- the desk: objects rest in a flow; drag one onto another to press them together ---------------------------------------
let inWell: string | null = null;
const spots = () => {
  const r = $("#desk").getBoundingClientRect(); const out = new Map<string, { x: number; y: number }>();
  let x = r.x + 12, row = 0;
  for (const id of state.desk.filter((d) => d !== inWell)) {
    const w = Math.min(r.width - 24, clay.label(id)?.offsetWidth ?? 170);
    if (x > r.x + 12 && x + w > r.right - 12) { x = r.x + 12; row++; }
    out.set(id, { x: x + w / 2, y: r.y + 34 + row * 62 }); x += w + 12;
  }
  return out;
};
let pointer = { x: 0, y: 0 };
let press: { id: string; x: number; y: number; started: boolean } | null = null;
function startObjectPress(id: string, e: PointerEvent) {
  if (state.carried || ["merging", "executing", "running", "unknown"].includes(state.phase)) return;
  e.preventDefault(); pointer = { x: e.clientX, y: e.clientY }; press = { id, x: e.clientX, y: e.clientY, started: false };
}
addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (press && !press.started && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
    press.started = true;
    if (!["idle", "inspecting", "succeeded", "failed", "composed", "choosing"].includes(state.phase)) for (const ev of intentEvents({ type: "close" }, state)) dispatch(ev);
    dispatch({ type: "pickUp", id: press.id });
  }
  if (state.carried) { hitTest(); renderPass(); }
}, { passive: true });
addEventListener("pointerup", () => {
  if (press && !press.started) { const id = press.id; press = null; dispatch({ type: "inspect", id }); return; }
  press = null;
  if (state.carried) { hitTest(); dispatch({ type: "drop" }); }
});
function hitTest() {
  let best: { id: string; d: number } | null = null;
  for (const id of state.desk) { const b = clay.box(id); if (!b) continue; const d = Math.hypot(b.x - pointer.x, b.y - pointer.y); if (d < Math.max(b.w / 2, 56) && (!best || d < best.d)) best = { id, d }; }
  const target: Target | null = best ? { kind: "object", id: best.id } : null;
  if (JSON.stringify(target) !== JSON.stringify(state.target)) dispatch({ type: "approach", target });
}

// ---- drawing ------------------------------------------------------------------------------------------------------------
function kindOf(id: string): ClayItem["kind"] {
  const v = viewOf(state, id); const f = state.objects[id]!.ingredients[0]!;
  return v.type === "Event" ? "event" : v.type === "Message" ? "message" : v.type === "People" ? "people" : v.type === "Note" ? "note" : v.type === "Issue" ? "issue" : f.kind;
}
/** The capsule: a pill while there is nothing to do; the panel while there is (objects, the module, typing, settings). */
let shownMode = "";
function sizeFor() {
  const busy = state.desk.length > 0 || !!state.carried || !["pill", "off"].includes(glass.el.dataset["mode"] ?? "off") || expanded || needPermission || !$("#settings").hidden;
  const mode = busy ? "open" : "compact";
  document.body.classList.toggle("compact", mode === "compact");
  if (mode !== shownMode) { shownMode = mode; void api.size(mode); }
}
function render() {
  glass.update(moduleModel(state, REGISTRY), lastError && !state.carried ? { error: lastError } : {});
  glass.el.style.setProperty("--rg-bottom", `${$("#say-form").offsetHeight + 10}px`);
  const w = glass.well(); const id = state.run?.objectId ?? state.placement?.objectId ?? state.inspecting ?? state.focus;
  inWell = w && id && state.desk.includes(id) && state.carried !== id ? id : null;
  renderPass();
  $("#empty").hidden = state.desk.length > 0 || !!state.carried;
  $("#permission").hidden = !needPermission;
  // One quiet line about what to do next, while the module is closed.
  const next = $("#next"); const closed = ["pill", "off"].includes(glass.el.dataset["mode"] ?? "off");
  next.hidden = !closed || !state.desk.length || !!state.carried;
  next.textContent = state.desk.length === 1 ? "Grab another piece, or drag them together. Click an object to see inside or place it." : "Drag one object onto another to press them together, then choose where it goes.";
  sizeFor();
  // With the module closed, what just happened (or why something was refused) shows in the note.
  if (glass.el.dataset["mode"] === "pill" || glass.el.dataset["mode"] === "off") {
    if (lastError) flash(lastError.charAt(0).toUpperCase() + lastError.slice(1));
    else if (state.last && state.last.at !== shownAt && ["refused", "cancelled", "removed", "placed", "undone", "failed"].includes(state.last.kind)) flash(state.last.text);
  }
  shownAt = state.last?.at ?? shownAt;
}
let shownAt = 0;
function renderPass() {
  const s = spots(); const well = inWell ? glass.well() : null; const items: ClayItem[] = [];
  for (const id of [...state.desk, ...(state.carried ? [state.carried] : [])]) {
    const v = viewOf(state, id); const carried = id === state.carried;
    const at = carried ? pointer : id === inWell && well ? well : s.get(id) ?? { x: 0, y: 0 };
    const mode = carried ? "carried" : state.target?.kind === "object" && state.target.id === id ? (state.verdict?.ok ? "accepts" : "refuses") : "rest";
    items.push({ id, x: at.x, y: at.y, label: v.label, ...(id === inWell ? {} : { detail: doubtNote(state, id) ?? (v.type === "Fragment" ? v.summary[0]! : v.summary.join(" · ")) }),
      count: state.objects[id]!.ingredients.length, kind: kindOf(id), mode, proposed: v.proposed, focused: false });
  }
  clay.update(items);
  for (const it of items) { const el = clay.label(it.id); if (el) { el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-description", "Enter to open, Space to pick up, Delete to remove"); } }
}
let flashTimer = 0;
function flash(t: string) { const el = $("#note"); el.textContent = t; el.hidden = false; clearTimeout(flashTimer); flashTimer = window.setTimeout(() => { el.hidden = true; }, 3500); }

// ---- keyboard: never leaves the window; Escape steps back ------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const el = e.target as HTMLElement;
  if (e.key === "Escape") { const ev = escapeEvent(state); if (ev && ev.type !== "disarm") { e.preventDefault(); dispatch(ev); } else if (!ev || ev.type === "disarm") void api.window("hide"); return; }
  if (glass.el.contains(el) || el.matches("input, textarea, button")) return;
  if (el.classList.contains("clay-item")) {
    const id = el.dataset["id"]!;
    if (e.key === "Enter") { e.preventDefault(); dispatch({ type: "inspect", id }); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); dispatch({ type: "discard", id }); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const i = state.desk.indexOf(id); clay.label(state.desk[(i + (e.key === "ArrowRight" ? 1 : -1) + state.desk.length) % state.desk.length]!)?.focus(); }
  }
});

// ---- chrome: theme, settings, window buttons ---------------------------------------------------------------------------
function setTheme(t: "dark" | "light") { document.documentElement.dataset["theme"] = t; render(); }
api.on("recast:theme", (t: "dark" | "light") => setTheme(t));
api.on("recast:settings", (s: DesktopSettings) => { settings = s; renderSettings(); });
$("#btn-hide").addEventListener("click", () => { expanded = false; $("#settings").hidden = true; render(); void api.window("hide"); });
$("#btn-settings").addEventListener("click", () => { const p = $("#settings"); p.hidden = !p.hidden; if (!p.hidden) renderSettings(); render(); });
$("#btn-connections").addEventListener("click", () => void api.window("connections"));
$("#btn-playground").addEventListener("click", () => void api.window("playground"));
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=theme]")) r.addEventListener("change", () => void api.settings({ theme: r.value }).then((s) => { settings = s; renderSettings(); }));
$<HTMLInputElement>("#on-top").addEventListener("change", (e) => void api.settings({ keepOnTop: (e.target as HTMLInputElement).checked }));
$("#shortcuts-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void api.settings({ shortcuts: { open: $<HTMLInputElement>("#sc-open").value.trim(), capture: $<HTMLInputElement>("#sc-capture").value.trim() } }).then((s) => { settings = s; renderSettings(); });
});
function renderSettings() {
  if (!settings) return;
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=theme]")) r.checked = r.value === settings.theme;
  $<HTMLInputElement>("#on-top").checked = settings.keepOnTop;
  $<HTMLInputElement>("#sc-open").value = settings.shortcuts.open; $<HTMLInputElement>("#sc-capture").value = settings.shortcuts.capture;
  $("#sc-problems").textContent = settings.shortcutProblems.join(". ");
  $("#server-note").textContent = settings.serverNote;
  $("#version").textContent = `Recast ${settings.version}`;
  $("#hint-capture").textContent = pretty(settings.shortcuts.capture);
  if (!$("#status").textContent || $("#status").textContent!.startsWith("Select text anywhere")) $("#status").textContent = idleHint();
  if (settings.platform === "darwin" && !settings.grabReady) needPermission = true;
  $("#hint-open").textContent = pretty(settings.shortcuts.open);
}

// ---- start -----------------------------------------------------------------------------------------------------------------
if (MAC) document.body.classList.add("mac");
const style = document.createElement("style"); style.textContent = CLAY_CSS + GLASS_CSS; document.head.appendChild(style);
$("#dictate").textContent = MAC ? "Press Fn (or 🌐) twice to dictate" : navigator.userAgent.includes("Windows") ? "Press Win+H to dictate" : "Type, or paste";
addEventListener("resize", () => render());
void (async () => {
  const b = await api.boot();
  settings = b.settings; setTheme(b.theme); renderSettings();
  if (b.inbox && typeof b.inbox === "object" && Array.isArray((b.inbox as ClumpState).desk)) state = recover(b.inbox);
  state = { ...state, armed: true, destinations: await destinations() };
  render();
  // Connections can change in the Connections window: look again when Recast comes back to the front.
  addEventListener("focus", async () => { state = { ...state, destinations: await destinations() }; render(); });
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
