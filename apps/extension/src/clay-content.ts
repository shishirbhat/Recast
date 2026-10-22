// The clay layer inside one tab. Injected only where the person invoked Recast (activeTab), so it never runs on a page
// uninvited, and inert while Recast is off. With Recast on it recognises pieces on the page (Alt + drag a name, a place or
// a time), keeps your loose pieces on a small shelf, and shows the glass action module when two things have been pressed
// together. It talks to the service worker, which holds the one shared state, so the object you carry is not tied to a tab:
// in any tab you bring Recast into it is "in hand" on the shelf, ready to be dragged onto something there.
// A tab cannot follow the pointer while another tab is in front, so carrying across tabs is: switch tabs, then pick the
// object up from the shelf. Everything else (merging, choosing, reviewing, placing) is the same as on a single page.
import { commit, InMemoryEventLog, OutcomeUnknownError, newClump, canMerge, looksLikeError, pieceOfSelection, undo as coreUndo, type CapabilityContract, type Fragment, type Operation, type Receipt } from "@recast/core";
import { CONTRACTS, REGISTRY } from "@recast/bridges/src/contracts";
import { createControlTrigger, doubtNote, escapeEvent, moduleModel, viewOf, type ClumpEffect, type ClumpState, type DestinationSpec, type Target } from "@recast/interaction";
import { classifyElement, classifyPiece } from "@recast/extract-web";
import { CLAY_CSS, createClay, type ClayItem } from "@recast/overlay/src/clay";
import { createGlass, GLASS_CSS, intentEvents } from "@recast/overlay/src/glass";
import { linkFor } from "@recast/bridges/src/links";
import type { EventInput, ToBackground, ToTab } from "./clay-messages.js";

declare global { interface Window { __recastClay?: boolean } }

const send = <T = { state: ClumpState; error?: string; stale?: true; captured?: string }>(m: ToBackground) => chrome.runtime.sendMessage(m) as Promise<T>;

/** A page declares a destination with data-recast-kind; it performs the registry's contract for that kind, as a stand-in. */
const KINDS: Record<string, CapabilityContract> = { calendar: CONTRACTS.googleCalendarEvent, drafts: CONTRACTS.gmailMessageDraft, tasks: CONTRACTS.googleTasks };

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
/* Phase two: the blob beside any selection while Recast is on. Shaped like a clay object: something to pick up. */
.sel-blob { position: fixed; display: inline-flex; align-items: center; gap: 8px; max-width: min(320px, calc(100vw - 16px)); padding: 7px 12px; border: 0; border-radius: 999px; pointer-events: auto;
  background: #fff7f2; color: #1a1a1a; font: 500 13px/1.2 "Figtree", ui-sans-serif, system-ui, sans-serif; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
  box-shadow: 0 0 0 1.5px #c2410c, 0 8px 22px rgba(26,26,26,.16); }
.sel-blob[hidden] { display: none; }
.sel-blob .g { color: #c2410c; } .sel-blob .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sel-blob .k { flex: none; font-size: 11px; color: #6b6b6b; padding-left: 6px; border-left: 1px solid #e3ddd3; }
.sel-blob:focus-visible { outline: 2px solid #c2410c; outline-offset: 2px; }
@media (prefers-color-scheme: dark) { .sel-blob { background: #2b2420; color: #f3f1ec; box-shadow: 0 0 0 1.5px #ff8a5c, 0 8px 22px rgba(0,0,0,.5); } .sel-blob .g { color: #ff8a5c; } .sel-blob .k { color: #b5b0a8; border-color: #46413a; } }
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
    <div class="glass"></div><div class="clay"></div><button type="button" class="sel-blob" hidden></button>`;
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
    onIntent: async (i) => {
      if (i.type === "takePage") { await takePage(); return; }
      // Combine, pressed here, starts the fusion here: this tab plays it and settles the merge (as a drop here would).
      if (i.type === "confirmMerge" && i.yes) iDropped = true;
      for (const e of intentEvents(i, state)) { const r = await dispatch(e); state = r.state; } render(); if (["reopen", "openWheel", "pick", "inspect", "placeIt"].includes(i.type)) setTimeout(() => glass.focus(), 0); },
    onLayout: () => requestAnimationFrame(() => render()),
    shortcut: /Mac/.test(navigator.platform) ? "⌃" : "Ctrl",   // shown while on: once turns it off
    takePage: "This page",
    linkFor: (op) => linkFor(op.proposal.destination.destination)?.url(op),
  });

  async function dispatch(event: EventInput) {
    const r = await send({ type: "dispatch", event });
    if (!r.stale) { error = r.error ?? ""; if (r.error) hint(r.error.charAt(0).toUpperCase() + r.error.slice(1)); }
    return r;
  }
  function hint(t: string) { $(".hint").textContent = t; }

  // ---- phase two: any selected text is a piece --------------------------------------------------------------------
  // While Recast is on, selecting text shows a blob beside it: the selection, read as a time, a person (an email address),
  // an error or text. Drag the blob to carry it; tap it (or press Enter on it) to put it on your desk.
  const blob = $<HTMLButtonElement>(".sel-blob");
  const KIND_WORD: Record<string, string> = { time: "Time", person: "Person", error: "Error", text: "Text" };
  const KIND_GLYPH: Record<string, string> = { time: "◷", person: "●", error: "⚠", text: "❝" };
  let selPress: { x: number; y: number; started: boolean; fragment: Fragment; pending?: Promise<void> } | null = null;
  function selectedText(): { text: string; range: Range } | null {
    const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0); const node = range.commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el || host.contains(el) || el.closest("input, textarea, [contenteditable='true']")) return null;   // typing is not picking up
    const text = sel.toString().replace(/\s+/g, " ").trim();
    return text && text.length <= 1000 ? { text, range } : null;
  }
  function selectionFragment(text: string): Fragment {
    const { kind, value } = pieceOfSelection(text, { now: new Date().toISOString(), timezone: tz });
    const source = { app: location.hostname || "page", url: location.href, ...(document.title ? { title: document.title.slice(0, 200) } : {}) };
    return { id: `s${++seq}-${Date.now()}`, kind, text, confidence: 0.9, ...(value ? { value } : {}), evidence: [{ locator: { kind: "user", value: "selection" }, excerpt: text.slice(0, 200) }], source };
  }
  function updateBlob() {
    if (selPress) return;
    // Not while the module is open: the person is busy there, and the blob must never cover its buttons.
    const moduleOpen = !["off", "pill"].includes(glass.el.dataset["mode"] ?? "off");
    const sel = state?.armed && !state.carried && !moduleOpen ? selectedText() : null;
    if (!sel) { blob.hidden = true; return; }
    const kind = pieceOfSelection(sel.text, { now: new Date().toISOString(), timezone: tz }).kind;
    if (blob.dataset["text"] !== sel.text) {
      blob.dataset["text"] = sel.text; blob.dataset["kind"] = kind;
      const short = sel.text.length > 42 ? `${sel.text.slice(0, 40)}…` : sel.text;
      blob.replaceChildren(Object.assign(document.createElement("span"), { className: "g", textContent: KIND_GLYPH[kind] ?? "❝" }), Object.assign(document.createElement("span"), { className: "t", textContent: short }), Object.assign(document.createElement("span"), { className: "k", textContent: KIND_WORD[kind] ?? "Text" }));
      blob.setAttribute("aria-label", `Selected text: ${sel.text.slice(0, 120)}, ${(KIND_WORD[kind] ?? "text").toLowerCase()}. Enter to put it on your desk`);
    }
    blob.hidden = false;
    const end = [...sel.range.getClientRects()].at(-1) ?? sel.range.getBoundingClientRect();
    blob.style.left = `${Math.max(8, Math.min(innerWidth - (blob.offsetWidth || 160) - 8, end.right + 6))}px`;
    blob.style.top = `${Math.max(8, Math.min(innerHeight - 48, end.bottom + 6))}px`;
  }
  async function takeSelection(carry: boolean, fragment: Fragment) {
    blob.hidden = true; getSelection()?.removeAllRanges();
    const r = await dispatch({ type: "capture", fragment, carry }); state = r.state;
    if (carry && !r.error) localCarry = true;
    render();
  }
  blob.addEventListener("pointerdown", (e) => {
    // Pressing the blob must not clear the selection it stands for.
    e.preventDefault(); e.stopPropagation();
    const t = blob.dataset["text"]; if (!t || !state.armed || state.carried) return;
    pointer = { x: e.clientX, y: e.clientY }; selPress = { x: e.clientX, y: e.clientY, started: false, fragment: selectionFragment(t) };
  });
  blob.addEventListener("click", (e) => { if (e.detail === 0 && blob.dataset["text"]) void takeSelection(false, selectionFragment(blob.dataset["text"])); });   // keyboard
  let selFrame = 0;
  document.addEventListener("selectionchange", () => { if (!selFrame) selFrame = requestAnimationFrame(() => { selFrame = 0; updateBlob(); }); });
  addEventListener("scroll", () => updateBlob(), { passive: true, capture: true });

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
    // A selected error message (an exception, a failed step) is an error piece: it can become an issue.
    if (sel && sel.length <= 300) return { id: `t${++seq}-${Date.now()}`, kind: looksLikeError(sel) ? "error" : "text", text: sel, confidence: 0.9, evidence: [{ locator: { kind: "user", value: "selection" }, excerpt: sel.slice(0, 200) }], source };
    return null;
  }

  /**
   * The page itself as one piece: its title and address, from its own metadata (the og:title or <title>, and the canonical
   * link when it is on the same site, so a tracking address is not what gets saved). On its own it is a document, so the
   * module opens on it straight away.
   */
  function pageFragment(): Fragment {
    const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim();
    const title = (og || document.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
    const url = canonical && /^https?:/.test(canonical) && new URL(canonical).hostname === location.hostname ? canonical : location.href.split("#")[0]!;
    const source = { app: location.hostname || "page", url: location.href, ...(document.title ? { title: document.title.slice(0, 200) } : {}) };
    return { id: `pg${++seq}-${Date.now()}`, kind: "page", text: title, value: { ...(title ? { name: title } : {}), url }, confidence: title ? 0.95 : 0.5,
      evidence: [{ locator: { kind: "meta", value: og ? 'meta[property="og:title"]' : "title" }, excerpt: title }], source };
  }
  async function takePage() {
    const cap = await dispatch({ type: "capture", fragment: pageFragment(), carry: false }); if (cap.error) { state = cap.state; render(); return; }
    const r = await dispatch({ type: "openModule", id: (cap.captured ?? `obj-${cap.state.seq}`) }); state = r.state; render();
    setTimeout(() => glass.focus(), 0);
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
    updateBlob();
  }
  const targetMode = (id: string): ClayItem["mode"] => (state.target?.kind === "object" && state.target.id === id ? (state.verdict?.ok ? "accepts" : "refuses") : "rest");
  function item(id: string, x: number, y: number, mode: ClayItem["mode"], inWell = false): ClayItem {
    const v = viewOf(state, id); const f = state.objects[id]!.ingredients[0]!;
    const kind: ClayItem["kind"] = v.type === "Event" ? "event" : v.type === "Message" ? "message" : v.type === "People" ? "people" : f.kind;
    return { id, x, y, label: v.label, ...(inWell && glass.el.dataset["mode"] === "choosing" && innerWidth > 520 ? { compact: true } : {}), ...(inWell ? {} : { detail: doubtNote(state, id) ?? (v.type === "Fragment" ? v.summary[0]! : v.summary.join(" · ")) }), count: state.objects[id]!.ingredients.length, kind, mode, proposed: v.proposed };
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
    if (selPress && !selPress.started && Math.hypot(e.clientX - selPress.x, e.clientY - selPress.y) > 6) { const p = selPress; p.started = true; p.pending = takeSelection(true, p.fragment).then(() => { if (selPress === p) selPress = null; }); }
    if (press && !press.started && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) void begin();
    if (localCarry && state.carried) { void hitTest(); render(); }
  }, true);
  addEventListener("pointerup", async () => {
    if (selPress && !selPress.started) { const f = selPress.fragment; selPress = null; await takeSelection(false, f); return; }
    if (selPress?.pending) await selPress.pending;   // lifted a moment ago: let the capture land before the drop
    if (press && !press.started) { const id = press.id; press = null; if (state.carried === id) return; await dispatch({ type: "inspect", id }); return; }
    press = null;
    if (!localCarry || !state.carried) return;
    await hitTest(); localCarry = false;
    if (pageTarget) {
      const { fragment } = pageTarget; pageTarget = null;
      const ok = canMerge(newClump("page", fragment), state.objects[state.carried]!);
      if (!ok.ok) { await dispatch({ type: "approach", target: null }); await dispatch({ type: "drop" }); hint(`Kept apart: ${ok.reason}`); return; }
      const cap = await dispatch({ type: "capture", fragment, carry: false });
      const id = (cap.captured ?? `obj-${cap.state.seq}`);
      await dispatch({ type: "approach", target: { kind: "object", id } });
    }
    iDropped = true; await dispatch({ type: "drop" });
  }, true);
  // The Control key, here: twice turns Recast on (the Recast command), once turns it off. (Bringing Recast into a new tab
  // still needs the toolbar or Alt+Shift+R: an extension cannot listen on pages it was not invited into without access
  // to every site.)
  const trigger = createControlTrigger();
  const onTrigger = (r: "on" | "off" | null) => { if (r === "on") void send({ type: "command" }); else if (r === "off") void dispatch({ type: "disarm" }); };
  addEventListener("keydown", (e) => onTrigger(trigger({ type: "keydown", key: e.key, repeat: e.repeat, at: e.timeStamp }, !!state?.armed)), true);
  addEventListener("keyup", (e) => onTrigger(trigger({ type: "keyup", key: e.key, at: e.timeStamp }, !!state?.armed)), true);
  addEventListener("pointerdown", (e) => { trigger({ type: "pointerdown", at: e.timeStamp }, !!state?.armed); }, true);
  addEventListener("blur", (e) => { trigger({ type: "blur", at: e.timeStamp }, !!state?.armed); });
  document.addEventListener("visibilitychange", (e) => { trigger({ type: "blur", at: e.timeStamp }, !!state?.armed); });
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
      // Empty page (the body or the document itself) is not a piece: classifying it would read the whole page and press the
      // object into whatever date or place the page holds. Letting go there puts the object down.
      else if (under[0] && under[0] !== document.body && under[0] !== document.documentElement) { const f = fragmentAt(under[0]); if (f) pageTarget = { el: under[0], fragment: f }; }
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
        // Test control on the page (like data-recast-silent): answer only after a delay, so a write can be in flight.
        const delay = Number(el.dataset["recastDelay"] ?? 0); if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        const li = document.createElement("li"); li.dataset["placed"] = op.proposal.relationId; li.id = `recast-${op.opId}`;
        li.textContent = op.dataMoved.filter((d) => ["Event.title", "Event.start", "Event.location", "Message.to", "Message.snippet", "Document.title", "Document.url"].includes(d.path)).map((d) => d.value).join(" · ");
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
      const opId = eff.op.opId;
      try { const receipt = await commit(eff.op, eff.consent, { bridge, log, now }); await dispatch({ type: "committed", receipt, undoable: receipt.reversible }); }
      catch (e) { await dispatch(e instanceof OutcomeUnknownError ? { type: "outcomeUnknown", opId, message: e.message } : { type: "commitFailed", opId, message: e instanceof Error ? e.message : String(e) }); }
    } else if (eff.type === "reconcile") {
      const ref = `recast-${eff.op.opId}`;
      if (document.getElementById(ref)) {
        const receipt: Receipt = { receiptId: `rc-${eff.op.opId}`, opId: eff.op.opId, at: now(), status: "done", objectId: eff.op.proposal.object.id, destination: eff.op.proposal.destination.destination, relationId: eff.op.proposal.relationId, effect: eff.op.proposal.effect, reversible: eff.op.proposal.reversible, bridgeRef: ref };
        await log.append({ kind: "commit", at: receipt.at, receipt }); await dispatch({ type: "reconciled", opId: eff.op.opId, found: true, receipt });
      } else await dispatch({ type: "reconciled", opId: eff.op.opId, found: false });
    } else if (eff.type === "undo") {
      // Only a confirmed reversal is "undone"; anything else is a failed undo, and the placement stands.
      try { await coreUndo(eff.receipt, { bridge, log, now }); await dispatch({ type: "undone", opId: eff.receipt.opId }); }
      catch (e) { await dispatch({ type: "undoFailed", opId: eff.receipt.opId, message: e instanceof Error ? e.message : String(e) }); }
    }
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
