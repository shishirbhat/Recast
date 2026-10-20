// Runs the extractor in real Chromium over the stored corpus, scores against hand-labelled truth,
// and reports per-field accuracy, evidence resolution and latency.
//   node eval.mjs [--split dev|heldout|all] [--json out.json]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dir, manifest, launch, openSnapshot } from "./browser.mjs";
import { score } from "./score.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const split = arg("split", "dev");
const bundle = readFileSync(path.join(dir, "../packages/extract-web/dist/recast-extract.iife.js"), "utf8");
const entries = manifest().filter((e) => split === "all" || e.split === split);

const browser = await launch();
const results = [];
for (const e of entries) {
  const { ctx, page } = await openSnapshot(browser, e);
  try {
    await page.evaluate(bundle + "\n;globalThis.RecastExtract = RecastExtract;"); // CDP evaluate: not subject to the CSP
    const out = await page.evaluate(({ url }) => {
      const now = "2026-09-30T10:00:00Z";
      const t = [];
      let last;
      for (let i = 0; i < 7; i++) { const a = performance.now(); last = RecastExtract.extractPage(document, { url, now }); t.push(performance.now() - a); }
      const resolve = RecastExtract.createResolver(document);
      let props = 0, anyOk = 0, primaryOk = 0, corroborated = 0;
      const badEvidence = [];
      for (const o of last.objects) for (const [k, m] of Object.entries(o.fields)) {
        props++;
        const rs = m.evidence.map((ev) => resolve(ev, o.properties[k]).ok);
        if (rs.some(Boolean)) anyOk++; else badEvidence.push(`${o.type}.${k}`);
        if (rs[0]) primaryOk++;
        if (m.evidence.some((ev) => ev.locator.kind === "css")) corroborated++;
      }
      return { objects: last.objects, roles: last.roles, rejected: last.rejected, dropped: last.droppedProperties, diagnostics: last.diagnostics, coldMs: t[0], warmMs: [...t.slice(2)].sort((a, b) => a - b)[2], evidence: { props, anyOk, primaryOk, corroborated, badEvidence } };
    }, { url: e.url });
    results.push({ entry: e, ...out });
  } catch (err) {
    results.push({ entry: e, error: String(err).split("\n")[0], objects: [], rejected: [], dropped: [], evidence: { props: 0, anyOk: 0, primaryOk: 0, corroborated: 0, badEvidence: [] } });
  } finally { await ctx.close(); }
}
await browser.close();

const truthOf = (id) => { const f = path.join(dir, "truth", `${id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
const report = score(results, truthOf);
const outFile = arg("json", null);
if (outFile) { mkdirSync(path.dirname(outFile), { recursive: true }); writeFileSync(outFile, JSON.stringify({ split, ...report, pages: results.map((r) => ({ id: r.entry.id, category: r.entry.category, url: r.entry.url, error: r.error, types: r.objects.map((o) => o.type), rejected: r.rejected, dropped: r.dropped, diagnostics: r.diagnostics, coldMs: r.coldMs, warmMs: r.warmMs, evidence: r.evidence })) }, null, 1));
}
console.log(report.text);
