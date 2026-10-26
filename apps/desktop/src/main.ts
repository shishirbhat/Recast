// Recast for the desktop. Two surfaces, like a dictation app:
//   - The overlay: Recast on top of whatever app is in front, never a window of its own. Tap the trigger key twice
//     (Option on a Mac, Ctrl on Windows and Linux) and the text you selected lifts into a blob right where you are; select
//     more while Recast is on and each becomes a blob too. Click a blob and the wheel opens beside it, on the same screen:
//     choose where it goes, review, place. The overlay is transparent and lets every click through except on Recast's
//     own blobs and wheel, so the app underneath keeps working.
//   - The library: the Recast app proper, a normal window that lists every blob you have grabbed (and where it went).
//     It opens only when you open it (Applications, the Dock, the tray), never when you grab.
// The local program (apps/calendar-link) runs inside the app, so Google, GitHub and Linear work without a terminal.
//
// Security: the windows have no Node (context isolation, sandbox); pages talk to this process only through the few
// calls in preload.ts. Tokens and the Google client secret stay in this process and on disk (readable only by this user),
// never in a page. Sign-in happens in the person's own browser.
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray, type Rectangle } from "electron";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createLink } from "../../calendar-link/src/server.js";
import { canGrab, frontSource, grabSelection } from "./grab.js";
import { capture, read, screenAccess, stopReading } from "./screen.js";
import { findSpots } from "./spots.js";
import { createHook, TRIGGER_LABEL } from "./hook.js";

type Theme = "system" | "dark" | "light";
interface Settings { theme: Theme; shortcuts: { open: string; capture: string } }
interface GoogleConfig { clientId: string; clientSecret: string }
// On a Mac, ⌘⌥Space belongs to Finder (its search window) and never reaches Recast, so opening uses ⌃⌥Space there.
const OLD_MAC_OPEN = "CommandOrControl+Alt+Space";
const DEFAULTS: Settings = { theme: "system", shortcuts: { capture: "CommandOrControl+Shift+Space", open: process.platform === "darwin" ? "Control+Alt+Space" : "CommandOrControl+Alt+Space" } };
const PORT = 8787;
const DARK_BG = "#141311", LIGHT_BG = "#faf9f6";

// Tests run the built app with their own data folder and a stand-in for Google; a packaged app never reads these.
const test = !app.isPackaged && process.env["RECAST_TEST"] === "1";
if (test && process.env["RECAST_USER_DATA"]) app.setPath("userData", process.env["RECAST_USER_DATA"]);
if (!app.requestSingleInstanceLock()) app.quit();
// A launch check for the built app (CI, on each system): open as a person would, report what is on screen, then quit.
const smoke = process.argv.includes("--recast-smoke");

const data = () => app.getPath("userData");
const secrets = () => path.join(data(), "secrets");
const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; } };
const writePrivate = (file: string, value: unknown) => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); chmodSync(file, 0o600); };
let settings: Settings = { ...DEFAULTS };
const settingsFile = () => path.join(data(), "settings.json");
const googleFile = () => path.join(secrets(), "google-app.json");
const inboxFile = () => path.join(data(), "inbox.json");       // the blobs on screen, with where they sit
const historyFile = () => path.join(data(), "history.json");   // every blob ever grabbed: the library

let library: BrowserWindow | null = null, overlay: BrowserWindow | null = null, connections: BrowserWindow | null = null, playground: BrowserWindow | null = null;
let tray: Tray | null = null;
let link: ReturnType<typeof createLink> | null = null, server: Server | null = null, serverNote = "";
const shortcutProblems: string[] = [];
let quitting = false;
let on = false;                       // Recast is on: the overlay shows over the app in front
let grabbing = false, lastGrab = "";   // one grab at a time; the same Linux selection is not lifted twice

const bg = () => (nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG);
const page = (name: string) => path.join(__dirname, name);

/** The local program, with the Google app the person set up (or none yet: GitHub and Linear still work). */
async function startLink() {
  const g = readJson<GoogleConfig | null>(googleFile(), null);
  const fetchImpl = test ? await testFetch() : fetch;
  link = createLink({ clientId: g?.clientId ?? "", clientSecret: g?.clientSecret ?? "", port: PORT, tokenFile: path.join(secrets(), "google-token.json"), fetch: fetchImpl,
    ...(test ? { tokenUrl: "https://google.test/token" } : {}) });
  await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
  server = link.server; serverNote = "";
  server.once("error", (e: NodeJS.ErrnoException) => { serverNote = e.code === "EADDRINUSE" ? `Port ${PORT} is in use (is the Recast program already running in a terminal?). Close it and restart Recast.` : `The sign-in page could not start: ${e.message}`; });
  server.listen(PORT, "127.0.0.1");
}
/** Test builds only: a module that stands in for Google and GitHub, named by the test. */
async function testFetch(): Promise<typeof fetch> {
  const mod = process.env["RECAST_TEST_FETCH"];
  if (!mod) return fetch;
  const m = (await import(mod)) as { default: typeof fetch };
  return m.default;
}

const themeName = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
function applyTheme() {
  nativeTheme.themeSource = settings.theme;
  for (const w of [library, connections, playground]) if (w && !w.isDestroyed()) w.setBackgroundColor(bg());
  for (const w of [library, overlay, connections, playground]) if (w && !w.isDestroyed()) w.webContents.send("recast:theme", themeName());
}

/** Every window: no Node, no navigation away, links to the web go to the person's browser. */
function harden(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url) || url.startsWith(`http://localhost:${PORT}/`)) void shell.openExternal(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) { e.preventDefault(); if (/^https:\/\//.test(url)) void shell.openExternal(url); } });
}
const webPreferences = { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false };

// ---- the library: the Recast app proper ------------------------------------------------------------------------------
function createLibrary() {
  library = new BrowserWindow({ width: 980, height: 680, minWidth: 560, minHeight: 420, show: false, backgroundColor: bg(), title: "Recast", autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}), webPreferences });
  harden(library);
  void library.loadFile(page("library.html"));
  library.once("ready-to-show", () => {
    if (!test || process.env["RECAST_SHOW"] !== "0") library?.show();
    if (smoke) setTimeout(async () => {
      // The highlights' reader, run once on this screen from the installed app (its engine and English model must load).
      let ocr = "no-image";
      try { const shot = await capture(screen.getPrimaryDisplay()); if (shot) ocr = `ok:${(await read(shot)).length}`; } catch (e) { ocr = `error:${e instanceof Error ? e.message : String(e)}`; }
      const report = `RECAST_SMOKE ${JSON.stringify({ visible: !!library?.isVisible(), overlay: !!overlay && !overlay.isDestroyed(), hook: hook.started, ocr, hookProblem: hook.problem, tray: !!tray, link: !serverNote })}`;
      console.log(report);
      // Windows gives a windowed app no console, so the report can also go to a file the check names.
      if (process.env["RECAST_SMOKE_OUT"]) writeFileSync(process.env["RECAST_SMOKE_OUT"], report + "\n");
      quitting = true; app.quit();
    }, 1500);
  });
  // Closing hides: Recast keeps running (the trigger keeps working). Quit from the tray or the app menu.
  library.on("close", (e) => { if (!quitting) { e.preventDefault(); library?.hide(); } });
}
function showLibrary() {
  if (!library || library.isDestroyed()) { createLibrary(); return; }
  library.show(); library.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}
function toggleLibrary() { if (library?.isVisible() && library.isFocused()) library.hide(); else showLibrary(); }

// ---- the overlay: Recast over the app in front ------------------------------------------------------------------------
// One transparent window over the display the pointer is on. It takes clicks only where Recast draws something (the
// blobs, the wheel): on a Mac and Windows by ignoring the mouse everywhere else (and being told when the pointer is over
// a blob); on Linux by shaping the window to exactly those rectangles.
let interactive = false;
let ownRects: Rectangle[] = [];   // where Recast itself draws (blobs, the wheel), in overlay coordinates
function createOverlay() {
  overlay = new BrowserWindow({
    show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: false, skipTaskbar: true, focusable: true, alwaysOnTop: true, backgroundColor: "#00000000", title: "Recast overlay",
    ...(process.platform === "darwin" ? { type: "panel" as const } : process.platform === "linux" ? { type: "toolbar" as const } : {}),
    webPreferences,
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  harden(overlay);
  void overlay.loadFile(page("overlay.html"));
  setInteractive(false, []);
  overlay.on("close", (e) => { if (!quitting) { e.preventDefault(); turnOff(); } });
}
function setInteractive(next: boolean, rects: Rectangle[]) {
  if (!overlay || overlay.isDestroyed()) return;
  const was = interactive; interactive = next;   // the pointer is on Recast: its clicks are Recast's, not the app's
  if (process.platform === "linux") {
    // A shaped window: only Recast's own rectangles take the mouse; everything else goes to the app underneath.
    overlay.setShape(rects.length ? rects : [{ x: 0, y: 0, width: 1, height: 1 }]);
    return;
  }
  if (next === was) return;
  overlay.setIgnoreMouseEvents(!next, { forward: true });
}
/** Covers the display the pointer is on (Recast comes up where the person is looking). */
function placeOverlay() {
  const at = screen.getCursorScreenPoint();
  const { bounds } = screen.getDisplayNearestPoint(at);
  overlay!.setBounds(bounds);
  return bounds;
}
const toOverlay = (p: { x: number; y: number }) => { const b = overlay!.getBounds(); return { x: p.x - b.x, y: p.y - b.y }; };

async function turnOn(grab = true) {
  if (!overlay || overlay.isDestroyed()) createOverlay();
  if (!on) {
    on = true; placeOverlay();
    // The screen as it is, read before Recast draws anything on it.
    const shot = await capture(screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).catch(() => null);
    if (!on) return;
    overlay!.showInactive(); overlay!.moveTop(); overlay!.webContents.send("recast:on", true);
    void spot(shot);
  }
  if (grab) void grabAt(screen.getCursorScreenPoint(), true);
}

// ---- highlights: what on the screen a person is likely to pick up --------------------------------------------------------
let scanSeq = 0, rescanTimer: NodeJS.Timeout | null = null, spotsNote = "";
/** Reads the shot and sends the overlay the spots to highlight; anything under Recast's own blobs or wheel is left out. */
async function spot(shot: Awaited<ReturnType<typeof capture>>) {
  const mine = ++scanSeq;
  if (!shot) { spotsNote = screenAccess() === "granted" ? "Recast could not see the screen" : "Allow Screen Recording to see highlights"; overlay?.webContents.send("recast:spots", { spots: [], note: spotsNote }); broadcastSettings(); return; }
  try {
    if (test && process.env["RECAST_SHOT_OUT"]) writeFileSync(process.env["RECAST_SHOT_OUT"], shot.image.toPNG());
    const [lines, source] = await Promise.all([read(shot), frontSource().catch(() => ({}))]);
    if (test) (globalThis as unknown as { __recastLines: unknown }).__recastLines = lines.map((l) => l.words.map((w) => w.text).join(" "));
    if (mine !== scanSeq || !on) return;
    const overlaps = (r: { x: number; y: number; width: number; height: number }) => ownRects.some((o) => r.x < o.x + o.width && o.x < r.x + r.width && r.y < o.y + o.height && o.y < r.y + r.height);
    const spots = findSpots(lines, { now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).filter((x) => !overlaps(x)).slice(0, 60);
    spotsNote = "";
    overlay?.webContents.send("recast:spots", { spots, source });
  } catch (e) { spotsNote = `Highlights are not available: ${e instanceof Error ? e.message : String(e)}`; overlay?.webContents.send("recast:spots", { spots: [], note: spotsNote }); }
}
/** The app underneath changed (a scroll, a click): highlights go at once and come back for what is there now. */
function rescanSoon() {
  if (!on) return;
  ++scanSeq; overlay?.webContents.send("recast:spots", { spots: [], scanning: true });
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(async () => { rescanTimer = null; if (!on) return; const shot = await capture(screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).catch(() => null); if (on) void spot(shot); }, 700);
}

function turnOff() {
  if (!on) return;
  on = false; ++scanSeq; setInteractive(false, []);
  overlay?.webContents.send("recast:on", false);
  overlay?.hide();
}

/** What is selected in the app in front becomes a blob where the pointer is. Nothing opens; the app keeps the keyboard. */
async function grabAt(point: { x: number; y: number }, fromTrigger: boolean) {
  if (grabbing) return null;
  grabbing = true;
  try {
    const r = await grabSelection(hook.started ? () => hook.copyKeys() : undefined);
    if (!overlay || overlay.isDestroyed()) return r;
    if (r.ok) {
      // Linux keeps the last selection after it is cleared: the same text again is not a new grab.
      if (process.platform === "linux" && r.grabbed.text === lastGrab) return { ok: false as const, reason: "empty" as const, message: "Select some text first" };
      lastGrab = r.grabbed.text;
      overlay.webContents.send("recast:capture", { ...r.grabbed, from: "selection", at: toOverlay(point) });
    } else if (fromTrigger && r.reason !== "empty") overlay.webContents.send("recast:grab-problem", { reason: r.reason, message: r.message, at: toOverlay(point) });
    // Nothing selected when Recast turned on is fine: the highlights and a selection are both ways to start.
    if (!r.ok && r.reason === "permission") showLibrary();   // the library explains the permission
    return r;
  } finally { grabbing = false; }
}

// ---- the trigger -----------------------------------------------------------------------------------------------------
const hook = createHook({
  onTrigger: (next) => (next === "on" ? void turnOn(true) : turnOff()),
  onEscape: () => overlay?.webContents.send("recast:escape"),
  onSelectionEnd: () => { if (!interactive) void grabAt(screen.getCursorScreenPoint(), false); },
  onScreenChanged: () => { if (!interactive) rescanSoon(); },
}, () => on);
/** Starts the keyboard listener once it may (a Mac asks for Accessibility first); checks again until it can. */
let hookTimer: NodeJS.Timeout | null = null;
function startHook() {
  if (canGrab(false) && hook.start()) { if (hookTimer) { clearInterval(hookTimer); hookTimer = null; } broadcastSettings(); return; }
  if (!hookTimer && process.platform === "darwin") hookTimer = setInterval(startHook, 2000);
}
if (test) Object.assign(globalThis as object, {
  __recastKey: (name: string, type: "keydown" | "keyup") => hook.feedKey(name, type),
  __recastGrab: () => (on ? grabAt(screen.getCursorScreenPoint(), true) : (void turnOn(true), null)),
  __recastRescan: () => rescanSoon(),
  __recastOn: () => on,
  __recastOverlayInteractive: () => interactive,
});

function registerShortcuts() {
  globalShortcut.unregisterAll(); shortcutProblems.length = 0;
  const reg = (accel: string, fn: () => void, what: string) => {
    try { if (!globalShortcut.register(accel, fn)) shortcutProblems.push(`${accel} (${what}) is taken by another app`); }
    catch { shortcutProblems.push(`${accel} (${what}) is not a valid shortcut`); }
  };
  reg(settings.shortcuts.open, toggleLibrary, "open the Recast library");
  // The same as the trigger, for keyboards or setups where tapping a key twice is awkward.
  reg(settings.shortcuts.capture, () => void (on ? grabAt(screen.getCursorScreenPoint(), true) : turnOn(true)), "turn Recast on and grab");
}

function openConnections() {
  if (connections && !connections.isDestroyed()) { connections.show(); connections.focus(); return; }
  connections = new BrowserWindow({ width: 520, height: 660, minWidth: 420, show: false, backgroundColor: bg(), title: "Recast connections", autoHideMenuBar: true, webPreferences });
  harden(connections);
  void connections.loadFile(page("connections.html"));
  connections.once("ready-to-show", () => connections?.show());
}
function openPlayground() {
  if (playground && !playground.isDestroyed()) { playground.show(); playground.focus(); return; }
  playground = new BrowserWindow({ width: 1180, height: 820, show: false, backgroundColor: bg(), title: "Recast playground (sample data)", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  harden(playground);
  void playground.loadFile(page("playground/clay.html"));
  playground.once("ready-to-show", () => playground?.show());
}

const pretty = (a: string) => a.replace("CommandOrControl", process.platform === "darwin" ? "⌘" : "Ctrl").replace("Control", process.platform === "darwin" ? "⌃" : "Ctrl").replace("Alt", process.platform === "darwin" ? "⌥" : "Alt").replace(/\+/g, process.platform === "darwin" ? "" : "+");
function trayIcon() {
  const img = nativeImage.createFromPath(page(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img;
}
function buildTray() {
  if (!tray) { tray = new Tray(trayIcon()); tray.setToolTip("Recast"); tray.on("click", showLibrary); }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Turn Recast on    ${TRIGGER_LABEL} twice`, click: () => void turnOn(false) },
    { label: `Open the library    ${pretty(settings.shortcuts.open)}`, click: showLibrary },
    { type: "separator" },
    { label: "Try the playground (sample data)", click: openPlayground },
    { label: "Connections…", click: openConnections },
    { label: "Appearance", submenu: (["system", "dark", "light"] as Theme[]).map((t) => ({ label: t === "system" ? "Match the system" : t === "dark" ? "Dark" : "Light", type: "radio" as const, checked: settings.theme === t, click: () => setSettings({ theme: t }) })) },
    { type: "separator" },
    { label: "Quit Recast", click: () => { quitting = true; app.quit(); } },
  ]));
}
function setSettings(p: Partial<Settings>) {
  settings = { ...settings, ...p, shortcuts: { ...settings.shortcuts, ...(p.shortcuts ?? {}) } };
  writePrivate(settingsFile(), settings);
  if (p.theme) applyTheme();
  if (p.shortcuts) registerShortcuts();
  buildTray(); broadcastSettings();
}
const publicSettings = () => ({ ...settings, platform: process.platform, trigger: TRIGGER_LABEL, shortcutProblems: [...shortcutProblems], serverNote, version: app.getVersion(),
  grabReady: canGrab(false), listening: hook.started, hookProblem: hook.problem, screen: screenAccess(), spotsNote });
function broadcastSettings() { for (const w of [library, overlay]) if (w && !w.isDestroyed()) w.webContents.send("recast:settings", publicSettings()); }

// ---- the library's record --------------------------------------------------------------------------------------------
interface Entry { id: string; text: string; kind: string; source?: { app?: string; url?: string; title?: string }; at: string; placed?: { where: string; at: string; link?: string }[]; removed?: boolean }
const history = (): Entry[] => readJson<Entry[]>(historyFile(), []);
function saveHistory(list: Entry[]) { writePrivate(historyFile(), list.slice(-2000)); library?.webContents.send("recast:history", list); }
const clean = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : undefined);

// ---- the pages' few calls ---------------------------------------------------------------------------------------------
const DESTS = new Set(["calendar", "gmail", "tasks", "docs", "github", "linear"]);
function ipc() {
  ipcMain.handle("recast:boot", () => ({ settings: publicSettings(), inbox: readJson<unknown>(inboxFile(), null), theme: themeName(), on }));
  ipcMain.handle("recast:status", async () => (link ? (await link.direct("status", {})).body : {}));
  ipcMain.handle("recast:act", async (_e, route: unknown, body: unknown) => {
    // Only these operations, only to the destinations this program serves; the program checks the rest.
    if (!link || (route !== "commit" && route !== "reconcile" && route !== "undo" && route !== "verify") || !body || typeof body !== "object") return { status: 400, body: { error: "not allowed" } };
    const b = body as Record<string, unknown>;
    if (!DESTS.has(String(b["destination"]))) return { status: 400, body: { error: "unknown destination" } };
    return link.direct(route, b);
  });
  ipcMain.handle("recast:open-external", (_e, url: unknown) => {
    if (typeof url !== "string") return false;
    let u: URL; try { u = new URL(url); } catch { return false; }
    // Only the web, and the sign-in page on this computer: never a file, a custom scheme or a script.
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.host === `localhost:${PORT}`)) return false;
    void shell.openExternal(u.toString()); return true;
  });
  // The overlay says where its blobs and wheel are; only there does it take the mouse.
  const rectList = (rects: unknown): Rectangle[] => (Array.isArray(rects) ? (rects as Rectangle[]).filter((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite)).slice(0, 96)
    .map((r) => ({ x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) })) : []);
  ipcMain.handle("recast:interactive", (e, over: unknown, rects: unknown, own: unknown) => {
    if (!overlay || e.sender !== overlay.webContents) return false;
    setInteractive(!!over, rectList(rects)); ownRects = rectList(own);
    // Typing in the wheel (a question to answer) needs the keyboard: the overlay takes it only while the pointer is on it.
    if (over && !overlay.isFocused() && process.platform !== "linux") overlay.focus();
    return true;
  });
  ipcMain.handle("recast:off", (e) => { if (overlay && e.sender === overlay.webContents) turnOff(); return true; });
  ipcMain.handle("recast:permission", () => {
    if (process.platform !== "darwin") return canGrab(false);
    canGrab(true); void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    startHook();
    return canGrab(false);
  });
  ipcMain.handle("recast:save-inbox", (_e, state: unknown) => { if (state && typeof state === "object") writePrivate(inboxFile(), state); return true; });
  ipcMain.handle("recast:history", () => history().filter((h) => !h.removed));
  ipcMain.handle("recast:history-add", (_e, entry: unknown) => {
    const x = (entry ?? {}) as Partial<Entry>; const id = clean(x.id, 80); const text = clean(x.text, 2000);
    if (!id || !text) return false;
    const s = (x.source ?? {}) as Entry["source"] & object;
    const list = history();
    if (!list.some((h) => h.id === id)) list.push({ id, text, kind: clean(x.kind, 20) ?? "text", at: new Date().toISOString(),
      source: { ...(clean(s.app, 120) ? { app: clean(s.app, 120)! } : {}), ...(clean(s.url, 2000) ? { url: clean(s.url, 2000)! } : {}), ...(clean(s.title, 200) ? { title: clean(s.title, 200)! } : {}) } });
    saveHistory(list); return true;
  });
  ipcMain.handle("recast:history-placed", (_e, ids: unknown, where: unknown, linkUrl: unknown) => {
    if (!Array.isArray(ids) || typeof where !== "string") return false;
    const list = history();
    for (const h of list) if (ids.includes(h.id)) (h.placed ??= []).push({ where: where.slice(0, 120), at: new Date().toISOString(), ...(typeof linkUrl === "string" && /^https:\/\//.test(linkUrl) ? { link: linkUrl } : {}) });
    saveHistory(list); return true;
  });
  ipcMain.handle("recast:history-remove", (_e, id: unknown) => { const list = history(); for (const h of list) if (h.id === id) h.removed = true; saveHistory(list); return true; });
  ipcMain.handle("recast:clipboard", async () => (await clipboard.readText()).slice(0, 2000));
  ipcMain.handle("recast:copy", (_e, text: unknown) => { if (typeof text === "string") clipboard.writeText(text.slice(0, 20000)); return true; });
  ipcMain.handle("recast:settings", (_e, p: unknown) => {
    const q = (p ?? {}) as Partial<Settings>; const ok: Partial<Settings> = {};
    if (q.theme === "system" || q.theme === "dark" || q.theme === "light") ok.theme = q.theme;
    if (q.shortcuts && typeof q.shortcuts.open === "string" && typeof q.shortcuts.capture === "string") ok.shortcuts = { open: q.shortcuts.open, capture: q.shortcuts.capture };
    setSettings(ok); return publicSettings();
  });
  ipcMain.handle("recast:google", async (_e, g: unknown) => {
    const c = (g ?? {}) as Partial<GoogleConfig>;
    const id = String(c.clientId ?? "").trim(), secret = String(c.clientSecret ?? "").trim();
    if (!id.endsWith(".apps.googleusercontent.com")) return { ok: false, message: "The Client ID ends with .apps.googleusercontent.com. Copy it again from Google Cloud → Credentials." };
    if (secret.length < 10) return { ok: false, message: "That Client secret looks too short. Copy it again." };
    writePrivate(googleFile(), { clientId: id, clientSecret: secret }); await startLink();
    return { ok: true, message: "Saved. Now sign in with Google in your browser." };
  });
  ipcMain.handle("recast:google-status", () => ({ configured: !!readJson<GoogleConfig | null>(googleFile(), null), serverNote }));
  ipcMain.handle("recast:window", (e, what: unknown) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (what === "hide") w?.hide(); else if (what === "minimize") w?.minimize();
    else if (what === "connections") openConnections(); else if (what === "playground") openPlayground();
    else if (what === "library") showLibrary(); else if (what === "on") void turnOn(false);
    else if (what === "screen-permission" && process.platform === "darwin") void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    else if (what === "signin") void shell.openExternal(`http://localhost:${PORT}/`);
    return true;
  });
}

app.whenReady().then(async () => {
  const saved = readJson<Partial<Settings>>(settingsFile(), {});
  settings = { ...DEFAULTS, ...saved, shortcuts: { ...DEFAULTS.shortcuts, ...(saved.shortcuts ?? {}) } };
  if (process.platform === "darwin" && settings.shortcuts.open === OLD_MAC_OPEN) settings.shortcuts.open = DEFAULTS.shortcuts.open;
  nativeTheme.themeSource = settings.theme;
  nativeTheme.on("updated", applyTheme);
  ipc(); await startLink(); registerShortcuts(); buildTray();
  createOverlay(); createLibrary(); startHook();
});
app.on("second-instance", showLibrary);
app.on("activate", showLibrary);
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { globalShortcut.unregisterAll(); hook.stop(); server?.close(); void stopReading(); });
app.on("window-all-closed", () => { /* keeps running: the trigger works with no window open */ });
