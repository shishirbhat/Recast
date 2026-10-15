import type { ApiType } from "./types";

/** One reading of the text as one kind of thing. `score` ranks readings against each other; `conf` is per field. */
export interface Reading {
  type: ApiType;
  fields: Record<string, unknown>;
  conf: Record<string, number>;
  spans: Record<string, [number, number]>;
  score: number;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d\s().-]{6,18}\d/g;
const PARTICLES = new Set(["de", "da", "di", "van", "von", "bin", "ibn", "al", "el", "le", "la", "du", "del", "der", "den", "ben", "mc", "mac"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const trimPunct = (s: string) => s.replace(/^[\s,;:|()<>[\]"'–—-]+|[\s,;:|()<>[\]"'–—-]+$/g, "");

/** A person's name: 1 to 5 words, each capitalised (or an initial or a known particle), no digits. */
export function looksLikeName(s: string): boolean {
  const t = collapse(s); if (!t || t.length > 60 || /\d/.test(t)) return false;
  const words = t.split(" "); if (words.length > 5) return false;
  return words.every((w) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w) || PARTICLES.has(w.toLowerCase()));
}

function emails(text: string) { return [...text.matchAll(EMAIL)].map((m) => ({ v: m[0].toLowerCase(), at: [m.index!, m.index! + m[0].length] as [number, number] })); }
function phones(text: string) {
  const out: { v: string; at: [number, number] }[] = [];
  for (const m of text.matchAll(PHONE)) {
    const raw = m[0]; const digits = raw.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) continue;                                  // an ISO date, not a number
    const before = text.slice(Math.max(0, m.index! - 2), m.index!);
    if (/[$₹€£]\s?$/.test(before)) continue;                                        // a price
    out.push({ v: (raw.trim().startsWith("+") ? "+" : "") + digits, at: [m.index!, m.index! + raw.length] });
  }
  return out;
}

// ---- Person ---------------------------------------------------------------------------------------
export function readPerson(text: string): Reading | null {
  const em = emails(text), ph = phones(text);
  const firstAt = Math.min(...[...em, ...ph].map((x) => x.at[0]), text.length);
  let name = ""; let nameAt: [number, number] | null = null;
  const lead = text.slice(0, firstAt).replace(/[<(]\s*$/, "");
  const cand = trimPunct(lead.split(/[,;|\n]/)[0] ?? "");
  if (cand && looksLikeName(cand)) { name = collapse(cand); nameAt = [text.indexOf(cand), text.indexOf(cand) + cand.length]; }
  if (!name) {
    for (const m of text.matchAll(/\(([^()]{2,60})\)/g)) { if (looksLikeName(m[1]!)) { name = collapse(m[1]!); nameAt = [m.index! + 1, m.index! + 1 + m[1]!.length]; break; } }
  }
  if (!name) return null;
  const hasContact = em.length > 0 || ph.length > 0;
  if (!hasContact && (collapse(trimPunct(text)) !== name || name.split(" ").length < 2)) return null;   // a bare name must be the whole text, or it is just the first word of something else
  const fields: Record<string, unknown> = { name }; const conf: Record<string, number> = { name: hasContact ? 0.72 : 0.4 }; const spans: Record<string, [number, number]> = { name: nameAt! };
  if (em.length) { fields.email = [...new Set(em.map((e) => e.v))]; conf.email = 0.97; spans.email = em[0]!.at; }
  if (ph.length) { fields.phone = [...new Set(ph.map((p) => p.v))]; conf.phone = 0.8; spans.phone = ph[0]!.at; }
  return { type: "Person", fields, conf, spans, score: em.length ? 0.95 : ph.length ? 0.85 : 0.45 };
}

// ---- Event ----------------------------------------------------------------------------------------
const pad = (n: number | string) => String(n).padStart(2, "0");
function validDate(y: number, m: number, d: number) { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; }
function time(h: string | undefined, min: string | undefined, ap: string | undefined): string | null {
  if (h === undefined) return null; let hh = +h; const mm = min ? +min : 0;
  if (ap) { const pm = ap.toLowerCase() === "pm"; if (hh < 1 || hh > 12) return null; hh = (hh % 12) + (pm ? 12 : 0); }
  return hh <= 23 && mm <= 59 ? `${pad(hh)}:${pad(mm)}` : null;
}
const MON = `(${MONTHS.map((m) => m[0]!.toUpperCase() + m.slice(1)).join("|")})[a-z]*\\.?`;
const TIME = `(?:[,\\s]+(?:at\\s+|@\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?`;
const DATE_FORMS: { re: RegExp; read: (m: RegExpMatchArray) => { y: number; mo: number; d: number; t: string | null } | null }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2}))?\b/, read: (m) => ({ y: +m[1]!, mo: +m[2]!, d: +m[3]!, t: m[4] ? time(m[4], m[5], undefined) : null }) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(\\d{4})${TIME}`, "i"), read: (m) => ({ y: +m[3]!, mo: MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, d: +m[1]!, t: time(m[4], m[5], m[6]) }) },
  { re: new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${TIME}`, "i"), read: (m) => ({ y: +m[3]!, mo: MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, d: +m[2]!, t: time(m[4], m[5], m[6]) }) },
];
export const RELATIVE = /\b(today|tonight|tomorrow|yesterday|next\s+\w+|this\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

export function readEvent(text: string): Reading | null {
  for (const f of DATE_FORMS) {
    const m = text.match(f.re); if (!m) continue;
    const r = f.read(m); if (!r || !validDate(r.y, r.mo, r.d)) continue;
    const start = `${r.y}-${pad(r.mo)}-${pad(r.d)}${r.t ? "T" + r.t : ""}`;
    const rest = text.slice(0, m.index!) + " " + text.slice(m.index! + m[0].length);
    const title = trimPunct(collapse(rest).replace(/\b(on|at|from|starts?|starting)\s*$/i, "").replace(/^\s*(on|at)\s+/i, ""));
    if (title.length < 2 || emails(title).length) return null;
    return { type: "Event", fields: { title, start }, conf: { title: 0.75, start: f.re.source.startsWith("\\b(\\d{4})") ? 0.97 : 0.9 }, spans: { start: [m.index!, m.index! + m[0].length] }, score: r.t ? 0.9 : 0.8 };
  }
  return null;
}

// ---- Location -------------------------------------------------------------------------------------
const STREET = /\b(street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr|marg|nagar|cross|main|highway|hwy|circle|square|sq)\b\.?/i;
const POSTAL = /(?:\b\d{6}\b|\b\d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b)\s*(?:,?\s*[A-Za-z ]{2,20})?$/;
export function looksLikeAddress(s: string): boolean {
  const t = collapse(s); if (t.length < 8 || t.length > 200) return false;
  if (/https?:\/\/|@|\barxiv\b|\bdoi\b|10\.\d{4,}\//i.test(t)) return false;
  const streety = /\d/.test(t) && STREET.test(t); const postal = POSTAL.test(t) && /,/.test(t);
  return streety || postal;
}
export function readLocation(text: string): Reading | null {
  const t = collapse(text); if (!looksLikeAddress(t)) return null;
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  const first = parts[0] ?? "";
  const nameLike = parts.length > 1 && !/\d/.test(first) && !STREET.test(first) && first.length <= 60;
  const address = nameLike ? parts.slice(1).join(", ") : t;
  if (!address) return null;
  const fields: Record<string, unknown> = { address }; const conf: Record<string, number> = { address: 0.85 };
  const spans: Record<string, [number, number]> = { address: [text.indexOf(address.split(",")[0]!), text.length] };
  if (nameLike) { fields.name = first; conf.name = 0.6; spans.name = [text.indexOf(first), text.indexOf(first) + first.length]; }
  return { type: "Location", fields, conf, spans, score: POSTAL.test(t) && STREET.test(t) ? 0.85 : 0.7 };
}

// ---- Product --------------------------------------------------------------------------------------
const CUR: Record<string, string> = { "$": "USD", "₹": "INR", "€": "EUR", "£": "GBP", rs: "INR", inr: "INR", usd: "USD", eur: "EUR", gbp: "GBP" };
const PRICE = /(?:(\$|₹|€|£|Rs\.?|INR|USD|EUR|GBP)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(INR|USD|EUR|GBP)\b)/i;
export function readProduct(text: string): Reading | null {
  const m = text.match(PRICE); if (!m) return null;
  const sym = (m[1] ?? m[4])!.toLowerCase().replace(".", ""); const amount = Number((m[2] ?? m[3])!.replace(/,/g, ""));
  const currency = CUR[sym]; if (!currency || !Number.isFinite(amount)) return null;
  const rest = text.slice(0, m.index!) + " " + text.slice(m.index! + m[0].length);
  const name = trimPunct(collapse(rest).replace(/\b(price|priced at|for|only|buy|at|now|just|@)\b\s*$/i, "").replace(/^(buy|get|order)\s+/i, ""));
  if (name.length < 2 || name.length > 120 || emails(name).length) return null;
  return { type: "Product", fields: { name, price: { amount, currency } }, conf: { name: 0.7, price: 0.9 }, spans: { price: [m.index!, m.index! + m[0].length] }, score: 0.8 };
}

// ---- Paper ----------------------------------------------------------------------------------------
export function readPaper(text: string): Reading | null {
  const doi = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+[A-Za-z0-9]/);
  const ax = text.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?|arXiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (!doi && !ax) return null;
  let rest = text.replace(/https?:\/\/\S+/gi, " "); for (const m of [doi, ax]) if (m) rest = rest.replace(m[0], " ");
  const yearM = rest.match(/\(((?:19|20)\d{2})\)/); if (yearM) rest = rest.replace(yearM[0], " ");
  const title = trimPunct(collapse(rest.replace(/\b(doi|arxiv|https?:\/\/(?:dx\.)?doi\.org\/?)\b[:\s]*/gi, " ")));
  if (title.split(" ").length < 2 || title.length < 8) return null;      // an identifier alone gives no title: the schema requires one
  const fields: Record<string, unknown> = { title }; const conf: Record<string, number> = { title: 0.7 }; const spans: Record<string, [number, number]> = {};
  if (doi) { fields.doi = doi[0].toLowerCase(); conf.doi = 0.97; spans.doi = [doi.index!, doi.index! + doi[0].length]; }
  if (ax) { fields.arxivId = (ax[1] ?? ax[2])!; conf.arxivId = 0.97; }
  if (yearM) { fields.year = +yearM[1]!; conf.year = 0.9; }
  return { type: "Paper", fields, conf, spans, score: 0.9 };
}

// ---- Document (a titled link) -----------------------------------------------------------------------
export function readDocument(text: string): Reading | null {
  const m = text.match(/https?:\/\/[^\s<>"')]+/i); if (!m) return null;
  const url = m[0].replace(/[.,;:!?]+$/, "");
  const title = trimPunct(collapse((text.slice(0, m.index!) + " " + text.slice(m.index! + m[0].length)).replace(/\b(link|url|see|read|at)\s*[:-]?\s*$/i, "")));
  if (title.length < 3 || title.length > 200 || emails(title).length) return null;
  return { type: "Document", fields: { title, url }, conf: { title: 0.7, url: 0.97 }, spans: { url: [m.index!, m.index! + url.length] }, score: 0.7 };
}

export function allReadings(text: string): Reading[] {
  return [readPerson(text), readEvent(text), readLocation(text), readProduct(text), readPaper(text), readDocument(text)].filter((r): r is Reading => r !== null).sort((a, b) => b.score - a.score);
}
