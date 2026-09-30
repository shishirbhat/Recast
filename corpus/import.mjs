// Imports pages you saved from your own browser (for sites this sandbox cannot fetch).
//   1. Save each page: Chrome > Ctrl+S > "Webpage, HTML only" (or "Complete").
//   2. Put the files in corpus/pages-user/ and list them in corpus/pages-user/urls.txt, one per line:
//        <filename><TAB><category><TAB><the page's real URL>
//      category is one of: paper event place person product negative
//   3. node import.mjs [--reduce]
//   Optional, BEFORE you push saved pages to a public repo: node import.mjs --reduce-only
//   rewrites the files in pages-user/ in place with the reduction below (no manifest changes).
// Imported pages go to corpus/pages/ (gitignored). They are marked source "user-saved" and use the same
// deterministic dev/held-out split as fetched pages. Re-running is safe (idempotent).
// --reduce strips scripts (except JSON-LD), styles, SVG, iframes, noscript, comments, data: URIs and form values,
// so a file is small and carries less personal data. It keeps the DOM structure the extractor reads.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const userDir = path.join(dir, "pages-user");
const reduce = process.argv.includes("--reduce");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const split = (url) => (parseInt(sha(url).slice(0, 2), 16) % 5 < 2 ? "heldout" : "dev");
const CATEGORIES = new Set(["paper", "event", "place", "person", "product", "negative"]);

export function reduceHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs) => (/application\/ld\+json/i.test(attrs) ? m : ""))
    .replace(/<(style|svg|iframe|noscript|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/(src|href|srcset|poster)\s*=\s*"data:[^"]*"/gi, '$1=""')
    .replace(/(<input\b[^>]*?)\svalue\s*=\s*"[^"]*"/gi, "$1");
}

if (process.argv.includes("--reduce-only")) {
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(userDir).filter((x) => /\.html?$/i.test(x))) {
    const p = path.join(userDir, f), before = readFileSync(p, "utf8"), after = reduceHtml(before);
    writeFileSync(p, after); console.log(`${f}: ${(before.length / 1024).toFixed(0)} KB -> ${(after.length / 1024).toFixed(0)} KB`);
  }
  process.exit(0);
}
const urlsFile = path.join(userDir, "urls.txt");
if (!existsSync(urlsFile)) { console.error(`No ${urlsFile}. See the header of import.mjs.`); process.exit(1); }
const manifestPath = path.join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const byUrl = new Map(manifest.map((e) => [e.url, e]));
mkdirSync(path.join(dir, "pages"), { recursive: true });

let added = 0, unchanged = 0, problems = 0;
for (const [i, raw] of readFileSync(urlsFile, "utf8").split(/\r?\n/).entries()) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const [file, category, url] = line.split("\t");
  const fail = (why) => { console.error(`line ${i + 1}: ${why}: ${line}`); problems++; };
  if (!file || !category || !url) { fail("need filename<TAB>category<TAB>url"); continue; }
  if (!CATEGORIES.has(category)) { fail(`unknown category '${category}'`); continue; }
  try { new URL(url); } catch { fail("bad URL"); continue; }
  const src = path.join(userDir, file);
  if (!existsSync(src)) { fail("file not found"); continue; }
  let html = readFileSync(src, "utf8");
  if (reduce) html = reduceHtml(html);
  if (html.length < 3000) { fail("file is under 3 KB: probably a stub or blocked page"); continue; }
  const id = `${category}-${sha(url).slice(0, 8)}`;
  const digest = sha(html);
  const prev = byUrl.get(url);
  if (prev && prev.ok && prev.sha256 === digest) { unchanged++; continue; }
  writeFileSync(path.join(dir, "pages", `${id}.html`), html);
  byUrl.set(url, { id, category, url, status: 200, bytes: Buffer.byteLength(html), ok: true, sha256: digest, fetchedAt: statSync(src).mtime.toISOString(), split: split(url), source: "user-saved" });
  added++;
  console.log(`imported ${id} (${split(url)}) ${url}`);
}
writeFileSync(manifestPath, JSON.stringify([...byUrl.values()].sort((a, b) => a.id.localeCompare(b.id)), null, 1) + "\n");
const ok = [...byUrl.values()].filter((e) => e.ok);
console.log(`\nadded ${added}, unchanged ${unchanged}, problems ${problems}. corpus now ${ok.length} ok pages (dev ${ok.filter((e) => e.split === "dev").length}, heldout ${ok.filter((e) => e.split === "heldout").length}; user-saved ${ok.filter((e) => e.source === "user-saved").length}).`);
console.log("Reminder: pages stay out of git. Before sharing any file, check it for personal data (name, address, phone, logged-in account).");
