// Runs INSIDE the page (isolated world), injected on demand by the popup. It reads the DOM and returns plain JSON.
// It never touches the network, storage or cookies, and it never modifies the page except for a temporary highlight box.
import { createResolver, extractPage } from "@recast/extract-web";
import type { Evidence } from "@recast/core";

export interface CapturedObject {
  id: string; type: string; role: "primary" | "related";
  properties: Record<string, unknown>;
  fields: Record<string, { confidence: number; evidence: Evidence[] }>;
  adapter: string; method: string;
}
export interface Capture { url: string; title: string; objects: CapturedObject[]; rejected: number; ms: number; jsonLdParseFailures: number }

const HL = "data-recast-highlight";
let timer: number | undefined;

function clear() {
  if (timer) clearTimeout(timer);
  document.querySelectorAll(`[${HL}]`).forEach((n) => n.remove());
}

function capture(): Capture {
  const t0 = performance.now();
  const r = extractPage(document, { url: location.href, now: new Date().toISOString() });
  return {
    url: location.href, title: document.title.slice(0, 200), rejected: r.rejected.length, jsonLdParseFailures: r.diagnostics.jsonLdParseFailures,
    objects: r.objects.map((o) => ({
      id: o.id, type: o.type, role: r.roles[o.id] ?? "related", properties: o.properties as Record<string, unknown>,
      fields: o.fields as CapturedObject["fields"], adapter: o.provenance.capture.adapter, method: o.provenance.capture.method,
    })),
    ms: performance.now() - t0,
  };
}

/** Highlights the first visible element that evidences this property. Returns what it did. */
function highlight(ev: Evidence[], value: unknown): "shown" | "not-visible" | "not-found" {
  clear();
  const resolve = createResolver(document);
  let sawHidden = false;
  for (const e of ev) {
    const { ok, element } = resolve(e, value);
    if (!ok || !element) continue;
    if (element.closest("head, script, style") || element.tagName === "META") { sawHidden = true; continue; }
    element.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const box = document.createElement("div");
    box.setAttribute(HL, "");
    const place = () => {
      const r = element.getBoundingClientRect();
      box.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #2D50C8;border-radius:6px;background:rgba(45,80,200,.10);left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px`;
    };
    place();
    document.documentElement.appendChild(box);
    addEventListener("scroll", place, { passive: true, capture: true });
    timer = window.setTimeout(() => { removeEventListener("scroll", place, true); clear(); }, 4000);
    return "shown";
  }
  return sawHidden ? "not-visible" : "not-found";
}

(globalThis as unknown as { __recast: unknown }).__recast = { capture, highlight, clear };
