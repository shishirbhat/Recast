// Grab: what the person has selected in whichever app is in front, without them copying it, and where it came from.
//   Linux (X11): the highlighted text is the PRIMARY selection, readable directly; nothing is copied or changed.
//   macOS and Windows: Recast presses copy (⌘C / Ctrl+C) in the front app, reads it, then puts the person's clipboard back.
//          On a Mac that needs the Accessibility permission, which macOS asks for once; without it nothing is sent.
// The source is what the system can say: the app's name, its window title, and for a browser the page's address.
// Nothing is read that the person did not select.
import { clipboard, systemPreferences } from "electron";
import { execFile } from "node:child_process";

export interface Grabbed { text: string; app?: string; title?: string; url?: string }
export type GrabResult = { ok: true; grabbed: Grabbed } | { ok: false; reason: "permission" | "empty" | "unsupported"; message: string };

const run = (cmd: string, args: string[], timeout = 1500) => new Promise<string>((resolve) => {
  execFile(cmd, args, { timeout }, (err, out) => resolve(err ? "" : String(out).trim()));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const osa = (script: string, timeout = 1500) => run("osascript", ["-e", script], timeout);

const BROWSERS: Record<string, string> = {
  "Google Chrome": "chromium", "Google Chrome Canary": "chromium", Chromium: "chromium", "Brave Browser": "chromium", "Microsoft Edge": "chromium", Arc: "chromium", Vivaldi: "chromium", Opera: "chromium",
  Safari: "safari", "Safari Technology Preview": "safari",
};

/** macOS: the front app, and for a browser its page (needs the Automation permission per browser; refused → no address). */
async function macSource(): Promise<Omit<Grabbed, "text">> {
  const app = await osa('tell application "System Events" to get name of first application process whose frontmost is true');
  if (!app) return {};
  const kind = BROWSERS[app];
  if (kind === "safari") {
    const [url, title] = (await osa(`tell application "${app}" to get {URL, name} of front document`)).split(", ");
    return { app, ...(url ? { url } : {}), ...(title ? { title } : {}) };
  }
  if (kind === "chromium") {
    const out = await osa(`tell application "${app}" to get {URL, title} of active tab of front window`);
    const i = out.indexOf(", "); const url = i > 0 ? out.slice(0, i) : out; const title = i > 0 ? out.slice(i + 2) : "";
    return { app, ...(url ? { url } : {}), ...(title ? { title } : {}) };
  }
  const title = await osa(`tell application "System Events" to get name of front window of (first application process whose frontmost is true)`);
  return { app, ...(title ? { title } : {}) };
}

/** Linux (X11): the active window's application and title, when a window manager says which one is active. */
async function linuxSource(): Promise<Omit<Grabbed, "text">> {
  const active = (await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"])).match(/0x[0-9a-f]+/i)?.[0];
  if (!active || /^0x0+$/.test(active)) return {};
  const props = await run("xprop", ["-id", active, "WM_CLASS", "_NET_WM_NAME"]);
  const cls = props.match(/WM_CLASS\(STRING\) = "[^"]*", "([^"]*)"/)?.[1];
  const title = props.match(/_NET_WM_NAME\(UTF8_STRING\) = "(.*)"/)?.[1];
  return { ...(cls ? { app: cls } : {}), ...(title ? { title } : {}) };
}

/** Whether Recast may read selections here. On a Mac, asking shows the system prompt (once). */
export function canGrab(ask = false): boolean {
  if (process.platform === "darwin") return systemPreferences.isTrustedAccessibilityClient(ask);
  return process.platform === "linux" || process.platform === "win32";
}

/** Presses copy in the app in front (the keyboard hook's key tap); falls back to System Events on a Mac. */
export type CopyKeys = () => void;

/** Copy in the front app, read it, put the person's clipboard back. A copy that changes nothing means no selection. */
async function copyAndRead(copyKeys: CopyKeys): Promise<string> {
  const before = await clipboard.read().catch(() => null);   // every format the person had, to put back as it was
  const mark = `recast-grab-${Date.now()}-${Math.random()}`;
  await clipboard.writeText(mark);
  await sleep(120);   // the trigger's own keys are released first, so the app sees copy alone
  copyKeys();
  let text = "";
  for (let i = 0; i < 12; i++) { await sleep(40); const t = await clipboard.readText(); if (t !== mark) { text = t; break; } }
  if (before && before.length) await clipboard.write(before).catch(() => clipboard.clear()); else clipboard.clear();
  return text.trim();
}

export async function grabSelection(copyKeys?: CopyKeys): Promise<GrabResult> {
  if (process.platform === "linux") {
    const text = ((await clipboard.selection?.readText().catch(() => "")) ?? "").trim();
    if (!text) return { ok: false, reason: "empty", message: "Select some text first" };
    return { ok: true, grabbed: { text: text.slice(0, 2000), ...(await linuxSource()) } };
  }
  if (process.platform === "darwin") {
    if (!canGrab(false)) { canGrab(true); return { ok: false, reason: "permission", message: "Recast needs the Accessibility permission to read what you select" }; }
    const source = await macSource();
    const text = await copyAndRead(copyKeys ?? (() => void osa('tell application "System Events" to keystroke "c" using command down')));
    if (!text) return { ok: false, reason: "empty", message: "Select some text first" };
    return { ok: true, grabbed: { text: text.slice(0, 2000), ...source } };
  }
  if (process.platform === "win32" && copyKeys) {
    const text = await copyAndRead(copyKeys);
    if (!text) return { ok: false, reason: "empty", message: "Select some text first" };
    return { ok: true, grabbed: { text: text.slice(0, 2000) } };
  }
  return { ok: false, reason: "unsupported", message: "Grabbing a selection is not available on this system yet" };
}
