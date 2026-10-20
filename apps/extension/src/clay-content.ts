// The clay layer inside one tab. Injected only where the person invoked Recast (activeTab), so it never runs on a page
// uninvited, and inert while Recast is off. With Recast on it recognises pieces on the page (Alt + drag a name, a place or
// a time), keeps your loose pieces on a small shelf, and shows the glass action module when two things have been pressed
// together. It talks to the service worker, which holds the one shared state, so the object you carry is not tied to a tab:
// in any tab you bring Recast into it is "in hand" on the shelf, ready to be dragged onto something there.
// A tab cannot follow the pointer while another tab is in front, so carrying across tabs is: switch tabs, then pick the
// object up from the shelf. Everything else (merging, choosing, reviewing, placing) is the same as on a single page.
import { commit, InMemoryEventLog, OutcomeUnknownError, newClump, canMerge, undo as coreUndo, type CapabilityContract, type Fragment, type Operation, type Receipt } from "@recast/core";
import { CONTRACTS, REGISTRY } from "@recast/bridges/src/contracts";
import { createDoubleTap, escapeEvent, moduleModel, viewOf, type ClumpEffect, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
import { classifyElement, classifyPiece } from "@recast/extract-web";
import { CLAY_CSS, createClay, type ClayItem } from "@recast/overlay/src/clay";
import { createGlass, GLASS_CSS, intentEvents } from "@recast/overlay/src/glass";
import type { EventInput, ToBackground, ToTab } from "./clay-messages.js";

declare global { interface Window { __recastClay?: boolean } }

const send = <T = { state: ClumpState; error?: string }>(m: ToBackground) => chrome.runtime.sendMessage(m) as Promise<T>;

/** A page declares a destination with data-recast-kind; it performs the registry's contract for that kind, as a stand-in. */
const KINDS: Record<string, CapabilityContract> = { calendar: CONTRACTS.googleCalendarEvent, drafts: CONTRACTS.gmailMessageDraft };

const SHELF_CSS = `
:host { all: initial; }
.tray { position: fixed; right: 16px; bottom: 16px; width: 280px; max-height: 50vh; overflow: auto; pointer-events: auto; box-sizing: border-box; padding: 10px 12px; border-radius: 18px;
  font: 13px/1.4 "Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: rgb(29, 29, 31);
  background: rgba(246, 246, 248, 0.8); -webkit-backdrop-filter: blur(28px) saturate(170%); backdrop-filter: blur(28px) saturate(170%);
  border: 0.5px solid rgba(0,0,0,.10); box-shadow: inset 0 1px 0 rgba(255,255,255,.7), 0 10px 30px rgba(0,0,0,.16); }
.tray[hidden] { display: none; }
.tray h2 { margin: 0; font-family: inherit; font-weight: 600; font-size: 11px; line-height: 1.3; letter-spacing: .06em; text-transform: uppercase; color: rgb(77, 77, 82); }
.tray .hint { margin: 4px 0 0; min-height: 1em; }
.tray .slots { position: relative; }
.clay-host { position: fixed; inset: 0; pointer-events: none; }
@media (max-width: 900px) { .tray { top: 16px; bottom: auto; width: 240px; } }
@media (prefers-color-scheme: dark) { .tray { background: rgba(28, 28, 30, 0.8); color: rgb(245, 245, 247); border-color: rgba(255,255,255,.12); box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 10px 30px rgba(0,0,0,.5); } .tray h2 { color: rgb(199, 199, 204); } }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .tray { background: rgb(242, 242, 245); } }
@media (prefers-reduced-transparency: reduce) { .tray { background: rgb(242, 242, 245); -webkit-backdrop-filter: none; backdrop-filter: none; } }
`;

async function main() {
  const host = document.createElement("recast-clay");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CLAY_CSS}${GLASS_CSS}${SHELF_CSS}</style>
    <section class="tray" aria-label="Your Recast objects" hidden><h2>Your objects</h2><p class="hint" role="status" aria-live="polite"></p><div class="slots"></div></section>
    <div class="glass"></div><div class="clay"></div>`;
  document.documentElement.appendChild(host);
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => shadow.querySelector<T>(s)!;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let state!: ClumpState; let myTab = -1;
  let localCarry = false;                         // the pointer in THIS tab is holding the carried object
  let pointer = { x: 0, y: 0 };
  let pageTarget: { el: Element; fragment: Fragment } | null = null;
  let iDropped = false;
  let error = "";
  const log = new InMemoryEventLog();

  const clay = createClay($(".clay"), { onPointerDown: (id, e) => pressObject(id, e) });
  const glass = createGlass($(".glass"), {
    onIntent: async (i) => { for (const e of intentEvents(i, state)) { const r = await dispatch(e); state = r.state; } render(); if (["reopen", "openWheel", "pick", "inspect"].includes(i.type)) setTimeout(() => glass.focus(), 0); },
    onLayout: () => requestAnimationFrame(() => render()),
    shortcut: /Mac/.test(navigator.platform) ? "⌃ ⌃" : "Ctrl Ctrl",
  });

  async function dispatch(event: EventInput) {
    const r = await send({ type: "dispatch", event });
    error = r.error ?? "";
    if (r.error) hint(r.error.charAt(0).toUpperCase() + r.error.slice(1));
    return r;
  }
  function hint(t: string) { $(".hint").textContent = t; }

  // ---- what is on this page --------------------------------------------------------------------------------------
  let seq = 0;
  function fragmentAt(el: Element): Fragment | null {
    const opts = { url: location.href, now: new Date().toISOString(), timezone: tz };
    const source = { app: location.hostname || "page", url: location.href, ...(document.title ? { title: document.title.slice(0, 200) } : {}) };
    const person = classifyElement(el, opts).find((c) => c.type === "Person" && typeof c.properties["name"] === "string");
    if (person) {
      const name = person.properties["name"] as string; const email = typeof person.properties["email"] === "string" ? person.properties["email"] as string : undefined;
      return { id: `p${++seq}-${Date.now()}`, kind: "person", text: name, value: { name, ...(email ? { email } : {}) }, confidence: Math.min(...Object.values(person.fields).map((f) => f.confidence)), evidence: person.fields["name"]!.evidence, source };
    }
    const piece = classifyPiece(el, opts);
    if (piece) return { ...piece, id: `${piece.id}#${++seq}` };
    const sel = getSelection()?.toString().replace(/\s+/g, " ").trim();
    if (sel && sel.length <= 300) return { id: `t${++seq}-${Date.now()}`, kind: "text", text: sel, confidence: 0.9, evidence: [{ locator: { kind: "user", value: "selection" }, excerpt: sel.slice(0, 200) }], source };
    return null;
  }

  function destinations(): DestinationSpec[] {
    return [...document.querySelectorAll<HTMLElement>("[data-recast-dest]")].flatMap((el) => {
      const contract = KINDS[el.dataset["recastKind"] ?? ""]; if (!contract) return [];
      const slots = [...el.querySelectorAll<HTMLElement>("[data-recast-slot]")].map((s) => ({ id: s.dataset["recastSlot"]!, label: s.textContent!.trim().slice(0, 80), ...(s.dataset["start"] ? { start: s.dataset["start"] } : {}) }));
      // The page performs the registry's contract itself: a stand-in for the provider, and said so in the module.
      return [{ id: el.dataset["recastDest"]!, label: el.dataset["recastLabel"] ?? contract.app, contract, standIn: true, ...(slots.length ? { slots } : {}) }];
    });
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------
  function render() {
    glass.update(moduleModel(state, REGISTRY), error && !state.carried ? { error } : {});
    const well = glass.well();
    const inModule = state.placement?.objectId ?? state.inspecting ?? state.focus;
    const inWell = well && inModule && state.desk.includes(inModule) && state.carried !== inModule ? inModule : null;
    const tray = $(".tray"); const shelf = state.desk.filter((id) => id !== inWell);
    const carriedHere = state.carried && localCarry;
    tray.hidden = !state.armed || (!shelf.length && !(state.carried && !carriedHere));
    const items: ClayItem[] = [];
    if (!tray.hidden) {
      const box = $(".slots").getBoundingClientRect(); let y = box.y + 26;
      if (state.carried && !carriedHere) { items.push(item(state.carried, box.x + box.width / 2, y, "carried")); y += 60; }
      for (const id of shelf) { items.push(item(id, box.x + box.width / 2, y, targetMode(id))); y += 58; }
      $(".slots").style.height = `${Math.max(40, y - box.y - 20)}px`;
    }
    if (inWell && well) items.push(item(inWell, well.x, well.y, targetMode(inWell), true));
    if (carriedHere) items.push(item(state.carried!, pointer.x, pointer.y, "carried"));
    clay.update(state.armed ? items : []);
    for (const it of items) { const l = clay.label(it.id); if (l) { l.tabIndex = 0; l.setAttribute("role", "button"); } }
    if (state.carried && !localCarry) hint(`In hand: ${viewOf(state, state.carried).label}. Drag it onto something on this page.`);
    else if (!error && state.last) hint(state.last.text);
  }
  const targetMode = (id: string): ClayItem["mode"] => (state.target?.kind === "object" && state.target.id === id ? (state.verdict?.ok ? "accepts" : "refuses") : "rest");
  function item(id: string, x: number, y: number, mode: ClayItem["mode"], inWell = false): ClayItem {
    const v = viewOf(state, id); const f = state.objects[id]!.ingredients[0]!;
    const kind: ClayItem["kind"] = v.type === "Event" ? "event" : v.type === "Message" ? "message" : v.type === "People" ? "people" : f.kind;
    return { id, x, y, label: v.label, ...(inWell && glass.el.dataset["mode"] === "choosing" && innerWidth > 520 ? { compact: true } : {}), ...(inWell ? {} : { detail: v.type === "Fragment" ? v.summary[0]! : v.summary.join(" · ") }), count: state.objects[id]!.ingredients.length, kind, mode, proposed: v.proposed };
  }

  // ---- pointer ---------------------------------------------------------------------------------------------------------
  let press: { id: string; x: number; y: number; started: boolean } | null = null;
  function pressObject(id: string, e: PointerEvent) {
    if (!state.armed) return;
    e.preventDefault(); pointer = { x: e.clientX, y: e.clientY };
    press = { id, x: e.clientX, y: e.clientY, started: false };
  }
  async function begin() {
    const id = press!.id; press!.started = true;
    if (state.carried === id) { localCarry = true; render(); return; }          // the object already in hand, from another tab
    if (state.phase === "inspecting") await dispatch({ type: "inspect", id: null });
    const r = await dispatch({ type: "pickUp", id }); if (!r.error) { localCarry = true; state = r.state; render(); }
  }
  addEventListener("pointerdown", async (e) => {
    // Off, or without Alt: the page gets the pointer, so selecting text and dragging work as usual.
    if (!state.armed || !e.altKey || e.composedPath().includes(host) || state.carried) return;
    const f = fragmentAt(e.target as Element); if (!f) { hint("Recast does not recognise that as a person, place, time or title. Select the words and try again."); return; }
    e.preventDefault(); e.stopPropagation(); pointer = { x: e.clientX, y: e.clientY };
    const r = await dispatch({ type: "capture", fragment: f, carry: true }); state = r.state; localCarry = true; render();
  }, true);
  addEventListener("pointermove", (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (press && !press.started && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) void begin();
    if (localCarry && state.carried) { void hitTest(); render(); }
  }, true);
  addEventListener("pointerup", async () => {
    if (press && !press.started) { const id = press.id; press = null; if (state.carried === id) return; await dispatch({ type: "inspect", id }); return; }
    press = null;
    if (!localCarry || !state.carried) return;
    await hitTest(); localCarry = false;
    if (pageTarget) {
      const { fragment } = pageTarget; pageTarget = null;
      const ok = canMerge(newClump("page", fragment), state.objects[state.carried]!);
      if (!ok.ok) { await dispatch({ type: "approach", target: null }); await dispatch({ type: "drop" }); hint(`Kept apart: ${ok.reason}`); return; }
      const cap = await dispatch({ type: "capture", fragment, carry: false });
      const id = `obj-${cap.state.seq}`;
      await dispatch({ type: "approach", target: { kind: "object", id } });
    }
    iDropped = true; await dispatch({ type: "drop" });
  }, true);
  // Control twice: the Recast command, here. (Bringing Recast into a new tab still needs the toolbar or Alt+Shift+R:
  // an extension cannot listen on pages it was not invited into without access to every site.)
  const doubleTap = createDoubleTap();
  addEventListener("keydown", (e) => { if (doubleTap({ type: "keydown", key: e.key, repeat: e.repeat, at: e.timeStamp })) void send({ type: "command" }); }, true);
  addEventListener("keyup", (e) => { if (doubleTap({ type: "keyup", key: e.key, at: e.timeStamp })) void send({ type: "command" }); }, true);
  addEventListener("pointerdown", (e) => { doubleTap({ type: "pointerdown", at: e.timeStamp }); }, true);
  addEventListener("blur", (e) => { doubleTap({ type: "blur", at: e.timeStamp }); });
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state) return;
    const ev = escapeEvent(state); if (!ev) return;
    e.preventDefault(); localCarry = false; const wasOpen = glass.well() !== null;
    void dispatch(ev).then((r) => { state = r.state; render(); if (wasOpen && glass.well()) glass.focus(); });
  }, true);

  let lastTargetKey = "";
  async function hitTest() {
    let target: Target | null = null; pageTarget = null;
    for (const id of state.desk) { const b = clay.box(id); if (b && Math.abs(b.x - pointer.x) < b.w / 2 && Math.abs(b.y - pointer.y) < b.h / 2 + 6) { target = { kind: "object", id }; break; } }
    if (!target) {
      const under = document.elementsFromPoint(pointer.x, pointer.y).filter((el) => el !== host);
      const dest = under.map((el) => el.closest<HTMLElement>("[data-recast-dest]")).find(Boolean);
      if (dest) { const slot = under.map((el) => el.closest<HTMLElement>("[data-recast-slot]")).find(Boolean); target = { kind: "destination", id: `${myTab}:${dest.dataset["recastDest"]}`, ...(slot ? { slot: slot.dataset["recastSlot"]! } : {}) }; }
      else if (under[0]) { const f = fragmentAt(under[0]); if (f) pageTarget = { el: under[0], fragment: f }; }
    }
    const key = JSON.stringify(target);
    if (key !== lastTargetKey) { lastTargetKey = key; const r = await dispatch({ type: "approach", target }); state = r.state; }
  }

  // ---- effects for destinations on this page -----------------------------------------------------------------------
  const bridgeFor = (destId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-recast-dest="${CSS.escape(destId)}"]`)!;
    const list = () => el.querySelector("[data-recast-list]") ?? el;
    return {
      describe: () => KINDS[el.dataset["recastKind"]!]!,
      async execute(op: Operation) {
        const li = document.createElement("li"); li.dataset["placed"] = op.proposal.relationId; li.id = `recast-${op.opId}`;
        li.textContent = op.dataMoved.filter((d) => ["Event.title", "Event.start", "Event.location", "Message.to", "Message.snippet"].includes(d.path)).map((d) => d.value).join(" · ");
        list().appendChild(li);
        if (el.dataset["recastSilent"] === "true") throw new OutcomeUnknownError(`${el.dataset["recastLabel"] ?? "The page"} did not answer in time`, li.id);
        return { ref: li.id };
      },
      async undo(r: Receipt) { document.getElementById(r.bridgeRef ?? "")?.remove(); },
    };
  };
  async function perform(eff: ClumpEffect) {
    const destId = eff.destinationId.split(":").slice(1).join(":"); const bridge = bridgeFor(destId); const now = () => new Date().toISOString();
    if (eff.type === "commit") {
      try { const receipt = await commit(eff.op, eff.consent, { bridge, log, now }); await dispatch({ type: "committed", receipt, undoable: receipt.reversible }); }
      catch (e) { await dispatch(e instanceof OutcomeUnknownError ? { type: "outcomeUnknown", message: e.message } : { type: "commitFailed", message: e instanceof Error ? e.message : String(e) }); }
    } else if (eff.type === "reconcile") {
      const ref = `recast-${eff.op.opId}`;
      if (document.getElementById(ref)) {
        const receipt: Receipt = { receiptId: `rc-${eff.op.opId}`, opId: eff.op.opId, at: now(), status: "done", objectId: eff.op.proposal.object.id, destination: eff.op.proposal.destination.destination, relationId: eff.op.proposal.relationId, effect: eff.op.proposal.effect, reversible: eff.op.proposal.reversible, bridgeRef: ref };
        await log.append({ kind: "commit", at: receipt.at, receipt }); await dispatch({ type: "reconciled", found: true, receipt });
      } else await dispatch({ type: "reconciled", found: false });
    } else if (eff.type === "undo") { await coreUndo(eff.receipt, { bridge, log, now }); await dispatch({ type: "undone" }); }
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg: ToTab) => {
    if (msg.type === "state") {
      const before = state; state = msg.state;
      if (state.phase === "merging" && before?.phase !== "merging" && iDropped) { iDropped = false; const m = state.merging!; void clay.fuse(m.id, m.incomingId).then(() => dispatch({ type: "settled" })); }
      else if (state.phase !== "merging") iDropped = false;
      if (!state.carried) localCarry = false;
      render();
    } else if (msg.type === "effect") void perform(msg.effect);
    else if (msg.type === "focus") glass.focus();
  });
  const first = await send<{ state: ClumpState; tabId: number }>({ type: "get" });
  state = first.state; myTab = first.tabId;
  const dests = destinations(); if (dests.length) state = (await send({ type: "destinations", destinations: dests })).state;
  addEventListener("resize", render); document.addEventListener("visibilitychange", render);
  render();
}

if (!window.__recastClay) { window.__recastClay = true; void main(); }
