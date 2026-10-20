export const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
export const tokens = (s: string) => norm(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** CSS identifier escape (like CSS.escape): a leading digit must be written as a code point escape, e.g. "6a" -> "\\36 a". */
const esc = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c).replace(/^(-?)(\d)/, (_m, dash: string, d: string) => `${dash}\\3${d} `);

/** A short CSS path that uniquely finds `el` in its document. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.getAttribute("id");
    if (id && cur.ownerDocument.querySelectorAll(`#${esc(id)}`).length === 1) { parts.unshift(`${tag}#${esc(id)}`); break; }
    let n = 1;
    for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === cur.tagName) n++;
    parts.unshift(cur.parentElement ? `${tag}:nth-of-type(${n})` : tag);
  }
  return parts.join(" > ");
}

export function bySelector(doc: Document, path: string): Element | null {
  try { return doc.querySelector(path); } catch { return null; }
}

/** Text with a space between every text node, so <div>Bankside</div><div>London</div> is not "BanksideLondon". */
export function spacedText(el: Element): string {
  const w = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  const parts: string[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ");
}
