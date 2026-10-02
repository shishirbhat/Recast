// Option A: classify what the user is pointing at. Given the element under the pointer, return candidates for
// the person, place, event or product it is part of. Deterministic rules over the element and its neighbours.
// It may return more than one reading of the same text ("Gramercy Tavern" is a plausible person and a plausible place).
// Every result is low confidence (0.45 to 0.7) and method "dom", so the trust model asks the user to check it.
import type { Candidate, Evidence, FieldMeta } from "@recast/core";
import { cssPath, norm, spacedText } from "./dom-util.js";

export interface ElementOptions { url: string; now: string }

const text = (el: Element) => norm(spacedText(el));

// ---- Person -------------------------------------------------------------------------------------------------
const NAME_LIKE = /^(?:(?:Dr|Prof|Mr|Ms|Mrs|Sir)\.?\s+)?\p{Lu}[\p{L}.'’-]*(?:\s+(?:(?:van|von|de|del|da|di|bin|al|el|la|le)\s+)?\p{Lu}[\p{L}.'’-]*){1,3}$/u;
// Words that make a capitalised phrase a label, a heading or an organisation rather than a person.
const NOT_A_NAME = new Set(("contact sign login log register policy terms privacy about home menu search cart account help support careers blog news shop store read more view learn get buy " +
  "subscribe join follow share download cookie cookies settings skip main content navigation toggle click here free new sale offers today us our team press events visit tickets book reserve " +
  "reservations order delivery gift cards conditions faq faqs language english directions hours location locations stories story history museum gallery park hotel hotels restaurant cafe garden gardens " +
  "university institute school college center centre church palace fort temple national international company inc ltd llc group foundation association society bank airlines airport station square street " +
  "road avenue lake river mount mountain island bay beach project website page site web online digital global world city county state republic kingdom united states india london paris york " +
  "delhi mumbai bangalore bengaluru tokyo berlin new old great grand royal public private open closed daily weekly monthly annual").split(" "));

function looksLikeName(s: string): boolean {
  if (s.length < 5 || s.length > 50 || !NAME_LIKE.test(s)) return false;
  return !s.toLowerCase().split(/[\s.,'’-]+/).some((w) => NOT_A_NAME.has(w));
}

const AUTHORISH = /(author|byline|speaker|profile|person|people|team|faculty|staff|member|contributor|creator)/i;
function nearby(el: Element, levels = 2): Element[] {
  const out: Element[] = []; let cur: Element | null = el;
  for (let i = 0; i <= levels && cur; i++, cur = cur.parentElement) out.push(cur);
  return out;
}
/** Find `sel` in the element's own "record": itself or an ancestor small enough to be about just this thing.
 *  An ancestor with lots of text is a whole list or page, and would hand back a NEIGHBOUR's link (the wrong person's email). */
const RECORD_MAX_TEXT = 200;
function within(el: Element, sel: string, levels = 2): Element | null {
  for (const n of nearby(el, levels)) {
    if (n !== el && text(n).length > RECORD_MAX_TEXT) break;
    const f = n.matches(sel) ? n : n.querySelector(sel);
    if (f) return f;
  }
  return null;
}

// ---- Location -----------------------------------------------------------------------------------------------
const POSTAL = /(\b\d{6}\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b|\b\d{5}(?:-\d{4})?\b|,\s?[A-Z]{2}\s\d{5}\b)/;
const STREET = /\b\d{1,5}[A-Za-z]?\s+[\p{L}0-9 .'’-]{2,40}\b(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Square|Sq|Marg|Nagar|Cross|Main|Floor)\b/iu;
function looksLikeAddress(s: string): boolean {
  if (s.length < 10 || s.length > 250) return false;
  if (/^[\d\s+()-]+$/.test(s) || /@/.test(s.replace(/[^\s]+@[^\s]+/g, ""))) return false;
  // Identifiers and links are full of digit runs that look like postal codes: arXiv:2302.13971, doi.org/10.48550/...
  if (/:\/\/|doi\.org|arxiv|\b\d+\.\d+\b|^\(|\[|\bpages?\b/i.test(s)) return false;
  const structured = s.includes(",") || /\n/.test(s);
  // An address ENDS at its postal code (or country). A long block of text that merely contains a postal code somewhere
  // (a whole pane, a paragraph about a venue) is not an address.
  const post = POSTAL.exec(s);
  const endsAtPostal = !!post && s.length - (post.index + post[0].length) <= 25;
  const sentences = (s.match(/[.!?]\s+\p{Lu}/gu) ?? []).length;
  return sentences <= 1 && ((endsAtPostal && structured && /[\p{L}]{3}/u.test(s)) || (STREET.test(s) && structured && s.length <= 140));
}
const cleanAddress = (s: string) => norm(s.replace(/[^\s]+@[^\s]+/g, " ").replace(/\b(toll[- ]free|tel(?:ephone)?|phone|fax)\b[:.]?[^A-Za-z]*/gi, " "));

// ---- Event / Product ----------------------------------------------------------------------------------------
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A date WITH a year, as ISO. Dates without a year are ambiguous and are not guessed. */
function dateWithYear(s: string): string | null {
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})[a-z]*\\.?,?\\s+(\\d{4})\\b`, "i").exec(s);
  if (m) return `${m[3]}-${String(MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = new RegExp(`\\b(${MONTH})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i").exec(s);
  if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}
const PRICE = /(?:₹|Rs\.?|INR|US\$|\$|£|€)\s?(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;
const CURRENCY: Record<string, string> = { "₹": "INR", "Rs": "INR", "INR": "INR", "US$": "USD", "$": "USD", "£": "GBP", "€": "EUR" };

function heading(el: Element): Element | null {
  for (const n of nearby(el, 4)) {
    const h = n.matches("h1,h2,h3,[itemprop~=name]") ? n : n.querySelector("h1,h2,h3,[itemprop~=name]");
    if (h && text(h).length >= 3 && text(h).length <= 140) return h;
  }
  const h1 = el.ownerDocument.querySelector("h1");
  return h1 && text(h1).length >= 3 ? h1 : null;
}

export function classifyElement(el: Element, opts: ElementOptions): Candidate[] {
  const doc = el.ownerDocument;
  const source = { app: new URL(opts.url).hostname, url: opts.url, ...(doc.title ? { title: doc.title.slice(0, 200) } : {}) };
  const prov = (adapter: string): Candidate["provenance"] => ({ source, capture: { method: "dom", adapter, at: opts.now } });
  const ev = (e: Element): Evidence => ({ locator: { kind: "css", value: cssPath(e) } });
  const f = (e: Element, confidence: number): FieldMeta => ({ confidence: Math.round(confidence * 100) / 100, evidence: [ev(e)] });
  const out: Candidate[] = [];
  const pageH1 = doc.querySelector("h1") ? text(doc.querySelector("h1")!).toLowerCase() : "";

  // Try the element itself, then up to two parents, keeping the smallest unit of text that means something.
  const units: Element[] = [];
  for (let cur: Element | null = el, i = 0; cur && i < 3 && cur !== doc.body; cur = cur.parentElement, i++) { if (text(cur).length >= 2 && text(cur).length <= 250) units.push(cur); }

  for (const u of units) {
    const t = text(u);

    // Person
    if (looksLikeName(t)) {
      // Capitalised menu/footer labels are everywhere, so a heading alone is weak evidence; a person page says more.
      let c = 0.4;
      if (u.closest("h1,h2,h3")) c += 0.05;
      if (nearby(u, 3).some((n) => n.matches("[itemprop~=name],[itemprop~=author],[rel~=author]") || AUTHORISH.test(`${n.getAttribute("class") ?? ""} ${n.getAttribute("id") ?? ""}`))) c += 0.1;
      const mail = within(u, 'a[href^="mailto:" i]'), tel = within(u, 'a[href^="tel:" i]');
      if (mail || tel) c += 0.1;
      if (pageH1 && (pageH1 === t.toLowerCase() || doc.title.toLowerCase().includes(t.toLowerCase()))) c += 0.15;
      const props: Record<string, unknown> = { name: t }, fields: Record<string, FieldMeta> = { name: f(u, c) };
      if (mail) {
        const addr = decodeURIComponent((mail.getAttribute("href") ?? "").replace(/^mailto:/i, "").split("?")[0] ?? "").trim().toLowerCase();
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { props["email"] = [addr]; fields["email"] = f(mail, c); }
      }
      out.push({ type: "Person", properties: props, fields, provenance: prov("dom-element") });
    }

    // Location from an address-like block
    if (looksLikeAddress(t) || u.matches("address,[itemprop~=address]")) {
      const addr = cleanAddress(t);
      if (addr.length >= 8 && !/^[\d\s+()-]+$/.test(addr)) {
        let c = 0.5;
        if (u.matches("address,[itemprop~=address]") || u.closest("address")) c += 0.1;
        if (within(u, 'a[href*="maps.google" i],a[href*="goo.gl/maps" i],a[href*="/maps/" i],a[href*="maps.apple" i]', 3)) c += 0.1;
        out.push({ type: "Location", properties: { address: addr }, fields: { address: f(u, c) }, provenance: prov("dom-element") });
      }
    }

    // Event from an explicit, dated <time> or a date with a year
    const timeEl = u.matches("time[datetime]") ? u : u.querySelector("time[datetime]");
    const iso = timeEl ? (/^\d{4}-\d{2}-\d{2}/.exec(timeEl.getAttribute("datetime") ?? "")?.[0] ?? null) : dateWithYear(t);
    if (iso && t.length <= 120) {
      const h = heading(u);
      if (h && h !== u) {
        // A date near a heading is also how publication dates look, so it is a weak reading unless the markup says "event".
        const explicit = !!(timeEl ?? u).closest("[itemprop~=startDate],[itemtype*=Event i]") || /(event|start|begin)/i.test(`${(timeEl ?? u).getAttribute("class") ?? ""} ${(timeEl ?? u).getAttribute("itemprop") ?? ""}`);
        const c = explicit ? 0.6 : 0.45;
        out.push({ type: "Event", properties: { title: text(h), start: iso }, fields: { title: f(h, c), start: f(timeEl ?? u, c) }, provenance: prov("dom-element") });
      }
    }

    // Product from a price next to a title
    const pm = PRICE.exec(t);
    if (pm && t.length <= 60) {
      const sym = /(₹|Rs\.?|INR|US\$|\$|£|€)/.exec(t)![1]!.replace(/\.$/, "");
      const amount = Number(pm[1]!.replace(/,/g, ""));
      const h = heading(u);
      if (h && Number.isFinite(amount) && CURRENCY[sym]) {
        const explicit = !!u.closest("[itemprop~=price],[itemprop~=offers],[itemtype*=Offer i]") || /(price|amount|cost)/i.test(`${u.getAttribute("class") ?? ""} ${u.getAttribute("itemprop") ?? ""} ${u.getAttribute("data-testid") ?? ""}`);
        const c = explicit ? 0.6 : 0.45;
        out.push({ type: "Product", properties: { name: text(h), price: { amount, currency: CURRENCY[sym]! } }, fields: { name: f(h, c), price: f(u, c) }, provenance: prov("dom-element") });
      }
    }

    // The smallest unit that meant anything wins; do not also report its parents.
    if (out.length) break;
  }
  // Any short, proper-noun-looking text can be read as a place NAME. This is a weak reading (0.4): the text alone does
  // not say it is a place, so it is never auto-selected. The user pointing at it, and a destination that accepts a
  // Location, are what make it meaningful. The largest qualifying unit wins ("Meera Iyer", not just "Meera").
  let weak: { u: Element; t: string } | null = null;
  for (const u of units) { const t = text(u); if (weakPlaceName(u, t)) weak = { u, t }; }
  if (weak) out.push({ type: "Location", properties: { name: weak.t }, fields: { name: f(weak.u, 0.4) }, provenance: prov("dom-element") });

  // Every plausible reading is returned, most confident first. The destination decides which one applies
  // (a calendar offers "attendee" for a Person and "location" for a Location).
  const score = (c: Candidate) => Math.min(...Object.values(c.fields).map((x) => x.confidence));
  return out.sort((a, b) => score(b) - score(a));
}

const DATEISH = new RegExp(`\\b${MONTH}[a-z]*\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b\\d{1,2}:\\d{2}\\b`, "i");
function weakPlaceName(u: Element, t: string): boolean {
  if (t.length < 3 || t.length > 80 || !/^\p{Lu}/u.test(t) || /[.!?]$/.test(t) || t.split(" ").length > 8) return false;
  if (/@|https?:/.test(t) || DATEISH.test(t) || PRICE.test(t)) return false;
  return u.matches("h1,h2,h3") || titleCase(t);
}

/** Most words start with a capital (allowing small joining words). */
function titleCase(t: string): boolean {
  const words = t.split(" ").filter((w) => /[\p{L}]/u.test(w) && !/^(of|the|and|de|la|le|du|des|in|at|for|to|a|an|&|-)$/i.test(w));
  return words.length >= 1 && words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length >= 0.75;
}

function findAddress(scope: Element): Element | null {
  const explicit = scope.querySelector("address,[itemprop~=address]");
  if (explicit && text(explicit).length >= 8) return explicit;
  for (const e of scope.querySelectorAll("p,div,span,li")) { if (e.children.length <= 3 && looksLikeAddress(text(e))) return e; }
  return null;
}
