// Low-confidence heuristics for pages with no structured data. Deliberately narrow: each rule is
// something a person would also read off the page. Confidence is low so the trust model asks for
// confirmation. Nothing here uses OCR or vision.
import type { Candidate, Evidence, FieldMeta } from "@recast/core";
import { cssPath, norm, spacedText } from "./dom-util.js";

const DOM_CONF = { mailto: 0.6, address: 0.55 } as const;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// 2-4 words, each capitalised, letters/dots/hyphens/apostrophes only ("Meera Iyer", "Dr. A. P. J. Kalam").
const NAME_LIKE = /^(?:(?:Dr|Prof|Mr|Ms|Mrs)\.?\s+)?\p{Lu}[\p{L}.'’-]*(?:\s+\p{Lu}[\p{L}.'’-]*){1,3}$/u;

export function domCandidates(doc: Document, source: Candidate["provenance"]["source"], at: string): Candidate[] {
  const prov = (adapter: string): Candidate["provenance"] => ({ source, capture: { method: "dom", adapter, at } });
  const out: Candidate[] = [];
  const field = (el: Element, confidence: number, extra?: Evidence): FieldMeta => ({
    confidence, evidence: [{ locator: { kind: "css", value: cssPath(el) } }, ...(extra ? [extra] : [])],
  });

  const seen = new Set<string>();
  for (const a of [...doc.querySelectorAll('a[href^="mailto:" i]')].slice(0, 40)) {
    const email = decodeURIComponent((a.getAttribute("href") ?? "").replace(/^mailto:/i, "").split("?")[0] ?? "").trim().toLowerCase();
    const label = norm(a.textContent ?? "");
    if (!EMAIL.test(email) || !NAME_LIKE.test(label) || seen.has(email)) continue;
    seen.add(email);
    out.push({
      type: "Person", properties: { name: label, email: [email] },
      fields: { name: field(a, DOM_CONF.mailto), email: field(a, DOM_CONF.mailto) }, provenance: prov("dom-mailto"),
    });
  }

  for (const el of [...doc.querySelectorAll("address")].slice(0, 10)) {
    // <address> often also holds the phone number and email: keep only the postal part.
    const text = norm(spacedText(el).replace(/[^\s]+@[^\s]+/g, " ").replace(/\b(toll[- ]free|tel(?:ephone)?|phone|fax)\b[:.]?[^A-Za-z]*/gi, " "));
    // An address has to look like one: some length, and a digit or a comma-separated locality.
    if (text.length < 8 || text.length > 250 || !(/\d/.test(text) || text.includes(","))) continue;
    if (/^\+?[\d\s()-]+$/.test(text) || seen.has(text)) continue; // just a phone number
    seen.add(text);
    out.push({ type: "Location", properties: { address: text }, fields: { address: field(el, DOM_CONF.address) }, provenance: prov("dom-address") });
  }
  return out;
}
