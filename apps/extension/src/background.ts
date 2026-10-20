// Recast's service worker: the one place the clump state lives while you move between tabs.
// The state machine is pure (packages/interaction), so the worker only loads it, applies an event, saves it and tells every
// tab that has the clay layer. State lives in chrome.storage.session: it survives the worker being stopped and restarted,
// is kept in memory by the browser (never written to disk), and is gone when the browser closes.
import { commandEvents, initialClumpState, reduceClump, type ClumpEffect, type ClumpState, type DestinationSpec } from "@recast/interaction";
import type { ToBackground, ToTab } from "./clay-messages.js";

const KEY = "clay", TABS = "clayTabs";

async function load(): Promise<ClumpState> {
  const r = await chrome.storage.session.get(KEY);
  return (r[KEY] as ClumpState | undefined) ?? initialClumpState({ now: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}
const save = (s: ClumpState) => chrome.storage.session.set({ [KEY]: s });
async function tabs(): Promise<number[]> { return ((await chrome.storage.session.get(TABS))[TABS] as number[] | undefined) ?? []; }
const setTabs = (t: number[]) => chrome.storage.session.set({ [TABS]: [...new Set(t)] });

async function tell(tabId: number, msg: ToTab) { try { await chrome.tabs.sendMessage(tabId, msg); } catch { /* the tab navigated away or closed: it has no layer any more */ } }
async function broadcast(s: ClumpState) { for (const t of await tabs()) await tell(t, { type: "state", state: s }); }

/** Events are applied one at a time, in order, even when several tabs send at once. */
let queue: Promise<unknown> = Promise.resolve();
function apply(mutate: (s: ClumpState) => { state: ClumpState; effects?: ClumpEffect[]; error?: string; stale?: true }): Promise<{ state: ClumpState; error?: string; stale?: true }> {
  const run = queue.then(async () => {
    const before = await load(); const r = mutate(before);
    await save(r.state); await broadcast(r.state);
    // An effect (commit, undo, reconcile) runs in the tab that holds the destination: only that page can write to itself.
    for (const e of r.effects ?? []) { const [tabId] = e.destinationId.split(":"); await tell(Number(tabId), { type: "effect", effect: e }); }
    // Chosen in the module while looking at another tab: bring the destination's tab to the front, so the review and the
    // write happen where the person can see them.
    if (r.state.phase === "previewing" && r.state.placement?.via === "module" && (before.phase !== "previewing")) {
      const tabId = Number(r.state.placement.destinationId.split(":")[0]);
      try { const t = await chrome.tabs.update(tabId, { active: true }); if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true }); } catch { /* the tab is gone; the review still shows */ }
    }
    return { state: r.state, ...(r.error ? { error: r.error } : {}), ...(r.stale ? { stale: true as const } : {}) };
  });
  queue = run.catch(() => undefined);
  return run;
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

// For tests and for debugging from the worker's console.
(globalThis as unknown as { recastClay: unknown }).recastClay = { load, activate, invoke, tabs };
