// Recast's service worker: the one place the clump state lives while you move between tabs.
// The state machine is pure (packages/interaction), so the worker only loads it, applies an event, saves it and tells every
// tab that has the clay layer. State lives in chrome.storage.session: it survives the worker being stopped and restarted,
// is kept in memory by the browser (never written to disk), and is gone when the browser closes.
import { commandEvents, initialClumpState, reduceClump, type ClumpEffect, type ClumpState, type ConfirmLevel, type DestinationSpec } from "@recast/interaction";
import type { ToBackground, ToTab } from "./clay-messages.js";
import { CONTRACTS } from "@recast/bridges/src/contracts";
import { googleMapsDirections, LinkBridge } from "@recast/bridges/src/links";
import { commit, InMemoryEventLog } from "@recast/core";

const KEY = "clay", TABS = "clayTabs";
/** The one thing kept across browser restarts: how much Recast asks (D24). A setting, never page content. */
const CONFIRM = "confirmLevel";
async function confirmLevel(): Promise<ConfirmLevel | undefined> { const v = (await chrome.storage.local.get(CONFIRM))[CONFIRM]; return v === "none" || v === "high" ? v : undefined; }

async function load(): Promise<ClumpState> {
  const r = await chrome.storage.session.get(KEY);
  const level = await confirmLevel();
  // Dates are read where the person is now: a session started before a flight or a system change follows the new zone.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const kept = r[KEY] as ClumpState | undefined;
  if (!kept) return initialClumpState({ now: Date.now(), timezone, destinations: [mapsDest], ...(level ? { confirm: level } : {}) });
  return kept.timezone === timezone ? kept : reduceClump(kept, { type: "setTimezone", timezone, now: Date.now() }).state;
}
const save = (s: ClumpState) => chrome.storage.session.set({ [KEY]: s });
async function tabs(): Promise<number[]> { return ((await chrome.storage.session.get(TABS))[TABS] as number[] | undefined) ?? []; }
const setTabs = (t: number[]) => chrome.storage.session.set({ [TABS]: [...new Set(t)] });

async function tell(tabId: number, msg: ToTab) { try { await chrome.tabs.sendMessage(tabId, msg); } catch { /* the tab navigated away or closed: it has no layer any more */ } }
async function broadcast(s: ClumpState) { for (const t of await tabs()) await tell(t, { type: "state", state: s }); }

/** Events are applied one at a time, in order, even when several tabs send at once. */
let queue: Promise<unknown> = Promise.resolve();
function apply(mutate: (s: ClumpState) => { state: ClumpState; effects?: ClumpEffect[]; error?: string; stale?: true; captured?: string }): Promise<{ state: ClumpState; error?: string; stale?: true; captured?: string }> {
  const run = queue.then(async () => {
    const before = await load(); const r = mutate(before);
    await save(r.state); await broadcast(r.state);
    // An effect (commit, undo, reconcile) runs in the tab that holds the destination: only that page can write to itself.
    // The real Google Calendar is not a tab: its effects go to the Recast program on this computer (not awaited here,
    // since the answer comes back through this same queue).
    for (const e of r.effects ?? []) {
      if (isLink(e.destinationId)) { void viaLink(e); continue; }
      if (e.destinationId === MAPS) { void opened(e); continue; }
      const [tabId] = e.destinationId.split(":"); await tell(Number(tabId), { type: "effect", effect: e });
    }
    // Chosen in the module while looking at another tab: bring the destination's tab to the front, so the review and the
    // write happen where the person can see them.
    if (r.state.phase === "previewing" && r.state.placement?.via === "module" && (before.phase !== "previewing") && !isLink(r.state.placement.destinationId) && r.state.placement.destinationId !== MAPS) {
      const tabId = Number(r.state.placement.destinationId.split(":")[0]);
      try { const t = await chrome.tabs.update(tabId, { active: true }); if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true }); } catch { /* the tab is gone; the review still shows */ }
    }
    return { state: r.state, ...(r.error ? { error: r.error } : {}), ...(r.stale ? { stale: true as const } : {}), ...("captured" in r && r.captured ? { captured: r.captured as string } : {}) };
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---- the real Google Calendar (and Gmail drafts, Google Tasks), through the Recast program on this computer (apps/calendar-link)
// Off unless the person connects it from the popup: that grants access to http://localhost only, and the program then
// asks the person to Allow this extension (a code shown in both places). The Google token never reaches the extension:
// the program places the reviewed operation and answers with the outcome.
export const LINK = "http://localhost:8787", LINK_ORIGINS = ["http://localhost/*"], LINK_DEST = "link:google-calendar", LINK_GMAIL = "link:gmail-drafts", LINK_TASKS = "link:google-tasks", LINK_TASKS_DUE = "link:google-tasks-due", LINK_DOCS = "link:google-docs", LINK_GITHUB = "link:github", LINK_LINEAR = "link:linear";
const linkDest: DestinationSpec = { id: LINK_DEST, label: "Google Calendar", contract: CONTRACTS.googleCalendarEvent };
const gmailDest: DestinationSpec = { id: LINK_GMAIL, label: "Gmail drafts", contract: CONTRACTS.gmailMessageDraft };
const tasksDest: DestinationSpec = { id: LINK_TASKS, label: "Google Tasks", contract: CONTRACTS.googleTasks };
const tasksDueDest: DestinationSpec = { id: LINK_TASKS_DUE, label: "Google Tasks", contract: CONTRACTS.googleTasksEntry };
const docsDest: DestinationSpec = { id: LINK_DOCS, label: "Google Docs", contract: CONTRACTS.googleDocs };
const githubDest = (repo: string): DestinationSpec => ({ id: LINK_GITHUB, label: `GitHub ${repo}`, contract: CONTRACTS.githubIssue });
const linearDest = (team: string): DestinationSpec => ({ id: LINK_LINEAR, label: `Linear ${team}`, contract: CONTRACTS.linearIssue });
const isLink = (id: string) => id === LINK_DEST || id === LINK_GMAIL || id === LINK_TASKS || id === LINK_TASKS_DUE || id === LINK_DOCS || id === LINK_GITHUB || id === LINK_LINEAR;
/** What the program calls each destination. */
const linkName = (id: string) => (id === LINK_GMAIL ? "gmail" : id === LINK_TASKS || id === LINK_TASKS_DUE ? "tasks" : id === LINK_DOCS ? "docs" : id === LINK_GITHUB ? "github" : id === LINK_LINEAR ? "linear" : "calendar");

async function link(route: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${LINK}/ext/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
/** Whether the program is reachable, this extension is allowed there, and a Google account is connected. */
async function linkStatus(): Promise<{ state: "off" | "unreachable" | "pending" | "not-signed-in" | "ready"; code?: string; gmail?: boolean; tasks?: boolean; docs?: boolean; github?: string; linear?: string }> {
  if (!(await chrome.permissions.contains({ origins: LINK_ORIGINS }))) return { state: "off" };
  try {
    const r = await link("pair");
    if (r.status === 202) return { state: "pending", code: String(r.body["code"]) };
    if (r.status !== 200) return { state: "unreachable" };
    const github = { ...(typeof r.body["github"] === "string" ? { github: r.body["github"] as string } : {}), ...(typeof r.body["linear"] === "string" ? { linear: r.body["linear"] as string } : {}) };
    // GitHub is its own connection: offered even when Google is not signed in.
    return r.body["connected"] ? { state: "ready", gmail: !!r.body["gmail"], tasks: !!r.body["tasks"], docs: !!r.body["docs"], ...github } : { state: "not-signed-in", ...github };
  } catch { return { state: "unreachable" }; }
}
/** Real Google Calendar first in the list (the wheel takes the first live destination of a kind), only while ready. */
async function syncLink() {
  const st = await linkStatus();
  await apply((s) => {
    const others = s.destinations.filter((d) => !isLink(d.id));
    const mine = [...(st.state === "ready" ? [linkDest, ...(st.gmail ? [gmailDest] : []), ...(st.tasks ? [tasksDest, tasksDueDest] : []), ...(st.docs ? [docsDest] : [])] : []), ...(st.github ? [githubDest(st.github)] : []), ...(st.linear ? [linearDest(st.linear)] : [])];
    return { state: { ...s, destinations: [...mine, ...others] } };
  });
  return st;
}
async function viaLink(e: ClumpEffect) {
  const at = () => Date.now(); const destination = linkName(e.destinationId);
  if (e.type === "commit") {
    const opId = e.op.opId;
    let r: Awaited<ReturnType<typeof link>>;
    try { r = await link("commit", { destination, op: e.op, consent: e.consent }); }
    // The request may or may not have reached Google: never assumed to have failed, checked before any retry.
    catch { await apply((s) => reduceClump(s, { type: "outcomeUnknown", opId, message: "The Recast program on this computer did not answer", now: at() })); return; }
    const b = r.body;
    if (b["outcome"] === "done") await apply((s) => reduceClump(s, { type: "committed", receipt: b["receipt"] as never, undoable: (b["receipt"] as { reversible: boolean }).reversible, now: at() }));
    else if (b["outcome"] === "unknown") await apply((s) => reduceClump(s, { type: "outcomeUnknown", opId, message: String(b["message"]), now: at() }));
    else await apply((s) => reduceClump(s, { type: "commitFailed", opId, message: String(b["message"] ?? b["error"] ?? `answered ${r.status}`), now: at() }));
  } else if (e.type === "reconcile") {
    // If the check itself cannot be made, the placement stays "unknown": the person can press Check again.
    try {
      const r = await link("reconcile", { destination, op: e.op });
      // Some providers cannot be asked (Gmail drafts): say so and stay unknown; never report "not there" on a guess.
      if (r.status === 200 && r.body["checkable"] === false) await apply((s) => ({ state: { ...s, ...(s.placement ? { placement: { ...s.placement, message: String(r.body["message"]) } } : {}), last: { kind: "unknown", text: String(r.body["message"]), at: at() } } }));
      else if (r.status === 200) await apply((s) => reduceClump(s, { type: "reconciled", opId: e.op.opId, found: !!r.body["found"], ...(r.body["receipt"] ? { receipt: r.body["receipt"] as never } : {}), now: at() }));
    } catch { /* stays unknown */ }
  } else if (e.type === "undo") {
    const opId = e.receipt.opId;
    try {
      const r = await link("undo", { destination, receipt: e.receipt });
      await apply((s) => reduceClump(s, r.body["outcome"] === "undone" ? { type: "undone", opId, now: at() } : { type: "undoFailed", opId, message: String(r.body["message"] ?? r.body["error"] ?? `answered ${r.status}`), now: at() }));
    } catch { await apply((s) => reduceClump(s, { type: "undoFailed", opId, message: "The Recast program on this computer did not answer; it may still be there", now: at() })); }
  }
}

// ---- Google Maps: open and prefill. Always available, needs no account: the review's link opens Google Maps with
// directions from the person's own click (so the browser allows the tab). Nothing is written, so nothing is checked or undone.
export const MAPS = "open:google-maps";
const mapsDest: DestinationSpec = { id: MAPS, label: "Google Maps", contract: CONTRACTS.googleMaps };
async function opened(e: ClumpEffect) {
  if (e.type !== "commit") return;
  const now = () => new Date().toISOString();
  try {
    const receipt = await commit(e.op, e.consent, { bridge: new LinkBridge(googleMapsDirections), log: new InMemoryEventLog(), now });
    await apply((s) => reduceClump(s, { type: "committed", receipt, undoable: false, now: Date.now() }));
  } catch (err) { await apply((s) => reduceClump(s, { type: "commitFailed", opId: e.op.opId, message: err instanceof Error ? err.message : String(err), now: Date.now() })); }
}

/**
 * The Recast command (Alt+Shift+R, or the button in the toolbar popup). In a tab Recast is not in yet, it brings Recast
 * there and turns it on (it never turns it off from a new tab: the person is bringing it along). In a tab it is already in:
 * on, reopen the composition, or off (commandEvents). Never a second module.
 */
async function invoke(tabId: number) {
  const fresh = !(await tabs()).includes(tabId);
  if (fresh) await activate(tabId);
  const s = await load();
  const evs = fresh && s.armed ? [] : commandEvents(s);
  for (const e of evs) await apply((st) => reduceClump(st, { ...e, now: Date.now() }));
  await tell(tabId, { type: "focus" });
}

/** Put the clay layer into a tab. Only possible where the person invoked Recast (activeTab), or in the test build. */
async function activate(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["clay-content.js"] });
  await setTabs([...(await tabs()), tabId]);
  await tell(tabId, { type: "state", state: await load() });
}

/** The popup (an extension page), never a content script: those run on web pages and report the page's URL. */
const fromExtensionPage = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));

chrome.runtime.onMessage.addListener((msg: ToBackground, sender, reply) => {
  const tabId = sender.tab?.id;
  if (msg.type === "get") { void load().then((state) => reply({ state, tabId })); return true; }
  if (msg.type === "dispatch") { void apply((s) => reduceClump(s, { ...msg.event, now: Date.now() } as never)).then(reply); return true; }
  if (msg.type === "destinations" && tabId !== undefined) {
    // Destination ids carry their tab, so an effect goes back to the page that can perform it.
    const mine: DestinationSpec[] = msg.destinations.map((d) => ({ ...d, id: `${tabId}:${d.id}` }));
    void apply((s) => ({ state: { ...s, destinations: [...s.destinations.filter((d) => !d.id.startsWith(`${tabId}:`)), ...mine] } })).then(reply); return true;
  }
  // Only the extension's own popup may invoke for a tab; a page script cannot ask Recast into another tab.
  // A content script can only run the command for its own tab (sender.tab), never name another one.
  if (msg.type === "command" && tabId !== undefined) { void invoke(tabId).then(() => reply({ ok: true })); return true; }
  if (msg.type === "invoke" && fromExtensionPage(sender)) { void invoke(msg.tabId).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) })); return true; }
  if (msg.type === "confirm" && fromExtensionPage(sender)) {
    if (msg.level === undefined) { void confirmLevel().then((level) => reply({ level })); return true; }
    if (msg.level !== "none" && msg.level !== "high") return false;
    const level = msg.level;
    void chrome.storage.local.set({ [CONFIRM]: level }).then(() => apply((s) => reduceClump(s, { type: "setConfirm", level, now: Date.now() }))).then(() => reply({ level }));
    return true;
  }
  if (msg.type === "link" && fromExtensionPage(sender)) { void syncLink().then(reply, () => reply({ state: "unreachable" })); return true; }
  if (msg.type === "activate" && fromExtensionPage(sender)) { void activate(msg.tabId).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) })); return true; }
  return false;
});

chrome.commands?.onCommand.addListener((command, tab) => { if (command === "recast-clay" && tab?.id !== undefined) void invoke(tab.id); });

// A closed or reloaded tab takes its destinations with it. Objects you made stay: they never belonged to a tab.
async function forget(tabId: number) {
  await setTabs((await tabs()).filter((t) => t !== tabId));
  await apply((s) => {
    const destinations = s.destinations.filter((d) => !d.id.startsWith(`${tabId}:`));
    const there = !!s.placement?.destinationId.startsWith(`${tabId}:`);
    const next = { ...s, destinations };
    if (!there) return { state: next };
    const label = s.destinations.find((d) => d.id === s.placement!.destinationId)?.label ?? "The destination";
    const opId = s.placement!.op?.opId ?? "";
    // A review there closes unwritten. A write or an undo in flight there can no longer answer: it is not assumed to
    // have worked or failed. A write becomes "unknown" (checked later, never resent); an undo is reported as not
    // confirmed, so the placement stands and says so.
    if (s.phase === "previewing") return reduceClump(next, { type: "cancel", now: Date.now() });
    if (s.phase === "executing") return reduceClump(next, { type: "outcomeUnknown", opId, message: `${label} closed before it answered`, now: Date.now() });
    if (s.phase === "undoing") return reduceClump(next, { type: "undoFailed", opId, message: `${label} closed before it confirmed; it may still be there`, now: Date.now() });
    return { state: next };
  });
}
chrome.tabs.onRemoved.addListener((tabId) => { void forget(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === "loading") void forget(tabId); });

// The program may have been started, stopped or signed in since: look again whenever the worker starts.
void syncLink();

// For tests and for debugging from the worker's console.
(globalThis as unknown as { recastClay: unknown }).recastClay = { load, activate, invoke, tabs, syncLink, dispatch: (e: Record<string, unknown>) => apply((s) => reduceClump(s, { ...e, now: Date.now() } as never)) };
