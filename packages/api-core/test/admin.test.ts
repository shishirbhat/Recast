import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "@recast/store/testing";
import { SqlKeyStore, createTenant, generateApiKey, hashKey, issueKey, listKeys, revokeKey, runKeysCli, setTenant } from "../src";

let db: PGlite; beforeEach(async () => { db = await freshDb(); });
const cli = async (...argv: string[]) => { const out: string[] = [], err: string[] = []; const code = await runKeysCli(argv, db, (s) => out.push(s), (s) => err.push(s)); return { code, out, err }; };

describe("API key administration", () => {
  it("generates keys the API accepts, unique every time", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey()));
    expect(keys.size).toBe(200); for (const k of keys) expect(k).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(generateApiKey("test")).toMatch(/^sk_test_/);
  });
  it("issues, finds, lists and revokes by key or by hash", async () => {
    const t = await createTenant(db, "Acme", "pro"); const { key, hash } = await issueKey(db, t, "ci");
    expect(await new SqlKeyStore(db).find(await hashKey(key))).toMatchObject({ tenantId: t, tier: "pro", revoked: false });
    expect(await listKeys(db, t)).toEqual([expect.objectContaining({ hashPrefix: hash.slice(0, 12), label: "ci", revoked: false })]);
    expect(await revokeKey(db, hash)).toBe(true); expect(await revokeKey(db, key)).toBe(false);
    expect((await listKeys(db, t))[0]!.revoked).toBe(true);
  });
  it("refuses unknown tenants, bad ids and bad tiers", async () => {
    await expect(issueKey(db, "00000000-0000-0000-0000-000000000000")).rejects.toThrow("no such tenant");
    await expect(issueKey(db, "x")).rejects.toThrow("uuid");
    await expect(createTenant(db, "A", "gold" as never)).rejects.toThrow("tier must be one of");
    await expect(createTenant(db, "  ")).rejects.toThrow("name is required");
    await expect(setTenant(db, "00000000-0000-0000-0000-000000000000", { tier: "pro" })).rejects.toThrow("no such tenant");
  });
  it("the command line: create, set, issue, list, revoke, usage", async () => {
    const t = (await cli("tenant", "create", "Acme")).out[0]!;
    expect((await cli("tenant", "set", t, "--tier", "scale", "--corrections-opt-in")).code).toBe(0);
    expect((await db.query(`select tier, corrections_opt_in from tenants where id = $1`, [t])).rows[0]).toEqual({ tier: "scale", corrections_opt_in: true });
    expect((await cli("tenant", "set", t, "--no-corrections-opt-in")).code).toBe(0);
    expect((await db.query<{ o: boolean }>(`select corrections_opt_in as o from tenants where id = $1`, [t])).rows[0]!.o).toBe(false);
    const issued = await cli("key", "issue", t, "--label", "web"); expect(issued.out[0]).toMatch(/^sk_live_/); expect(issued.err[0]).toContain("not shown again");
    expect((await cli("key", "list", t)).out[0]).toMatch(/active .* web$/);
    expect(await cli("key", "revoke", issued.out[0]!)).toMatchObject({ code: 0, out: ["revoked"] });
    expect((await cli("key", "issue", t, "--label")).code).toBe(2);
    expect((await cli()).err[0]).toContain("recast-keys");
  });
});
