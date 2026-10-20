// Recast's service worker: the one place the clump state lives while you move between tabs.
// The state machine is pure (packages/interaction), so the worker only loads it, applies an event, saves it and tells every
// tab that has the clay layer. State lives in chrome.storage.session: it survives the worker being stopped and restarted,
// is kept in memory by the browser (never written to disk), and is gone when the browser closes.
import { initialClumpState, reduceClump, type ClumpEffect, type ClumpState, type DestinationSpec } from "@recast/interaction";
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
function apply(mutate: (s: ClumpState) => { state: ClumpState; effects?: ClumpEffect[]; error?: string }): Promise<{ state: ClumpState; error?: string }> {
  const run = queue.then(async () => {
    const r = mutate(await load());
    await save(r.state); await broadcast(r.state);
    // An effect (commit, undo, reconcile) runs in the tab that holds the destination: only that page can write to itself.
    for (const e of r.effects ?? []) { const [tabId] = e.destinationId.split(":"); await tell(Number(tabId), { type: "effect", effect: e }); }
    return { state: r.state, ...(r.error ? { error: r.error } : {}) };
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Put the clay layer into a tab. Only possible where the person invoked Recast (activeTab), or in the test build. */
async function activate(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["clay-content.js"] });
  await setTabs([...(await tabs()), tabId]);
  await tell(tabId, { type: "state", state: await load() });
}

chrome.runtime.onMessage.addListener((msg: ToBackground, sender, reply) => {
  const tabId = sender.tab?.id;
  if (msg.type === "get") { void load().then((state) => reply({ state, tabId })); return true; }
  if (msg.type === "dispatch") { void apply((s) => reduceClump(s, { ...msg.event, now: Date.now() } as never)).then(reply); return true; }
  if (msg.type === "destinations" && tabId !== undefined) {
    // Destination ids carry their tab, so an effect goes back to the page that can perform it.
    const mine: DestinationSpec[] = msg.destinations.map((d) => ({ ...d, id: `${tabId}:${d.id}` }));
    void apply((s) => ({ state: { ...s, destinations: [...s.destinations.filter((d) => !d.id.startsWith(`${tabId}:`)), ...mine] } })).then(reply); return true;
  }
  if (msg.type === "activate") { void activate(msg.tabId).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) })); return true; }
  return false;
});

chrome.commands?.onCommand.addListener((command, tab) => { if (command === "recast-clay" && tab?.id !== undefined) void activate(tab.id); });

// A closed or reloaded tab takes its destinations with it. Objects you made stay: they never belonged to a tab.
async function forget(tabId: number) {
  await setTabs((await tabs()).filter((t) => t !== tabId));
  await apply((s) => {
    const destinations = s.destinations.filter((d) => !d.id.startsWith(`${tabId}:`));
    const reviewingThere = s.phase === "previewing" && s.placement?.destinationId.startsWith(`${tabId}:`);
    const next = { ...s, destinations };
    return reviewingThere ? reduceClump(next, { type: "cancel", now: Date.now() }) : { state: next };
  });
}
chrome.tabs.onRemoved.addListener((tabId) => { void forget(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === "loading") void forget(tabId); });

// For tests and for debugging from the worker's console.
(globalThis as unknown as { recastClay: unknown }).recastClay = { load, activate, tabs };
