// Scoring. Truth is hand-labelled from what a person sees on the page; it is not derived from extractor output.
const collapse = (s) => String(s).normalize("NFC").replace(/\s+/g, " ").trim();
const words = (s) => (collapse(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const strip = (s) => collapse(s).toLowerCase().replace(/^[\s"'“”‘’.,;:|-]+|[\s"'“”‘’.,;:|-]+$/g, "");
const normUrl = (u, base) => { try { const x = new URL(u, base); return (x.origin + x.pathname.replace(/\/+$/, "") + x.search); } catch { return strip(u); } };

/** Two levels: exact (after whitespace/case/edge-punctuation normalisation) and loose (same set of words). */
export function compare(key, got, want, pageUrl) {
  if (got === undefined) return { exact: false, loose: false };
  if (key === "url" || key === "pdfUrl" || key === "image") { const ok = normUrl(got, pageUrl) === normUrl(want, pageUrl); return { exact: ok, loose: ok }; }
  if (key === "lat" || key === "lng") { const ok = Math.abs(got - want) < 1e-3; return { exact: ok, loose: ok }; }
  if (key === "year") { const ok = Number(got) === Number(want); return { exact: ok, loose: ok }; }
  if (key === "price") { const ok = !!got && Math.abs(got.amount - want.amount) < 0.005 && got.currency === want.currency; return { exact: ok, loose: ok }; }
  if (["start", "end", "due", "modified", "date"].includes(key)) {
    const hasTime = /T\d/.test(want);
    const exact = hasTime ? Date.parse(got) === Date.parse(want) || strip(got) === strip(want) : String(got).slice(0, 10) === String(want).slice(0, 10);
    return { exact, loose: String(got).slice(0, 10) === String(want).slice(0, 10) };
  }
  if (key === "doi") { const ok = strip(got) === strip(want); return { exact: ok, loose: ok }; }
  if (Array.isArray(want)) {
    const g = (Array.isArray(got) ? got : [got]).map(strip), w = want.map(strip);
    const exact = g.length === w.length && g.every((x, i) => x === w[i]);
    const gs = new Set(g.flatMap((x) => words(x))), ws = w.flatMap((x) => words(x));
    return { exact, loose: ws.every((x) => gs.has(x)) && g.length === w.length };
  }
  const g = strip(String(got)), w = strip(String(want));
  const exact = g === w;
  const a = words(g).sort().join(" "), b = words(w).sort().join(" ");
  return { exact, loose: exact || a === b };
}

const keyOf = (o) => o.properties.name ?? o.properties.title ?? o.properties.address ?? "";
export function matchObjects(truthObjs, gotObjs, pageUrl) {
  const used = new Set(), pairs = [];
  for (const t of truthObjs) {
    let best = null;
    gotObjs.forEach((g, i) => {
      if (used.has(i) || g.type !== t.type) return;
      let s = 0;
      for (const [k, v] of Object.entries(t.properties)) { const gk = k === "authorsFirst" ? "authors" : k; const gv = k === "authorsFirst" && Array.isArray(g.properties[gk]) ? g.properties[gk].slice(0, v.length) : g.properties[gk]; if (compare(gk, gv, v, pageUrl).loose) s++; }
      const nameWords = new Set(words(keyOf(g))), tw = words(keyOf(t));
      if (tw.length && tw.some((w) => nameWords.has(w))) s += 0.5;
      if (s > 0 && (!best || s > best.s)) best = { i, s };
    });
    if (best) { used.add(best.i); pairs.push({ t, g: gotObjs[best.i] }); } else pairs.push({ t, g: null });
  }
  return { pairs, spurious: gotObjs.filter((_, i) => !used.has(i)) };
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : "n/a");
const pad = (s, n) => String(s).padEnd(n);

export function score(results, truthOf) {
  const fields = {}; // "Type.field" -> counters
  const obj = { truth: 0, found: 0, spurious: 0, pagesScored: 0, byType: {} };
  const ev = { props: 0, anyOk: 0, primaryOk: 0, corroborated: 0 };
  const lat = { cold: [], warm: [] };
  const stratum = {};
  const misses = [];
  for (const r of results) {
    for (const k of Object.keys(ev)) ev[k] += r.evidence[k] ?? 0;
    if (r.coldMs !== undefined) { lat.cold.push(r.coldMs); lat.warm.push(r.warmMs); }
    const truth = truthOf(r.entry.id);
    if (!truth) continue;
    if (truth.skip) { obj.excluded = (obj.excluded ?? 0) + 1; continue; }
    obj.pagesScored++;
    // Score against PRIMARY objects; "related" objects (cards, recommendations) are counted but not called wrong.
    const primary = r.objects.filter((o) => (r.roles ?? {})[o.id] !== "related");
    obj.related = (obj.related ?? 0) + (r.objects.length - primary.length);
    globalThis.__spur ??= [];
    const { pairs, spurious } = matchObjects(truth.objects, primary, r.entry.url);
    obj.spurious += spurious.length;
    for (const x of spurious) misses.push(`${r.entry.id} SPURIOUS ${x.type} ${JSON.stringify(x.properties).slice(0, 110)}`);
    (stratum[r.entry.category] ??= { pages: 0, truth: 0, found: 0, spurious: 0 });
    stratum[r.entry.category].pages++; stratum[r.entry.category].spurious += spurious.length;
    for (const { t, g } of pairs) {
      obj.truth++; stratum[r.entry.category].truth++;
      (obj.byType[t.type] ??= { truth: 0, found: 0 }).truth++;
      if (g) { obj.found++; stratum[r.entry.category].found++; obj.byType[t.type].found++; }
      for (const [k, want] of Object.entries(t.properties)) {
        // authorsFirst: truth lists only the first N authors (long lists are not transcribed by hand).
        const gk = k === "authorsFirst" ? "authors" : k;
        const gv = k === "authorsFirst" && Array.isArray(g?.properties[gk]) ? g.properties[gk].slice(0, want.length) : g?.properties[gk];
        const f = (fields[`${t.type}.${k}`] ??= { truth: 0, extracted: 0, exact: 0, loose: 0 });
        f.truth++;
        if (g && gv !== undefined) {
          f.extracted++;
          const c = compare(gk, gv, want, r.entry.url);
          if (c.exact) f.exact++; if (c.loose) f.loose++;
          if (!c.exact) misses.push(`${r.entry.id} ${t.type}.${k}: got ${JSON.stringify(gv)} want ${JSON.stringify(want)}${c.loose ? " (loose ok)" : ""}`);
        } else {
          misses.push(`${r.entry.id} ${t.type}.${k}: NOT EXTRACTED${g ? "" : " (object missed)"} want ${JSON.stringify(want)}`);
        }
      }
    }
  }
  const rows = Object.entries(fields).sort();
  const q = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s.at(-1) } : null; };
  const L = { cold: q(lat.cold), warm: q(lat.warm) };
  let text = `pages ${results.length} (scored ${obj.pagesScored}); objects: truth ${obj.truth}, found ${obj.found} (${pct(obj.found, obj.truth)}), spurious ${obj.spurious}, related-not-scored ${obj.related ?? 0}, excluded snapshots ${obj.excluded ?? 0}\n\n`;
  text += `${pad("field", 28)}${pad("truth", 7)}${pad("recall", 9)}${pad("precision", 11)}${pad("loose-recall", 13)}\n`;
  for (const [k, f] of rows) text += `${pad(k, 28)}${pad(f.truth, 7)}${pad(pct(f.exact, f.truth), 9)}${pad(pct(f.exact, f.extracted), 11)}${pad(pct(f.loose, f.truth), 13)}\n`;
  text += `\nby category: ` + Object.entries(stratum).map(([c, s]) => `${c} ${s.found}/${s.truth} found, ${s.spurious} spurious`).join("; ");
  text += `\nevidence: ${ev.props} properties; any pointer resolves ${pct(ev.anyOk, ev.props)}; primary pointer resolves ${pct(ev.primaryOk, ev.props)}; also visible on page ${pct(ev.corroborated, ev.props)}`;
  if (L.warm) text += `\nlatency (extractor only, in Chromium): cold p50 ${L.cold.p50.toFixed(1)}ms p95 ${L.cold.p95.toFixed(1)}ms max ${L.cold.max.toFixed(1)}ms | warm p50 ${L.warm.p50.toFixed(1)}ms p95 ${L.warm.p95.toFixed(1)}ms max ${L.warm.max.toFixed(1)}ms`;
  if (process.env.WHY) text += "\n\nmisses:\n" + misses.join("\n");
  return { text, misses, fields, obj, ev, latency: L, stratum };
}
