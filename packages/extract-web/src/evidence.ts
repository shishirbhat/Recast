// Evidence: point a property at the place it came from, and check that the pointer is honest.
import type { Evidence } from "@recast/core";
import { bySelector, cssPath, norm, spacedText, tokens } from "./dom-util.js";
import { collectJsonLd } from "./signals.js";

export const flatten = (v: unknown): string[] =>
  typeof v === "string" ? [v] : typeof v === "number" || typeof v === "boolean" ? [String(v)] :
  Array.isArray(v) ? v.flatMap(flatten) : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : [];

/** True when every word of some value appears in `text`. Tolerant of case, spacing and punctuation. */
export function textMatches(text: string, values: string[]): boolean {
  const have = new Set(tokens(text));
  return values.some((v) => { const t = tokens(v); return t.length > 0 && t.every((x) => have.has(x)); });
}

export interface Resolved { ok: boolean; element: Element | null }

export function createResolver(doc: Document) {
  let ld: ReturnType<typeof collectJsonLd> | undefined;
  return function resolveEvidence(ev: Evidence, value: unknown): Resolved {
    const values = flatten(value);
    const { kind, value: loc } = ev.locator;
    if (kind === "css") {
      const el = bySelector(doc, loc);
      if (!el) return { ok: false, element: null };
      // The value may be the element's text, or one of its attributes (href, src, content, datetime, value).
      const attrs = ["href", "src", "content", "datetime", "value", "alt", "title"].map((a) => el.getAttribute(a)).filter((x): x is string => !!x);
      const abs = (u: string) => { try { return new URL(u, doc.baseURI).href; } catch { return u; } };
      const viaAttr = attrs.some((a) => values.some((v) => a === v || abs(a) === v || textMatches(a, [v])));
      return { ok: textMatches(el.textContent ?? "", values) || textMatches(spacedText(el), values) || viaAttr, element: el };
    }
    if (kind === "meta") {
      const m = /^(.*)\[(\d+)\]$/.exec(loc);
      if (!m) return { ok: false, element: null };
      const wanted = m[1]!.toLowerCase();
      const els = [...doc.querySelectorAll("meta")].filter((e) => {
        const n = (e.getAttribute("name") ?? e.getAttribute("property") ?? "").toLowerCase();
        return n === wanted && (e.getAttribute("content") ?? "").trim() !== "";
      });
      const el = els[Number(m[2])] ?? null;
      return { ok: !!el && textMatches(el.getAttribute("content") ?? "", values), element: el };
    }
    if (kind === "jsonld") {
      ld ??= collectJsonLd(doc);
      const parts = loc.split("/").slice(1);
      let cur: unknown = ld.docs[Number(parts[0])];
      for (const p of parts.slice(1)) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
      return { ok: cur !== undefined && textMatches(flatten(cur).join(" "), values), element: ld.scripts[Number(parts[0])] ?? null };
    }
    return { ok: false, element: null };
  };
}

// ---- corroboration: also point at where the value is visible on the page ----
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);
export function buildTextIndex(doc: Document): { el: Element; text: string }[] {
  const out: { el: Element; text: string }[] = [];
  const body = doc.body;
  if (!body) return out;
  const w = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n.parentElement;
    if (!el) continue;
    let skip = false;
    for (let p: Element | null = el; p; p = p.parentElement) if (SKIP.has(p.tagName)) { skip = true; break; }
    const t = norm(n.textContent ?? "");
    if (!skip && t.length >= 2) out.push({ el, text: t.toLowerCase() });
  }
  return out;
}

export function corroborate(index: { el: Element; text: string }[], value: unknown): Evidence | undefined {
  const cands = flatten(value).map(norm).filter((s) => s.length >= 3 && s.length <= 200 && !/^https?:\/\//i.test(s));
  const first = cands[0];
  if (!first) return undefined;
  const needle = first.toLowerCase();
  let best: { el: Element; len: number } | undefined;
  for (const t of index) if (t.text.includes(needle) && (!best || t.text.length < best.len)) best = { el: t.el, len: t.text.length };
  if (!best) return undefined;
  const start = norm(best.el.textContent ?? "").toLowerCase().indexOf(needle);
  return { locator: { kind: "css", value: cssPath(best.el) }, ...(start >= 0 ? { textRange: { start, end: start + needle.length } } : {}) };
}
