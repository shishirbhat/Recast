// The only door between Recast's pages and the app. Each call is narrow; the app checks every argument again.
import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = ["recast:capture", "recast:spots", "recast:theme", "recast:settings", "recast:grab-problem", "recast:on", "recast:escape", "recast:history"];
contextBridge.exposeInMainWorld("recastDesktop", {
  boot: () => ipcRenderer.invoke("recast:boot"),
  status: () => ipcRenderer.invoke("recast:status"),
  act: (route: "commit" | "reconcile" | "undo" | "verify", body: unknown) => ipcRenderer.invoke("recast:act", route, body),
  openExternal: (url: string) => ipcRenderer.invoke("recast:open-external", url),
  saveInbox: (state: unknown) => ipcRenderer.invoke("recast:save-inbox", state),
  interactive: (over: boolean, rects: unknown, own: unknown) => ipcRenderer.invoke("recast:interactive", over, rects, own),
  off: () => ipcRenderer.invoke("recast:off"),
  history: () => ipcRenderer.invoke("recast:history"),
  historyAdd: (entry: unknown) => ipcRenderer.invoke("recast:history-add", entry),
  historyPlaced: (ids: unknown, where: unknown, link?: unknown) => ipcRenderer.invoke("recast:history-placed", ids, where, link),
  historyRemove: (id: string) => ipcRenderer.invoke("recast:history-remove", id),
  clipboard: () => ipcRenderer.invoke("recast:clipboard"),
  copy: (text: string) => ipcRenderer.invoke("recast:copy", text),
  settings: (p: unknown) => ipcRenderer.invoke("recast:settings", p),
  google: (g: unknown) => ipcRenderer.invoke("recast:google", g),
  googleStatus: () => ipcRenderer.invoke("recast:google-status"),
  permission: () => ipcRenderer.invoke("recast:permission"),
  window: (what: string) => ipcRenderer.invoke("recast:window", what),
  on: (channel: string, fn: (v: unknown) => void) => {
    if (!CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, v) => fn(v));
  },
});
