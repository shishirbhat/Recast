// Measures the element classifier (option A: "point at the thing").
//   Recall: for each labelled Person.name, Location.name and Location.address, find that element on the page,
//           "hover" it, and check the classifier offers the right type with the right value.
//   False positives: hover up to 40 random ordinary text elements per page; count how often it offers anything.
// Targets come from the page truth labelled by hand in Layer 1, never from classifier output.
//   node element-eval.mjs [--split dev|heldout|all]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dir, manifest, launch, openSnapshot } from "./browser.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const split = arg("split", "dev");
const bundle = readFileSync(path.join(dir, "../packages/extract-web/dist/recast-extract.iife.js"), "utf8");
const entries = manifest().filter((e) => split === "all" || e.split === split);
const truthOf = (id) => { const f = path.join(dir, "truth", `${id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };

const browser = await launch();
const rows = [], fps = [];
for (const e of entries) {
  const truth = truthOf(e.id);
  if (!truth || truth.skip) continue;
  const targets = [];
  for (const o of truth.objects) {
    if (o.type === "Person" && o.properties.name) targets.push({ type: "Person", field: "name", text: o.properties.name });
    if (o.type === "Location" && o.properties.name) targets.push({ type: "Location", field: "name", text: o.properties.name });
    if (o.type === "Location" && o.properties.address) targets.push({ type: "Location", field: "address", text: o.properties.address });
  }
  const { ctx, page } = await openSnapshot(browser, e);
  try {
    await page.evaluate(bundle + "\n;globalThis.RecastExtract = RecastExtract;");
    const res = await page.evaluate(({ url, targets, seed }) => {
      const now = "2026-09-30T10:00:00Z";
      const norm = (s) => s.normalize("NFC").replace(/\s+/g, " ").trim();
      const toks = (s) => norm(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      const spaced = (el) => { const w = document.createTreeWalker(el, 4); const p = []; for (let n = w.nextNode(); n; n = w.nextNode()) p.push(n.textContent); return norm(p.join(" ")); };
      const skip = (el) => !!el.closest("script,style,noscript,template,head,svg");
      const all = [...document.body.querySelectorAll("*")].filter((el) => !skip(el));
      const find = (text) => {
        const t = toks(text); if (!t.length) return null;
        let best = null;
        for (const el of all) { const s = spaced(el); if (s.length > text.length * 2 + 25) continue; const have = new Set(toks(s)); if (t.every((x) => have.has(x)) && (!best || s.length < best.len)) best = { el, len: s.length }; }
        return best?.el ?? null;
      };
      const match = (field, got, want) => { const g = new Set(toks(String(got ?? ""))), w = toks(want); return w.length > 0 && (field === "address" ? w.every((x) => g.has(x)) : w.every((x) => g.has(x)) && g.size <= w.length + 2); };
      const hits = targets.map((t) => {
        const el = find(t.text);
        if (!el) return { ...t, found: false };
        const cs = RecastExtract.classifyElement(el, { url, now });
        const right = cs.find((c) => c.type === t.type && match(t.field, c.properties[t.field], t.text));
        return { ...t, found: true, offered: cs.map((c) => c.type), hit: !!right, conf: right ? Math.min(...Object.values(right.fields).map((f) => f.confidence)) : null };
      });
      // false positives: deterministic sample of ordinary text elements
      let s = seed >>> 0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
      const truthToks = targets.map((t) => new Set(toks(t.text)));
      const pool = all.filter((el) => { const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "); const o = norm(own); return o.length >= 3 && o.length <= 120 && !el.closest("a[href^=mailto],address,time"); })
        .filter((el) => { const t = toks(spaced(el)); return !truthToks.some((set) => t.length && t.every((x) => set.has(x))); });
      const sample = []; const used = new Set();
      for (let i = 0; i < Math.min(40, pool.length); i++) { let k = Math.floor(rnd() * pool.length), tries = 0; while (used.has(k) && tries++ < 50) k = Math.floor(rnd() * pool.length); used.add(k); sample.push(pool[k]); }
      const fp = sample.map((el) => { const cs = RecastExtract.classifyElement(el, { url, now }); return { text: spaced(el).slice(0, 60), offered: cs.map((c) => c.type), min: cs.length ? Math.min(...cs.map((c) => Math.min(...Object.values(c.fields).map((f) => f.confidence)))) : null }; });
      return { hits, fp };
    }, { url: e.url, targets, seed: parseInt(e.id.split("-")[1], 16) });
    for (const h of res.hits) rows.push({ id: e.id, category: e.category, ...h });
    for (const f of res.fp) fps.push({ id: e.id, category: e.category, ...f });
  } catch (err) { console.error(e.id, String(err).split("\n")[0]); }
  finally { await ctx.close(); }
}
await browser.close();

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}% (${a}/${b})` : "n/a");
let text = `split ${split}: ${new Set(rows.map((r) => r.id)).size} pages with targets, ${rows.length} targets, ${fps.length} random elements\n\nRECALL (pointing at a labelled thing)\n`;
for (const k of ["Person.name", "Location.name", "Location.address"]) {
  const r = rows.filter((x) => `${x.type}.${x.field}` === k), found = r.filter((x) => x.found);
  text += `  ${k.padEnd(18)} target element found ${pct(found.length, r.length)}; right offer ${pct(found.filter((x) => x.hit).length, found.length)} of found (${pct(r.filter((x) => x.hit).length, r.length)} of all)\n`;
}
const fpAny = fps.filter((f) => f.offered.length), fp50 = fps.filter((f) => f.min !== null && f.min >= 0.5);
text += `\nFALSE POSITIVES (pointing at ordinary text)\n  offers anything: ${pct(fpAny.length, fps.length)}; offers something at confidence >= 0.5: ${pct(fp50.length, fps.length)}\n`;
const byType = {}; for (const f of fpAny) for (const t of new Set(f.offered)) byType[t] = (byType[t] ?? 0) + 1;
text += `  by type: ${JSON.stringify(byType)}\n`;
if (process.env.WHY) {
  text += "\nMISSES\n" + rows.filter((r) => !r.hit).map((r) => `  ${r.id} ${r.type}.${r.field} ${r.found ? "offered " + JSON.stringify(r.offered) : "TARGET NOT FOUND"}: ${r.text}`).join("\n");
  text += "\n\nCONFIDENT (>= 0.5) FALSE POSITIVES\n" + fp50.map((f) => `  ${f.id} ${JSON.stringify(f.offered)} ${f.min} "${f.text}"`).join("\n");
  text += "\n\nFALSE POSITIVE EXAMPLES (any confidence, first 40)\n" + fpAny.slice(0, 40).map((f) => `  ${f.id} ${JSON.stringify(f.offered)} ${f.min} "${f.text}"`).join("\n");
}
console.log(text);
const out = arg("out", null); if (out) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, text + "\n"); }
