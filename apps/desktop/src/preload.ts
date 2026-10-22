// The only door between Recast's pages and the app. Each call is narrow; the app checks every argument again.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("recastDesktop", {
  boot: () => ipcRenderer.invoke("recast:boot"),
  status: () => ipcRenderer.invoke("recast:status"),
  act: (route: "commit" | "reconcile" | "undo", body: unknown) => ipcRenderer.invoke("recast:act", route, body),
  openExternal: (url: string) => ipcRenderer.invoke("recast:open-external", url),
  saveInbox: (state: unknown) => ipcRenderer.invoke("recast:save-inbox", state),
  clipboard: () => ipcRenderer.invoke("recast:clipboard"),
  copy: (text: string) => ipcRenderer.invoke("recast:copy", text),
  settings: (p: unknown) => ipcRenderer.invoke("recast:settings", p),
  google: (g: unknown) => ipcRenderer.invoke("recast:google", g),
  googleStatus: () => ipcRenderer.invoke("recast:google-status"),
  size: (mode: "compact" | "open") => ipcRenderer.invoke("recast:size", mode),
  permission: () => ipcRenderer.invoke("recast:permission"),
  window: (what: "hide" | "minimize" | "connections" | "playground" | "signin") => ipcRenderer.invoke("recast:window", what),
  on: (channel: "recast:capture" | "recast:theme" | "recast:settings" | "recast:grab-problem" | "recast:expand", fn: (v: unknown) => void) => {
    if (!["recast:capture", "recast:theme", "recast:settings", "recast:grab-problem", "recast:expand"].includes(channel)) return;
    ipcRenderer.on(channel, (_e, v) => fn(v));
  },
});
