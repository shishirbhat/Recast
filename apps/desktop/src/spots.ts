// Spots: what on the screen a person is most likely to pick up, found in the words read off it (OCR). The same readers as
// a selection (pieceOfSelection): a time or date, an email address (a person), an error line; and a web address. Each spot
// is the exact words, with where they are, so Recast can highlight them in place. Pure: the words in, the spots out.
// Deliberately cautious: a highlight the person did not want is noise, so plain numbers, lone words and long prose are
// never spots. Anything not highlighted can still be selected by hand and lifted into a blob.
import { looksLikeError, readTime } from "@recast/core";

export interface Word { text: string; x0: number; y0: number; x1: number; y1: number }
export interface Line { words: Word[]; /** The whole line's box, when the reader gives one (it includes letters read too faintly to be words). */ box?: { x0: number; y0: number; x1: number; y1: number } }
export interface Spot { kind: "time" | "person" | "error" | "link"; text: string; x: number; y: number; width: number; height: number }

const EMAIL = /^[(<"']?[\w.+-]+@[\w-]+(\.[\w-]+)+[)>"',;:.]?$/;
const LINK = /^(https?:\/\/|www\.)\S{4,}$/i;
// A time or date has a shape before it is read: a clock time, a weekday or month name, a relative day, an ISO date.
const TIMEISH = /\b(\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2}|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|today|tomorrow|tonight|noon|midnight|\d{4}-\d{2}-\d{2})\b/i;
const MAX_TIME_WORDS = 6;

const strip = (t: string) => t.replace(/^[(<"'[]+|[)>"',;:.\]]+$/g, "");
function box(words: Word[]) {
  const x0 = Math.min(...words.map((w) => w.x0)), y0 = Math.min(...words.map((w) => w.y0));
  return { x: x0, y: y0, width: Math.max(...words.map((w) => w.x1)) - x0, height: Math.max(...words.map((w) => w.y1)) - y0 };
}

export function findSpots(lines: Line[], ctx: { now: string; timezone: string }): Spot[] {
  const out: Spot[] = [];
  for (const line of lines) {
    const words = line.words.filter((w) => w.text.trim());
    if (!words.length) continue;
    const lineText = words.map((w) => w.text).join(" ");
    // An error is the whole line: that is what a person files.
    if (lineText.length >= 8 && lineText.length <= 300 && looksLikeError(lineText)) { out.push({ kind: "error", text: lineText, ...box(line.box ? [{ text: "", ...line.box }, ...words] : words) }); continue; }
    const used = new Set<number>();
    words.forEach((w, i) => {
      const t = strip(w.text);
      if (EMAIL.test(w.text) && t.includes("@")) { out.push({ kind: "person", text: t.replace(/^mailto:/i, "").toLowerCase(), ...box([w]) }); used.add(i); }
      else if (LINK.test(t)) { out.push({ kind: "link", text: t, ...box([w]) }); used.add(i); }
    });
    // Times: the longest run of words that reads as one, never overlapping another spot.
    for (let i = 0; i < words.length; i++) {
      if (used.has(i)) continue;
      for (let n = Math.min(MAX_TIME_WORDS, words.length - i); n >= 1; n--) {
        const run = words.slice(i, i + n);
        if (run.some((_, k) => used.has(i + k))) continue;
        const text = strip(run.map((w) => w.text).join(" "));
        // A lone weekday or month ("Friday", "May") is too often just a word: a time needs a number or a relative day.
        if (!TIMEISH.test(text) || (n === 1 && !/\d|today|tomorrow|tonight|noon|midnight/i.test(text))) continue;
        if (!readTime(text, ctx)) continue;
        // Trim words at either end that the reading does not need ("Lunch with Arjun on Friday 1:00 PM," → "Friday 1:00 PM").
        const reading = (x: number, y: number) => JSON.stringify(readTime(strip(run.slice(x, y).map((w) => w.text).join(" ")), ctx));
        const full = reading(0, run.length);
        let a = 0, b = run.length;
        while (b - a > 1 && reading(a + 1, b) === full) a++;
        // "PM" or a zone changes nothing a default would not also say, but it is part of what the person reads: keep it.
        const meaningful = (w: Word) => /^(a\.?m\.?|p\.?m\.?|ist|utc|gmt|[pmce][sd]t|cet|cest|bst|jst|sgt|aest)[.,;:]?$/i.test(w.text);
        while (b - a > 1 && !meaningful(run[b - 1]!) && reading(a, b - 1) === full) b--;
        // Then grow it to the right while the next word still belongs to it ("Friday 1:00" + "PM").
        let end = i + b;   // index into words, one past the last kept word
        while (end < words.length && end - (i + a) < MAX_TIME_WORDS + 2 && !used.has(end)) {
          const next = words[end]!; const longer = strip(words.slice(i + a, end + 1).map((w) => w.text).join(" "));
          const now = JSON.stringify(readTime(strip(words.slice(i + a, end).map((w) => w.text).join(" ")), ctx)), then = JSON.stringify(readTime(longer, ctx));
          if (then === "null" || (!meaningful(next) && then === now)) break;
          end++;
        }
        b = end - i;
        const kept = words.slice(i + a, end);
        const keptText = strip(kept.map((w) => w.text).join(" "));
        if (kept.length === 1 && !/\d|today|tomorrow|tonight|noon|midnight/i.test(keptText)) continue;
        out.push({ kind: "time", text: keptText, ...box(kept) });
        for (let k = i + a; k < i + b; k++) used.add(k);
        i += b - 1;
        break;
      }
    }
  }
  return out;
}
