import type { Capture, CapturedObject } from "./page.js";

declare const __RECAST_TEST__: boolean;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GLYPH: Record<string, string> = { Person: "P", Document: "D", Event: "E", Location: "L", Image: "I", Message: "M", Task: "T", Product: "$", ResearchPaper: "R" };
const SOURCE: Record<string, string> = {
  jsonld: "Page metadata (JSON-LD)", microdata: "Page markup (microdata)", "meta-citation": "Citation metadata", opengraph: "Social preview tags",
  "dom-mailto": "Guessed from a mail link", "dom-address": "Guessed from an address block",
};
const pct = (n: number) => `${Math.round(n * 100)}%`;
const show = (v: unknown): string =>
  Array.isArray(v) ? v.map(show).join(", ") : v && typeof v === "object" ? Object.values(v).map(show).join(" ") : String(v);

// Everything below is built with textContent only: page-controlled strings are never parsed as HTML.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { text?: string; cls?: string } = {}, kids: (Node | null)[] = []) {
  const n = document.createElement(tag);
  if (props.text !== undefined) n.textContent = props.text;
  if (props.cls) n.className = props.cls;
  for (const k of kids) if (k) n.appendChild(k);
  return n;
}

async function inTab<T>(tabId: number, func: (...a: never[]) => T, args: unknown[] = []): Promise<T> {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: func as never, args: args as never });
  return r?.result as T;
}

function renderObject(o: CapturedObject, tabId: number, open: boolean): HTMLElement {
  const title = show(o.properties["name"] ?? o.properties["title"] ?? o.properties["address"] ?? o.type);
  const conf = Math.min(...Object.values(o.fields).map((f) => f.confidence));
  const heuristic = o.method === "dom";
  const d = el("details", { cls: "obj" });
  if (open) d.open = true;
  d.appendChild(el("summary", {}, [
    el("span", { cls: "glyph", text: GLYPH[o.type] ?? "?" }),
    el("div", {}, [
      el("div", { cls: "title", text: title }),
      el("div", { cls: heuristic ? "meta fragile" : "meta", text: `${o.type} · ${SOURCE[o.adapter] ?? o.adapter} · least sure: ${pct(conf)}${heuristic ? " · check this" : ""}` }),
    ]),
  ]));
  const tbody = el("tbody");
  for (const [k, v] of Object.entries(o.properties)) {
    const f = o.fields[k]!;
    const btn = el("button", { text: "Show" });
    btn.setAttribute("aria-label", `Show where ${k} came from on the page`);
    const note = el("div", { cls: "note" });
    note.hidden = true;
    btn.addEventListener("click", async () => {
      const res = await inTab(tabId, ((ev: unknown, val: unknown) => (globalThis as unknown as { __recast: { highlight(e: unknown, v: unknown): string } }).__recast.highlight(ev, val)) as never, [f.evidence, v]);
      note.hidden = res === "shown";
      note.textContent = res === "not-visible" ? `${k} was read from page metadata that is not shown on the page.` : res === "not-found" ? `Could not find ${k} on the page any more.` : "";
    });
    tbody.appendChild(el("tr", {}, [el("th", { text: k }), el("td", { text: show(v) }), el("td", { cls: "conf", text: pct(f.confidence) }), el("td", {}, [btn])]));
    tbody.appendChild(el("tr", {}, [el("td", {}), el("td", {}, [note])]));
  }
  d.appendChild(el("table", {}, [tbody]));
  return d;
}

function render(c: Capture, tabId: number) {
  const root = $("root");
  root.replaceChildren();
  const primary = c.objects.filter((o) => o.role === "primary"), related = c.objects.filter((o) => o.role !== "primary");
  const total = c.objects.length;
  $("status").textContent = total ? `${primary.length} about this page${related.length ? `, ${related.length} more on it` : ""} · read in ${Math.round(c.ms)} ms, on this device` : "";
  if (!total) {
    root.appendChild(el("p", { cls: "empty", text: "This page does not describe anything Recast can read reliably. It looks for structured data the site publishes (JSON-LD, microdata, citation and social tags). It does not guess from how the page looks." }));
    return;
  }
  primary.forEach((o, i) => root.appendChild(renderObject(o, tabId, i === 0)));
  if (related.length) {
    root.appendChild(el("div", { cls: "related-head", text: "Also on this page" }));
    related.slice(0, 20).forEach((o) => root.appendChild(renderObject(o, tabId, false)));
    if (related.length > 20) root.appendChild(el("p", { cls: "note", text: `and ${related.length - 20} more` }));
  }
}

async function main() {
  // Test builds only: choose the tab from the URL. In production this branch is compiled away.
  const qs = __RECAST_TEST__ ? new URLSearchParams(location.search).get("tabId") : null;
  const tabId = qs && /^\d+$/.test(qs) ? Number(qs) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId === undefined) { $("status").textContent = "No tab to read."; return; }
  // The explicit alternative to the shortcut: the worker brings Recast into this tab (activeTab, granted by opening this
  // popup) and turns it on, or reopens a composition. The popup then gets out of the way.
  $("clump").addEventListener("click", () => { void chrome.runtime.sendMessage({ type: "invoke", tabId }).then(() => window.close()); });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page.js"] });
    const c = await inTab<Capture>(tabId, (() => (globalThis as unknown as { __recast: { capture(): unknown } }).__recast.capture()) as never);
    render(c, tabId);
  } catch {
    $("status").textContent = "Recast can't read this page.";
    $("root").appendChild(el("p", { cls: "empty", text: "Browser pages, the extension store and some protected pages can't be read. Try an ordinary web page." }));
  }
}
// How much Recast asks (D24). Asked once, the first time the popup opens; changeable here.
void (chrome.runtime.sendMessage({ type: "confirm" }) as Promise<{ level?: "none" | "high" }>).then(({ level }) => {
  const box = document.querySelector<HTMLElement>(".ask")!;
  if (!level) { box.classList.add("first"); $("ask-first").hidden = false; }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="ask"]')) {
    r.checked = r.value === level;
    r.addEventListener("change", () => { void chrome.runtime.sendMessage({ type: "confirm", level: r.value as "none" | "high" }).then(() => { box.classList.remove("first"); $("ask-first").hidden = true; }); });
  }
});

// The real Google Calendar, through the Recast program on this computer. Access to http://localhost is asked for only
// when the person presses Connect; the program then shows the same code and asks them to Allow this extension.
type LinkState = { state: "off" | "unreachable" | "pending" | "not-signed-in" | "ready"; code?: string; gmail?: boolean; tasks?: boolean; docs?: boolean; github?: string };
function showLink(l: LinkState) {
  const text = $("link-text"), btn = $<HTMLButtonElement>("link-btn");
  text.replaceChildren(); btn.hidden = false;
  if (l.state === "off") { text.textContent = "Calendar placements go to a local stand-in."; btn.textContent = "Connect the real Google Calendar"; }
  else if (l.state === "unreachable") { text.textContent = "The Recast program isn't running on this computer. In a terminal: pnpm --filter @recast/calendar-link run start"; btn.textContent = "Try again"; }
  else if (l.state === "pending") { text.append("Open http://localhost:8787 and press Allow if it shows this code: ", el("span", { cls: "code", text: l.code ?? "" })); btn.textContent = "I allowed it"; }
  else if (l.state === "not-signed-in") { text.textContent = "Allowed. Now sign in with Google on http://localhost:8787."; btn.textContent = "Check again"; }
  else { text.textContent = `Connected. Placing in Calendar adds a real event, with Undo.${l.gmail ? " Mail saves a real Gmail draft (never sent)." : " Gmail drafts: not allowed (tick Gmail when signing in on http://localhost:8787)."}${l.tasks ? " Tasks adds a page to Google Tasks." : " Google Tasks: not allowed (tick Tasks when signing in)."}${l.docs ? " Documents creates a Google Doc from a note." : " Google Docs: not allowed (tick Google Drive when signing in)."}${l.github ? ` An error opens an issue in GitHub ${l.github}.` : ""}`; btn.hidden = true; }
}
async function linkFlow(ask: boolean) {
  if (ask && !(await chrome.permissions.request({ origins: ["http://localhost/*"] }))) return showLink({ state: "off" });
  showLink(await chrome.runtime.sendMessage({ type: "link" }) as LinkState);
}
$("link-btn").addEventListener("click", () => { void linkFlow(true); });
void chrome.permissions.contains({ origins: ["http://localhost/*"] }).then((has) => { if (has) void linkFlow(false); });

addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
void main();
