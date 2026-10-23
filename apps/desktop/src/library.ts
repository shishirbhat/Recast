// The library: the Recast app proper. Every blob you have grabbed, newest first, with the app (and page) it came from and
// where it went. It never opens by itself when you grab; you open it from Applications, the Dock or the tray.
interface Entry { id: string; text: string; kind: string; source?: { app?: string; url?: string; title?: string }; at: string; placed?: { where: string; at: string; link?: string }[] }
interface Settings { theme: "system" | "dark" | "light"; shortcuts: { open: string; capture: string }; platform: string; trigger: string; shortcutProblems: string[]; serverNote: string; version: string; grabReady: boolean; listening: boolean; hookProblem: string }
interface Api {
  boot(): Promise<{ settings: Settings; theme: "dark" | "light" }>;
  history(): Promise<Entry[]>;
  historyRemove(id: string): Promise<boolean>;
  copy(text: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  settings(p: unknown): Promise<Settings>;
  permission(): Promise<boolean>;
  window(what: string): Promise<boolean>;
  on(channel: string, fn: (v: any) => void): void;
}
const api = (window as unknown as { recastDesktop: Api }).recastDesktop;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const MAC = navigator.userAgent.includes("Mac");
const GLYPH: Record<string, string> = { time: "◷", person: "●", error: "⚠", text: "❝", place: "⌖" };
let entries: Entry[] = [];
let settings: Settings | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const dayOf = (iso: string) => { const d = new Date(iso); const today = new Date(); const y = new Date(Date.now() - 864e5);
  return d.toDateString() === today.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }); };

function render() {
  const q = $<HTMLInputElement>("#search").value.trim().toLowerCase();
  const shown = entries.filter((e) => !q || e.text.toLowerCase().includes(q) || (e.source?.app ?? "").toLowerCase().includes(q) || (e.source?.title ?? "").toLowerCase().includes(q)).slice().reverse();
  $("#empty").hidden = entries.length > 0;
  const list = $("#list"); list.replaceChildren();
  let day = "";
  for (const e of shown) {
    const d = dayOf(e.at); if (d !== day) { day = d; list.append(el("h3", { className: "day", textContent: d })); }
    const from = e.source?.url ? el("a", { href: e.source.url, textContent: e.source.title || e.source.app || e.source.url, title: e.source.url }) : document.createTextNode(e.source?.title ? `${e.source.app ?? ""} · ${e.source.title}` : e.source?.app ?? "");
    const meta = el("p", { className: "meta" }, from, ` · ${new Date(e.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
    for (const p of e.placed ?? []) meta.append(p.link ? el("a", { className: "placed", href: p.link, textContent: `→ ${p.where}` }) : el("span", { className: "placed", textContent: `→ ${p.where}` }));
    const copy = el("button", { type: "button", className: "row-act", textContent: "Copy" }); copy.addEventListener("click", () => { void api.copy(e.text); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); });
    const remove = el("button", { type: "button", className: "row-act", textContent: "Remove" }); remove.addEventListener("click", () => void api.historyRemove(e.id));
    list.append(el("article", { className: "entry" }, el("span", { className: "glyph", textContent: GLYPH[e.kind] ?? "❝", ariaHidden: "true" }), el("p", { className: "text", textContent: e.text }), el("span", { className: "acts" }, copy, remove), meta));
  }
  if (entries.length && !shown.length) list.append(el("p", { className: "quiet", textContent: "Nothing matches." }));
}
// Links in the list open in the person's browser (the app refuses anything but the web).
$("#list").addEventListener("click", (ev) => { const a = (ev.target as HTMLElement).closest("a"); if (a) { ev.preventDefault(); void api.openExternal(a.href); } });
$("#search").addEventListener("input", render);

const pretty = (a: string) => (MAC ? a.replace("CommandOrControl", "⌘").replace("Control", "⌃").replace("Alt", "⌥").replace("Shift", "⇧").replace(/\+/g, "") : a.replace("CommandOrControl", "Ctrl"));
function renderSettings() {
  if (!settings) return;
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=theme]")) r.checked = r.value === settings.theme;
  $<HTMLInputElement>("#sc-open").value = settings.shortcuts.open; $<HTMLInputElement>("#sc-capture").value = settings.shortcuts.capture;
  $("#sc-problems").textContent = settings.shortcutProblems.join(". ");
  $("#server-note").textContent = settings.serverNote;
  $("#version").textContent = `Recast ${settings.version}. Also: ${pretty(settings.shortcuts.capture)} turns Recast on and grabs; ${pretty(settings.shortcuts.open)} opens this library.`;
  for (const k of document.querySelectorAll(".trigger")) k.textContent = settings.trigger;
  $("#permission").hidden = !(settings.platform === "darwin" && (!settings.grabReady || !settings.listening));
  $("#hook-problem").textContent = settings.hookProblem;
}
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=theme]")) r.addEventListener("change", () => void api.settings({ theme: r.value }).then((s) => { settings = s; renderSettings(); }));
$("#shortcuts-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void api.settings({ shortcuts: { open: $<HTMLInputElement>("#sc-open").value.trim(), capture: $<HTMLInputElement>("#sc-capture").value.trim() } }).then((s) => { settings = s; renderSettings(); });
});
$("#btn-permission").addEventListener("click", () => void api.permission());
$("#btn-on").addEventListener("click", () => void api.window("on"));
for (const id of ["#btn-connections", "#btn-connections-2"]) $(id).addEventListener("click", () => void api.window("connections"));
$("#btn-playground").addEventListener("click", () => void api.window("playground"));

api.on("recast:theme", (t: "dark" | "light") => { document.documentElement.dataset["theme"] = t; });
api.on("recast:settings", (s: Settings) => { settings = s; renderSettings(); });
api.on("recast:history", (list: Entry[]) => { entries = list.filter((e) => !(e as { removed?: boolean }).removed); render(); });
if (MAC) document.body.classList.add("mac");
void (async () => {
  const b = await api.boot();
  settings = b.settings; document.documentElement.dataset["theme"] = b.theme; renderSettings();
  entries = await api.history(); render();
})();

export {};
