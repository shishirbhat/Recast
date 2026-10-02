import { createRoot } from "react-dom/client";
import type { View } from "@recast/interaction";
import { Overlay } from "./components.js";
import { OVERLAY_CSS } from "./css.generated.js";
import { createStore } from "./store.js";

/** Mounts the overlay in a shadow root, so page styles cannot reach it and its styles cannot leak into the page. */
export function mountOverlay(opts: { onUndo: () => void; parent?: HTMLElement }) {
  const host = document.createElement("recast-overlay");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  const mountPoint = document.createElement("div");
  shadow.append(style, mountPoint);
  (opts.parent ?? document.documentElement).appendChild(host);
  const store = createStore();
  const root = createRoot(mountPoint);
  root.render(<Overlay store={store} onUndo={opts.onUndo} />);
  return { host, update: (v: View) => store.update(v), destroy: () => { root.unmount(); host.remove(); } };
}
