// The clay layer inside one tab. Injected only where the person invoked Recast (activeTab), so it never runs on a page
// uninvited. It recognises pieces on the page (Alt + drag a name, a place or a time), shows your objects in a small tray,
// and talks to the service worker, which holds the one shared state. The object you carry is not tied to a tab: in any tab
// you bring Recast into, it appears "in hand" in the tray, ready to be dragged onto something there.
// A tab cannot follow the pointer while another tab is in front, so carrying across tabs is: switch tabs, then pick the
// object up from the tray. Everything else (merging, reviewing, placing) is the same as on a single page.
import { commit, InMemoryEventLog, OutcomeUnknownError, newClump, canMerge, undo as coreUndo, type CapabilityContract, type Fragment, type Operation, type Receipt } from "@recast/core";
import { viewOf, type ClumpEffect, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
import { classifyElement, classifyPiece } from "@recast/extract-web";
import { CLAY_CSS, createClay, type ClayItem } from "@recast/overlay/src/clay";
import type { EventInput, ToBackground, ToTab } from "./clay-messages.js";

declare global { interface Window { __recastClay?: boolean } }

const send = <T = { state: ClumpState; error?: string }>(m: ToBackground) => chrome.runtime.sendMessage(m) as Promise<T>;

const CONTRACTS: Record<string, CapabilityContract> = {
  calendar: { destination: "page.calendar", app: "Calendar", targetKind: "Calendar", reliability: "structured-interface", accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title", "Event.start", "Event.end", "Event.location", "Event.timezone", "Event.description"] }] },
  drafts: { destination: "page.drafts", app: "Mail", targetKind: "Drafts", reliability: "structured-interface", accepts: [{ relationId: "message-draft-entry", effect: "Save as draft", dataMoved: ["Message.to", "Message.snippet"] }] },
};

const TRAY_CSS = `
:host { all: initial; }
.tray { position: fixed; right: 16px; bottom: 16px; width: 300px; max-height: 60vh; overflow: auto; pointer-events: auto; background: rgba(250,249,246,.94); border: 1px solid #e6e2da; border-radius: 16px; box-shadow: 0 18px 40px rgba(0,0,0,.16); padding: 10px 12px; font: 13px/1.4 system-ui, sans-serif; color: #1a1a1a; }
.tray h2 { margin: 0; font: 600 12px/1.3 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #625f5a; }
.tray .hint { margin: 4px 0 0; min-height: 1em; }
.tray .slots { position: relative; }
.sheet { position: fixed; right: 16px; top: 16px; width: 320px; max-height: 70vh; overflow: auto; pointer-events: auto; background: #fff; color: #1a1a1a; border: 1px solid #e6e2da; border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.2); padding: 16px; font: 14px/1.45 system-ui, sans-serif; display: flex; flex-direction: column; gap: 10px; }
.sheet[hidden] { display: none; }
.sheet h2 { margin: 0; font-size: 18px; }
.sheet ul { margin: 0; padding-left: 18px; }
.sheet .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.sheet button { border: 0; border-radius: 999px; padding: 8px 14px; background: #1a1a1a; color: #fff; font: 600 13px system-ui, sans-serif; cursor: pointer; }
.sheet button.ghost { background: transparent; color: #1a1a1a; box-shadow: inset 0 0 0 1px #d6d2ca; }
.sheet input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d6d2ca; border-radius: 8px; font: inherit; }
.clay-host { position: fixed; inset: 0; pointer-events: none; }
@media (prefers-color-scheme: dark) { .tray { background: rgba(29,27,25,.94); border-color: #34302b; color: #f3f1ec; } .tray h2 { color: #b0aba3; } .sheet { background: #1d1b19; color: #f3f1ec; border-color: #34302b; } .sheet button { background: #f3f1ec; color: #1a1a1a; } .sheet button.ghost { color: #f3f1ec; box-shadow: inset 0 0 0 1px #46413a; } .sheet input { background: #141311; color: #f3f1ec; border-color: #46413a; } }
`;

async function main() {
  const host = document.createElement("recast-clay");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CLAY_CSS}${TRAY_CSS}</style><div class="clay"></div>
    <section class="tray" aria-label="Your Recast objects"><h2>Your objects</h2><p class="hint" role="status" aria-live="polite"></p><div class="slots"></div></section>
    <section class="sheet" role="dialog" aria-label="Recast" hidden></section>`;
  document.documentElement.appendChild(host);
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => shadow.querySelector<T>(s)!;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  let state!: ClumpState; let myTab = -1;
  let localCarry = false;                         // the pointer in THIS tab is holding the carried object
  let pointer = { x: 0, y: 0 };
  let pageTarget: { el: Element; fragment: Fragment } | null = null;
  let iDropped = false;
  const log = new InMemoryEventLog();

  const clay = createClay($(".clay"), { onPointerDown: (id, e) => pressObject(id, e) });

  async function dispatch(event: EventInput) {
    const r = await send({ type: "dispatch", event });
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
      const contract = CONTRACTS[el.dataset["recastKind"] ?? ""]; if (!contract) return [];
      const slots = [...el.querySelectorAll<HTMLElement>("[data-recast-slot]")].map((s) => ({ id: s.dataset["recastSlot"]!, label: s.textContent!.trim().slice(0, 80), ...(s.dataset["start"] ? { start: s.dataset["start"] } : {}) }));
      return [{ id: el.dataset["recastDest"]!, label: el.dataset["recastLabel"] ?? contract.app, contract, ...(slots.length ? { slots } : {}) }];
    });
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------
  function render() {
    const tray = $(".slots").getBoundingClientRect(); const items: ClayItem[] = [];
    let y = tray.y + 26;
    const carriedHere = state.carried && localCarry;
    if (state.carried && !carriedHere) { items.push(item(state.carried, tray.x + tray.width / 2, y, "carried")); y += 60; }
    for (const id of state.desk) { const v = state.target?.kind === "object" && state.target.id === id ? (state.verdict?.ok ? "accepts" : "refuses") : "rest"; items.push(item(id, tray.x + tray.width / 2, y, v)); y += 58; }
    if (carriedHere) items.push(item(state.carried!, pointer.x, pointer.y, "carried"));
    $(".slots").style.height = `${Math.max(40, y - tray.y - 20)}px`;
    clay.update(items);
    for (const it of items) { const l = clay.label(it.id)!; l.tabIndex = 0; l.setAttribute("role", "button"); }
    if (!state.carried && !state.desk.length) hint("Hold Alt and drag a name, place or time to pick it up.");
    else if (state.carried && !localCarry) hint(`In hand: ${viewOf(state, state.carried).label}. Drag it onto something on this page.`);
    else if (state.last) hint(state.last.text);
    renderSheet();
  }
  function item(id: string, x: number, y: number, mode: ClayItem["mode"]): ClayItem {
    const v = viewOf(state, id); const f = state.objects[id]!.ingredients[0]!;
    const kind: ClayItem["kind"] = v.type === "Event" ? "event" : v.type === "Message" ? "message" : v.type === "People" ? "people" : f.kind;
    return { id, x, y, label: v.label, detail: v.type === "Fragment" ? v.summary[0]! : v.summary.join(" · "), count: state.objects[id]!.ingredients.length, kind, mode, proposed: v.proposed };
  }

  function renderSheet() {
    const sheet = $(".sheet"); let html = "";
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const mine = state.placement && state.placement.destinationId.startsWith(`${myTab}:`);
    if (state.phase === "inspecting" && state.inspecting && document.visibilityState === "visible" && inspectHere) {
      const c = state.objects[state.inspecting]!; const v = viewOf(state, state.inspecting);
      html = `<h2>${esc(v.label)}</h2><ul>${c.ingredients.map((f) => `<li>${esc(f.kind)}: ${esc(f.text)} <small>from ${esc(f.source?.title ?? f.source?.url ?? "")}</small>${c.ingredients.length > 1 ? ` <button class="ghost" data-remove="${esc(f.id)}">Take out</button>` : ""}</li>`).join("")}</ul><div class="row"><button data-act="close">Done</button></div>`;
    } else if (mine && ["previewing", "executing", "succeeded", "failed", "unknown"].includes(state.phase)) {
      const p = state.placement!; const v = viewOf(state, p.objectId);
      html = `<h2>${state.phase === "previewing" ? "Add it?" : state.phase === "succeeded" ? "Added" : state.phase === "executing" ? "Adding…" : state.phase === "unknown" ? "No answer" : "Not added"}</h2><p>${esc(v.label)}</p>`;
      for (const m of v.missing) html += `<div><strong>${esc(m.field)}</strong>: ${esc(m.reason)}<div class="row">${(m.suggestions ?? []).map((s) => `<button class="ghost" data-answer="${m.field}" data-value="${esc(s)}">Use “${esc(s)}”</button>`).join("")}<input data-field="${m.field}" aria-label="${esc(m.field)}"><button class="ghost" data-set="${m.field}">Set</button></div></div>`;
      if (state.phase === "previewing") html += `<div class="row">${p.op ? `<button data-act="place">${esc(p.op.proposal.effect)}</button>` : ""}<button class="ghost" data-act="cancel">Not now</button></div>`;
      if (state.phase === "succeeded") html += `<div class="row">${p.undoable ? `<button class="ghost" data-act="undo">Undo</button>` : ""}<button data-act="dismiss">Done</button></div>`;
      if (state.phase === "unknown") html += `<p>${esc(p.message ?? "")}. Recast will ask, not send it again.</p><div class="row"><button data-act="reconcile">Check</button></div>`;
    }
    if (sheet.dataset["html"] !== html) { sheet.innerHTML = html; sheet.dataset["html"] = html; }
    sheet.hidden = !html;
  }
  let inspectHere = false;
  $(".sheet").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button"); if (!b) return;
    const id = state.placement?.objectId ?? state.inspecting!;
    if (b.dataset["answer"]) void dispatch({ type: "answer", objectId: id, field: b.dataset["answer"] as never, value: b.dataset["value"]! });
    else if (b.dataset["set"]) { const v = (shadow.querySelector<HTMLInputElement>(`input[data-field="${b.dataset["set"]}"]`)!).value.trim(); if (v) void dispatch({ type: "answer", objectId: id, field: b.dataset["set"] as never, value: v }); }
    else if (b.dataset["remove"]) void dispatch({ type: "remove", objectId: id, ingredientId: b.dataset["remove"] });
    else switch (b.dataset["act"]) {
      case "place": void dispatch({ type: "place", consent: { kind: "confirm" } }); break;
      case "cancel": void dispatch({ type: "cancel" }); break;
      case "undo": void dispatch({ type: "undo" }); break;
      case "dismiss": void dispatch({ type: "dismiss" }); break;
      case "reconcile": void dispatch({ type: "reconcile" }); break;
      case "close": inspectHere = false; void dispatch({ type: "inspect", id: null }); break;
    }
  });

  // ---- pointer ---------------------------------------------------------------------------------------------------------
  let press: { id: string; x: number; y: number; started: boolean } | null = null;
  function pressObject(id: string, e: PointerEvent) {
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
    if (!e.altKey || e.composedPath().includes(host) || state.carried) return;
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
    if (press && !press.started) { const id = press.id; press = null; if (state.carried === id) return; inspectHere = true; await dispatch({ type: "inspect", id }); return; }
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
  addEventListener("keydown", (e) => { if (e.key === "Escape" && (state.carried || state.phase === "previewing" || state.phase === "inspecting")) { localCarry = false; void dispatch({ type: "cancel" }); } }, true);

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
      describe: () => CONTRACTS[el.dataset["recastKind"]!]!,
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
  });
  const first = await send<{ state: ClumpState; tabId: number }>({ type: "get" });
  state = first.state; myTab = first.tabId;
  const dests = destinations(); if (dests.length) state = (await send({ type: "destinations", destinations: dests })).state;
  addEventListener("resize", render); document.addEventListener("visibilitychange", render);
  render();
  (window as unknown as { recastClayTab: unknown }).recastClayTab = { get state() { return state; }, host };
}

if (!window.__recastClay) { window.__recastClay = true; void main(); }
