// Recast for the desktop: the capsule in its own small window, a tray icon, two global shortcuts, and the local program
// (apps/calendar-link) running inside the app, so Google, GitHub and Linear work without a terminal.
//
// Security: the windows have no Node (context isolation, sandbox); the page talks to this process only through the few
// calls in preload.ts. Tokens and the Google client secret stay in this process and on disk (readable only by this user),
// never in a page. Sign-in happens in the person's own browser (Google refuses embedded browsers, and it is the safer
// pattern for a desktop app).
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from "electron";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createLink } from "../../calendar-link/src/server.js";

type Theme = "system" | "dark" | "light";
interface Settings { theme: Theme; keepOnTop: boolean; shortcuts: { open: string; capture: string } }
interface GoogleConfig { clientId: string; clientSecret: string }
const DEFAULTS: Settings = { theme: "system", keepOnTop: true, shortcuts: { open: "CommandOrControl+Shift+Space", capture: "CommandOrControl+Alt+Space" } };
const PORT = 8787;
const DARK_BG = "#141311", LIGHT_BG = "#faf9f6";

// Tests run the built app with their own data folder and a stand-in for Google; a packaged app never reads these.
const test = !app.isPackaged && process.env["RECAST_TEST"] === "1";
if (test && process.env["RECAST_USER_DATA"]) app.setPath("userData", process.env["RECAST_USER_DATA"]);
if (!app.requestSingleInstanceLock()) app.quit();

const data = () => app.getPath("userData");
const secrets = () => path.join(data(), "secrets");
const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; } };
const writePrivate = (file: string, value: unknown) => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); chmodSync(file, 0o600); };
let settings: Settings = { ...DEFAULTS };
const settingsFile = () => path.join(data(), "settings.json");
const googleFile = () => path.join(secrets(), "google-app.json");
const inboxFile = () => path.join(data(), "inbox.json");

let main: BrowserWindow | null = null, connections: BrowserWindow | null = null, playground: BrowserWindow | null = null;
let tray: Tray | null = null;
let link: ReturnType<typeof createLink> | null = null, server: Server | null = null, serverNote = "";
const shortcutProblems: string[] = [];
let quitting = false;

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

function applyTheme() {
  nativeTheme.themeSource = settings.theme;
  for (const w of [main, connections, playground]) if (w && !w.isDestroyed()) { w.setBackgroundColor(bg()); w.webContents.send("recast:theme", nativeTheme.shouldUseDarkColors ? "dark" : "light"); }
}

/** Every window: no Node, no navigation away, links to the web go to the person's browser. */
function harden(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url) || url.startsWith(`http://localhost:${PORT}/`)) void shell.openExternal(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) { e.preventDefault(); if (/^https:\/\//.test(url)) void shell.openExternal(url); } });
}
const webPreferences = { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false };

function createMain() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 440, h = 640;
  main = new BrowserWindow({
    width: w, height: h, minWidth: 360, minHeight: 480, x: workArea.x + workArea.width - w - 24, y: workArea.y + workArea.height - h - 24,
    show: false, frame: process.platform === "darwin", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: bg(), alwaysOnTop: settings.keepOnTop, title: "Recast", webPreferences,
    ...(process.platform === "darwin" ? { vibrancy: "under-window" as const, visualEffectState: "active" as const } : {}),
  });
  harden(main);
  void main.loadFile(page("index.html"));
  main.once("ready-to-show", () => { if (!test || process.env["RECAST_SHOW"] !== "0") main?.show(); });
  // Closing hides: Recast keeps running in the tray, with its objects. Quit from the tray.
  main.on("close", (e) => { if (!quitting) { e.preventDefault(); main?.hide(); } });
}
function showMain() { if (!main || main.isDestroyed()) createMain(); main!.show(); main!.focus(); }
function toggleMain() { if (main?.isVisible() && main.isFocused()) main.hide(); else showMain(); }

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

/** What is copied now, as a capture for the capsule (the app it came from is not knowable; it is said to be the clipboard). */
async function captureClipboard() {
  const text = (await clipboard.readText()).trim();
  showMain();
  main!.webContents.send("recast:capture", text ? { text: text.slice(0, 2000), from: "clipboard" } : { text: "", from: "clipboard" });
}

function registerShortcuts() {
  globalShortcut.unregisterAll(); shortcutProblems.length = 0;
  const reg = (accel: string, fn: () => void, what: string) => {
    try { if (!globalShortcut.register(accel, fn)) shortcutProblems.push(`${accel} (${what}) is taken by another app`); }
    catch { shortcutProblems.push(`${accel} (${what}) is not a valid shortcut`); }
  };
  reg(settings.shortcuts.open, toggleMain, "open Recast");
  reg(settings.shortcuts.capture, () => void captureClipboard(), "capture what you copied");
}

function trayIcon() {
  const img = nativeImage.createFromPath(page(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img;
}
function buildTray() {
  if (!tray) { tray = new Tray(trayIcon()); tray.setToolTip("Recast"); tray.on("click", toggleMain); }
  const pretty = (a: string) => a.replace("CommandOrControl", process.platform === "darwin" ? "⌘" : "Ctrl").replace("Alt", process.platform === "darwin" ? "⌥" : "Alt").replace(/\+/g, process.platform === "darwin" ? "" : "+");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open Recast    ${pretty(settings.shortcuts.open)}`, click: showMain },
    { label: `Capture what you copied    ${pretty(settings.shortcuts.capture)}`, click: () => void captureClipboard() },
    { type: "separator" },
    { label: "Try the playground (sample data)", click: openPlayground },
    { label: "Connections…", click: openConnections },
    { label: "Appearance", submenu: (["system", "dark", "light"] as Theme[]).map((t) => ({ label: t === "system" ? "Match the system" : t === "dark" ? "Dark" : "Light", type: "radio" as const, checked: settings.theme === t, click: () => setSettings({ theme: t }) })) },
    { label: "Keep Recast on top", type: "checkbox", checked: settings.keepOnTop, click: (i) => setSettings({ keepOnTop: i.checked }) },
    { type: "separator" },
    { label: "Quit Recast", click: () => { quitting = true; app.quit(); } },
  ]));
}
function setSettings(p: Partial<Settings>) {
  settings = { ...settings, ...p, shortcuts: { ...settings.shortcuts, ...(p.shortcuts ?? {}) } };
  writePrivate(settingsFile(), settings);
  if (p.theme) applyTheme();
  if (p.keepOnTop !== undefined) main?.setAlwaysOnTop(settings.keepOnTop);
  if (p.shortcuts) registerShortcuts();
  buildTray();
  main?.webContents.send("recast:settings", publicSettings());
}
const publicSettings = () => ({ ...settings, platform: process.platform, shortcutProblems: [...shortcutProblems], serverNote, version: app.getVersion() });

// ---- the page's few calls ---------------------------------------------------------------------------------------------
const DESTS = new Set(["calendar", "gmail", "tasks", "docs", "github", "linear"]);
function ipc() {
  ipcMain.handle("recast:boot", () => ({ settings: publicSettings(), inbox: readJson<unknown>(inboxFile(), null), theme: nativeTheme.shouldUseDarkColors ? "dark" : "light" }));
  ipcMain.handle("recast:status", async () => (link ? (await link.direct("status", {})).body : {}));
  ipcMain.handle("recast:act", async (_e, route: unknown, body: unknown) => {
    // Only the three operations, only to the destinations this program serves; the program checks the rest.
    if (!link || (route !== "commit" && route !== "reconcile" && route !== "undo") || !body || typeof body !== "object") return { status: 400, body: { error: "not allowed" } };
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
  ipcMain.handle("recast:save-inbox", (_e, state: unknown) => { if (state && typeof state === "object") writePrivate(inboxFile(), state); return true; });
  ipcMain.handle("recast:clipboard", async () => (await clipboard.readText()).slice(0, 2000));
  ipcMain.handle("recast:copy", (_e, text: unknown) => { if (typeof text === "string") clipboard.writeText(text); return true; });
  ipcMain.handle("recast:settings", (_e, p: unknown) => {
    const q = (p ?? {}) as Partial<Settings>; const ok: Partial<Settings> = {};
    if (q.theme === "system" || q.theme === "dark" || q.theme === "light") ok.theme = q.theme;
    if (typeof q.keepOnTop === "boolean") ok.keepOnTop = q.keepOnTop;
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
    else if (what === "signin") void shell.openExternal(`http://localhost:${PORT}/`);
    return true;
  });
}

app.whenReady().then(async () => {
  settings = { ...DEFAULTS, ...readJson<Partial<Settings>>(settingsFile(), {}), shortcuts: { ...DEFAULTS.shortcuts, ...(readJson<Partial<Settings>>(settingsFile(), {}).shortcuts ?? {}) } };
  nativeTheme.themeSource = settings.theme;
  nativeTheme.on("updated", applyTheme);
  if (process.platform === "darwin") app.dock?.hide();   // a tray app on the Mac: no Dock icon, like other menu-bar tools
  ipc(); await startLink(); registerShortcuts(); buildTray(); createMain();
});
app.on("second-instance", showMain);
app.on("activate", showMain);
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { globalShortcut.unregisterAll(); server?.close(); });
app.on("window-all-closed", () => { /* stays in the tray */ });
