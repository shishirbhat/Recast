/**
 * Text helpers for keeping a VS Code document and a shared Yjs text in step. No VS Code API here, so they can be tested
 * on their own.
 */

/** Length of the common prefix and (non-overlapping) common suffix of two strings. */
export function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  // Don't split a surrogate pair or a CRLF.
  while (prefix > 0 && (isLowSurrogate(a.charCodeAt(prefix)) || (a[prefix - 1] === "\r" && a[prefix] === "\n"))) prefix--;
  while (suffix > 0 && (isHighSurrogate(a.charCodeAt(a.length - suffix - 1)) || (a[a.length - suffix - 1] === "\r" && a[a.length - suffix] === "\n"))) suffix--;
  return { prefix, suffix };
}
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The single replacement that turns `from` into `to`: replace [start, end) of `from` with `insert`. */
export function replacement(from: string, to: string): { start: number; end: number; insert: string } | null {
  if (from === to) return null;
  const { prefix, suffix } = commonEnds(from, to);
  return { start: prefix, end: from.length - suffix, insert: to.slice(prefix, to.length - suffix) };
}


/** Fingerprint of a text: the same FNV-1a + length the Relay server computes (`textFingerprint` in src/server/files.ts). */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${h.toString(16)}`;
}

/** Where a kept copy goes when the original path is taken: next to it, marked as recovered, extension kept. */
export function recoveredName(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}.recovered${path.slice(dot)}` : `${path}.recovered`;
}

/** Can this be a shared text document? (Relay shares UTF-8 text up to 2 MB; the server checks again.) */
export function sharableText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  if (bytes.length > 2 * 1024 * 1024) return { ok: false, reason: "it's larger than 2 MB" };
  if (bytes.includes(0)) return { ok: false, reason: "it looks binary" };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (Buffer.byteLength(text, "utf8") !== bytes.length) return { ok: false, reason: "it isn't valid UTF-8" };
  return { ok: true, text };
}
