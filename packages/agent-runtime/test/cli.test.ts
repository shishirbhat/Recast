import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, MemoryAuditStore, generateKeyPair } from "../src";
import { parseTtl, runCli } from "../src/cli";

const mk = () => { const dir = mkdtempSync(path.join(tmpdir(), "agent-auth-")); const lines: string[] = []; return { dir, lines, env: { dir, out: (s: string) => lines.push(s), now: () => new Date("2026-10-15T10:00:00Z") } }; };

describe("agent-auth CLI", () => {
  it("create writes the private key at mode 600, registers only the public key, and refuses to overwrite", async () => {
    const t = mk(); expect(await runCli(["create", "--name", "calendar-bot", "--org", "acme"], t.env)).toBe(0);
    const keyFile = path.join(t.dir, "keys", "calendar-bot.json"); expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const agents = JSON.parse(readFileSync(path.join(t.dir, "agents.json"), "utf8"));
    expect(agents).toHaveLength(1); expect(agents[0].publicJwk.d).toBeUndefined(); expect(JSON.stringify(agents)).not.toContain(JSON.parse(readFileSync(keyFile, "utf8")).privateJwk.d);
    expect(t.lines[0]).toMatch(/^Agent ID:   agt_[0-9a-f]{12}/);
    expect(await runCli(["create", "--name", "calendar-bot", "--org", "acme"], t.env)).toBe(1); expect(t.lines.at(-1)).toMatch(/refusing to overwrite/);
  });
  it("scope grants a time-limited, call-limited permission to a known agent only", async () => {
    const t = mk(); await runCli(["create", "--name", "bot", "--org", "acme"], t.env); const id = /agt_[0-9a-f]{12}/.exec(t.lines[0]!)![0];
    expect(await runCli(["scope", id, "--tool", "google_calendar", "--action", "create_event", "--ttl", "15m", "--max-calls", "50"], t.env)).toBe(0);
    const g = JSON.parse(readFileSync(path.join(t.dir, "scopes.json"), "utf8"))[0]; expect(g).toMatchObject({ tool: "google_calendar", maxCalls: 50, expiresAt: "2026-10-15T10:15:00.000Z" });
    expect(await runCli(["scope", "agt_000000000000", "--tool", "x", "--action", "y"], t.env)).toBe(1);
    expect(await runCli(["scope", id, "--tool", "x", "--action", "y", "--ttl", "forever"], t.env)).toBe(1);
  });
  it("parseTtl", () => { expect([parseTtl("30s"), parseTtl("15m"), parseTtl("2h"), parseTtl("7d")]).toEqual([30, 900, 7200, 604800]); expect(() => parseTtl("15")).toThrow(); });
  it("verify-audit exits 0 on a good log and 1 on a tampered one", async () => {
    const t = mk(); const signer = await generateKeyPair(); const store = new MemoryAuditStore(); const log = new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "k1" });
    for (let i = 0; i < 3; i++) await log.append({ tenantId: "t", agentId: "a", requestId: `r${i}`, tool: "x", action: "y", params: { i }, result: "success" });
    const entries = await store.list("t"); const ef = path.join(t.dir, "e.json"), kf = path.join(t.dir, "k.json");
    writeFileSync(ef, JSON.stringify(entries)); writeFileSync(kf, JSON.stringify({ k1: signer.publicJwk }));
    expect(await runCli(["verify-audit", ef, kf], t.env)).toBe(0); expect(t.lines.at(-1)).toMatch(/^OK: 3 entries/);
    (entries[1]!.params as any).i = 99; writeFileSync(ef, JSON.stringify(entries));
    expect(await runCli(["verify-audit", ef, kf], t.env)).toBe(1); expect(t.lines.at(-1)).toMatch(/BROKEN at entry 2/);
  });
});
