// Collects raw structured signals from a Document. No interpretation happens here.
import { cssPath, norm } from "./dom-util.js";

export interface MetaTag { name: string; content: string }
export interface Signals {
  jsonld: { docs: unknown[]; scripts: Element[]; failures: number; total: number };
  meta: MetaTag[];
  microdata: { docs: unknown[]; elements: Map<string, Element> };
}

/** Real-world JSON-LD is often slightly invalid. Try strict, then a few safe repairs. */
export function parseLooseJson(text: string): unknown {
  const t = text.trim().replace(/^<!--/, "").replace(/-->$/, "").replace(/^\/\*<!\[CDATA\[\*\//, "").replace(/\/\*\]\]>\*\/$/, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const repaired = t
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/("(?:[^"\\]|\\.)*")/gs, (m) => m.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"))
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(repaired);
}

export function collectJsonLd(doc: Document): Signals["jsonld"] {
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json" i]')];
  const docs: unknown[] = [], ok: Element[] = [];
  let failures = 0;
  for (const s of scripts) {
    try { docs.push(parseLooseJson(s.textContent ?? "")); ok.push(s); } catch { failures++; }
  }
  return { docs, scripts: ok, failures, total: scripts.length };
}

export function collectMeta(doc: Document): MetaTag[] {
  const out: MetaTag[] = [];
  for (const m of doc.querySelectorAll("meta")) {
    const name = m.getAttribute("name") ?? m.getAttribute("property");
    const content = m.getAttribute("content");
    if (name && content !== null) out.push({ name, content });
  }
  return out;
}

const typeName = (t: string) => t.replace(/^.*[/#]/, "");
function itemValue(el: Element, walk: (e: Element) => unknown): unknown {
  if (el.hasAttribute("itemscope")) return walk(el);
  const tag = el.tagName.toLowerCase();
  if (tag === "meta") return el.getAttribute("content") ?? "";
  if (["a", "link", "area"].includes(tag)) return el.getAttribute("href") ?? "";
  if (["img", "audio", "video", "source", "embed", "iframe"].includes(tag)) return el.getAttribute("src") ?? "";
  if (tag === "time") return el.getAttribute("datetime") ?? norm(el.textContent ?? "");
  if (tag === "data" || tag === "meter") return el.getAttribute("value") ?? norm(el.textContent ?? "");
  return norm(el.textContent ?? "");
}

/** schema.org microdata -> JSON-LD-shaped nodes, remembering which element carried each property (at any depth). */
export function collectMicrodata(doc: Document): Signals["microdata"] {
  const elements = new Map<string, Element>();
  const docs: unknown[] = [];
  const nearestScope = (el: Element) => { for (let p = el.parentElement; p; p = p.parentElement) if (p.hasAttribute("itemscope")) return p; return null; };
  const walk = (scope: Element, prefix: string): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    const types = (scope.getAttribute("itemtype") ?? "").split(/\s+/).filter(Boolean).map(typeName);
    if (types.length) node["@type"] = types.length === 1 ? types[0] : types;
    for (const el of scope.querySelectorAll("[itemprop]")) {
      if (nearestScope(el) !== scope) continue;
      for (const prop of (el.getAttribute("itemprop") ?? "").split(/\s+/).filter(Boolean)) {
        const path = `${prefix}/${prop}`;
        if (!elements.has(path)) elements.set(path, el);
        const v = itemValue(el, (e) => walk(e, path));
        if (v === "" || v === undefined) continue;
        node[prop] = prop in node ? [...(Array.isArray(node[prop]) ? (node[prop] as unknown[]) : [node[prop]]), v] : v;
      }
    }
    return node;
  };
  for (const scope of doc.querySelectorAll("[itemscope][itemtype]")) {
    if (scope.hasAttribute("itemprop")) continue; // nested items are reached through their parent
    docs.push(walk(scope, `/${docs.length}`));
  }
  return { docs, elements };
}

export function collectSignals(doc: Document): Signals {
  return { jsonld: collectJsonLd(doc), meta: collectMeta(doc), microdata: collectMicrodata(doc) };
}
export { cssPath };
