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

