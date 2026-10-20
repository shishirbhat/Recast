// The wedge landing page (/agents) may only say what the repository proves: every claim names files that must exist, the commands
// it shows must match the CLI, and words that overclaim are refused. The outreach copy is held to the same list of words.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAIMS, NOT_YET } from "../lib/claims";

const ROOT = new URL("../../../", import.meta.url);
const OVERCLAIM = /production[- ]ready|enterprise[- ]grade|SOC ?2 (compliant|certified)|trusted by|thousands of|bank[- ]grade|military[- ]grade|guarantee|100% secure|unhackable/i;
const servers: ChildProcess[] = [];
async function start(env: Record<string, string>) {
  const port = await new Promise<number>((ok, fail) => { const s = netServer(); s.once("error", fail); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
  const proc = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env }, stdio: "ignore", detached: true }); servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 450; i++) { try { if ((await fetch(base + "/v1/health")).ok) return base; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}
let plain: string, withContact: string;
beforeAll(async () => { [plain, withContact] = await Promise.all([start({}), start({ RECAST_CONTACT_URL: "https://cal.example/recast-pilot" })]); });
afterAll(() => { for (const p of servers) { try { if (p.pid) process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } } });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

describe("/agents", () => {
  it("every claim cites files that exist in this repository", () => {
    for (const c of CLAIMS) for (const f of c.evidence) expect(existsSync(new URL(f, ROOT)), `${c.id}: ${f}`).toBe(true);
  });
  it("renders every claim with its evidence, and says what is not there yet", async () => {
    const r = await fetch(plain + "/agents"); expect(r.status).toBe(200); const t = text(await r.text());
    expect(t).toContain("Give your AI agent an identity, permissions and a paper trail, in one command.");
    for (const c of CLAIMS) { expect(t).toContain(c.headline); expect(t).toContain(c.evidence[0]!); }
    for (const n of NOT_YET) expect(t).toContain(n);
  });
  it("does not overclaim, on the page or in the outreach copy", async () => {
    const page = text(await (await fetch(plain + "/agents")).text());
    expect(page.match(OVERCLAIM)?.[0] ?? null).toBeNull();
    const outreach = readFileSync(new URL("docs/outreach/mcp-agent-startups.md", ROOT), "utf8");
    expect(outreach.match(OVERCLAIM)?.[0] ?? null).toBeNull();
  });
  it("the commands it shows are the CLI's real commands and flags", async () => {
    const t = text(await (await fetch(plain + "/agents")).text()); const cli = readFileSync(new URL("packages/agent-runtime/src/cli.ts", ROOT), "utf8");
    for (const flag of ["--name", "--org", "--tenant", "--gateway", "--register"]) { expect(t).toContain(flag); expect(cli).toContain(`usage: agent-auth init`); expect(cli).toMatch(new RegExp(`${flag.slice(2)}: \\{ type`)); }
    expect(t).toContain('"args": ["connect", "--name", "my-agent"]'); expect(cli).toContain('cmd === "connect"');
  });
  it("shows the pilot link only when the deployment sets one", async () => {
    expect(await (await fetch(plain + "/agents")).text()).not.toContain('class="cta"');
    expect(text(await (await fetch(plain + "/agents")).text())).toContain("Reply to whoever sent you this page");
    expect(await (await fetch(withContact + "/agents")).text()).toContain('href="https://cal.example/recast-pilot"');
  });
});
