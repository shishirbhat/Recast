// Fetches the pages listed in sources.json into corpus/pages and writes manifest.json.
// Polite: identifies itself, one request at a time per host, single attempt, never retries a
// policy denial (403/402/429). A page that fails is recorded in the manifest, not silently dropped.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(path.join(dir, "sources.json"), "utf8"));
const manifestPath = path.join(dir, "manifest.json");
const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
const byUrl = new Map(old.map((e) => [e.url, e]));
mkdirSync(path.join(dir, "pages"), { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
// Deterministic split by URL hash so nobody (me included) chooses what is held out.
const split = (url) => (parseInt(sha(url).slice(0, 2), 16) % 5 < 2 ? "heldout" : "dev");
const lastHit = new Map();

// robots.txt: honour Disallow/Allow for "*" and for our own user agent (longest matching rule wins).
const UA_TOKEN = "RecastCorpusBot";
const robotsCache = new Map();
function robotsRules(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let rules = [];
  try {
    const txt = execFileSync("curl", ["-sSL", "-m", "15", "-A", `Mozilla/5.0 (compatible; ${UA_TOKEN}/0.1; research)`, `${origin}/robots.txt`], { encoding: "utf8", maxBuffer: 5e6 });
    if (!/^\s*<(!doctype|html)/i.test(txt)) {
      let groups = [], cur = null;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim(); const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === "user-agent") { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
        else if (cur && (k === "disallow" || k === "allow")) cur.rules.push({ allow: k === "allow", path: v });
      }
      const mine = groups.filter((g) => g.agents.some((a) => UA_TOKEN.toLowerCase().includes(a) && a !== "*"));
      rules = (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules).filter((r) => r.path);
    }
  } catch { /* no robots.txt reachable: no rules */ }
  robotsCache.set(origin, rules);
  return rules;
}
function robotsAllows(url) {
  const u = new URL(url); const target = u.pathname + u.search; let best = null;
  for (const r of robotsRules(u.origin)) {
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(target) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const { category, url } of sources) {
  const prev = byUrl.get(url);
  if (prev && (prev.ok || process.env.REFETCH_FAILED !== "1")) continue;
  const host = new URL(url).host;
  if (!robotsAllows(url)) {
    byUrl.set(url, { id: `${category}-${sha(url).slice(0, 8)}`, category, url, status: "robots-disallowed", bytes: 0, ok: false, sha256: null, fetchedAt: new Date().toISOString(), split: split(url) });
    console.log("ROBOTS", "disallowed", url);
    continue;
  }
  const wait = 1200 - (Date.now() - (lastHit.get(host) ?? 0));
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  const id = `${category}-${sha(url).slice(0, 8)}`;
  const file = path.join(dir, "pages", `${id}.html`);
  let status = 0, bytes = 0, ok = false;
  try {
    const out = execFileSync("curl", ["-sSL", "-m", "30", "-o", file, "-w", "%{http_code}", "-A", "Mozilla/5.0 (compatible; RecastCorpusBot/0.1; research; +https://github.com/shishirbhat/Recast)", url], { encoding: "utf8" });
    status = Number(out.trim());
    bytes = existsSync(file) ? readFileSync(file).length : 0;
    ok = status === 200 && bytes > 3000;
  } catch { /* connection failure: recorded below */ }
  const sum = ok ? sha(readFileSync(file)) : null;
  byUrl.set(url, { id, category, url, status, bytes, ok, sha256: sum, fetchedAt: new Date().toISOString(), split: split(url) });
  console.log(ok ? "ok  " : "FAIL", status, bytes, url);
  if (!ok && existsSync(file)) { try { execFileSync("rm", [file]); } catch {} }
}
const manifest = [...byUrl.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");
const okc = manifest.filter((e) => e.ok);
console.log(`\n${okc.length}/${manifest.length} fetched; dev ${okc.filter((e) => e.split === "dev").length}, heldout ${okc.filter((e) => e.split === "heldout").length}`);
