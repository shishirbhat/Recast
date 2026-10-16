import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, A, freshDb } from "../src/testing";

let db: PGlite; let t1: string, t2: string;
const one = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await db.query<T>(q, p)).rows[0] as T;
const count = async (table: string, tenant: string, col = "tenant_id") => Number((await one<{ n: number }>(`select count(*)::int as n from ${table} where ${col} = $1`, [tenant])).n);
const TABLES = ["tenant_members", "api_keys", "api_usage", "api_corrections", "agents", "agent_scopes", "agent_policies", "agent_audit_log", "agent_approvals", "agent_revoked_tokens", "agent_dpop_seen", "api_idempotency", "api_credentials", "api_placements"];

async function seed(tenant: string, n: number) {
  await db.query(`insert into tenant_members(tenant_id, user_id, role) values ($1, $2, 'owner')`, [tenant, A]);
  await db.query(`insert into api_keys(tenant_id, key_hash) values ($1, md5($1::uuid::text))`, [tenant]);
  await db.query(`select record_usage($1, '2026-10', 3)`, [tenant]);
  await db.query(`insert into api_corrections(tenant_id, object_id, kind) values ($1, 'o', 'undo')`, [tenant]);
  const agent = (await one<{ id: string }>(`insert into agents(tenant_id, agent_key, name, public_key, owner_user_id) values ($1, 'agt_' || substr(md5($1::uuid::text), 1, 12), 'bot', '{"kty":"OKP","crv":"Ed25519","x":"abc"}', $2) returning id`, [tenant, A])).id;
  await db.query(`insert into agent_scopes(tenant_id, agent_id, tool, action, expires_at, max_calls) values ($1, $2, 't', 'a', now() + interval '1 hour', 5)`, [tenant, agent]);
  await db.query(`select activate_policy($1, 'p', 'rules: []')`, [tenant]);
  await db.query(`insert into agent_approvals(id, tenant_id, agent_id, tool, action, request_hash, created_ms) values ('ap_' || md5($1::uuid::text), $1, $2, 't', 'a', 'h', 1)`, [tenant, agent]);
  await db.query(`insert into agent_revoked_tokens(tenant_id, jti) values ($1, 'j')`, [tenant]);
  await db.query(`insert into agent_dpop_seen(tenant_id, jti, seen_ms) values ($1, 'j', 1)`, [tenant]);
  await db.query(`insert into api_idempotency(tenant_id, key, body_hash, created_ms) values ($1, 'k', 'h', 1)`, [tenant]);
  await db.query(`select take_token($1::text, 1, 1, 1)`, [tenant]);
  await db.query(`insert into api_credentials(tenant_id, destination, sealed) values ($1, 'gmail', 'v1:x:y')`, [tenant]);
  await db.query(`insert into api_placements(receipt_id, tenant_id, destination, target, receipt, data_moved) values ('rc_r_' || md5($1::uuid::text), $1, 'gmail', '{}', '{}', '[]')`, [tenant]);
  let prev = "0".repeat(64);
  for (let seq = 1; seq <= n; seq++) { const hash = `${tenant.slice(0, 8)}-${seq}`.padEnd(64, "0"); await db.query(`insert into agent_audit_log(tenant_id, seq, request_id, tool, action, result, key_id, prev_hash, hash, signature) values ($1,$2,'r','t','a','success','k1',$3,$4,'sig')`, [tenant, seq, prev, hash]); prev = hash; }
  return prev;
}

beforeEach(async () => {
  db = await freshDb();
  t1 = (await one<{ id: string }>(`insert into tenants(name, corrections_opt_in) values ('Acme', true) returning id`)).id;
  t2 = (await one<{ id: string }>(`insert into tenants(name, corrections_opt_in) values ('Other', true) returning id`)).id;
});

describe("tenant erasure", () => {
  it("ordinary deletes of audit history still fail, including deleting the tenant", async () => {
    await seed(t1, 2);
    await expect(db.query(`delete from agent_audit_log where tenant_id = $1`, [t1])).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from tenants where id = $1`, [t1])).rejects.toThrow(/append-only/);
    expect(await count("agent_audit_log", t1)).toBe(2);
  });
  it("erase_tenant removes every row the tenant owns, leaves other tenants alone, and keeps a receipt", async () => {
    const head = await seed(t1, 3); await seed(t2, 2);
    for (const t of TABLES) expect(await count(t, t1), t).toBeGreaterThan(0);
    const id = (await one<{ id: string }>(`select erase_tenant($1, $2, 'ops@acme', 'customer request #42') as id`, [t1, `ERASE ${t1}`])).id;
    for (const t of TABLES) expect(await count(t, t1), t).toBe(0);
    expect(await count("tenants", t1, "id")).toBe(0); expect(await count("api_rate_buckets", t1, "bucket")).toBe(0);
    for (const t of TABLES) expect(await count(t, t2), t).toBeGreaterThan(0);
    expect(await count("agent_audit_log", t2)).toBe(2);
    expect(await one(`select tenant_id, tenant_name, requested_by, reason, audit_entries::int as n, audit_head_hash, status, finished_at is not null as finished from tenant_erasures where id = $1`, [id]))
      .toEqual({ tenant_id: t1, tenant_name: "Acme", requested_by: "ops@acme", reason: "customer request #42", n: 3, audit_head_hash: head, status: "done", finished: true });
  });
  it("needs the exact confirmation, a real tenant, a requester and a reason; a refusal changes nothing", async () => {
    await seed(t1, 1);
    await expect(db.query(`select erase_tenant($1, 'ERASE', 'ops', 'r')`, [t1])).rejects.toThrow(/confirmation must be exactly/);
    await expect(db.query(`select erase_tenant($1, $2, 'ops', 'r')`, [t1, `ERASE ${t2}`])).rejects.toThrow(/confirmation/);
    const ghost = "00000000-0000-0000-0000-0000000000ff";
    await expect(db.query(`select erase_tenant($1, $2, 'ops', 'r')`, [ghost, `ERASE ${ghost}`])).rejects.toThrow(/no such tenant/);
    await expect(db.query(`select erase_tenant($1, $2, '', 'r')`, [t1, `ERASE ${t1}`])).rejects.toThrow(/check/);
    expect(await count("agent_audit_log", t1)).toBe(1); expect(await count("tenant_erasures", t1)).toBe(0);
  });
  it("a hand-made receipt from an earlier transaction does not unlock deletes, and receipts cannot be edited or removed", async () => {
    await seed(t1, 1); await seed(t2, 1);
    await db.query(`select erase_tenant($1, $2, 'ops', 'r')`, [t2, `ERASE ${t2}`]);
    await expect(db.query(`insert into tenant_erasures(tenant_id, tenant_name, requested_by, reason, audit_entries, txid) values ($1, 'x', 'me', 'r', 0, txid_current() - 1)`, [t1]).then(() => db.query(`delete from agent_audit_log where tenant_id = $1`, [t1]))).rejects.toThrow(/append-only/);
    await expect(db.query(`update tenant_erasures set reason = 'edited'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from tenant_erasures`)).rejects.toThrow(/append-only/);
    expect(await count("agent_audit_log", t1)).toBe(1);
  });
  it("a signed-in owner can neither erase nor read receipts", async () => {
    await seed(t1, 1);
    await as(db, A, async () => {
      await expect(db.query(`select erase_tenant($1, $2, 'me', 'r')`, [t1, `ERASE ${t1}`])).rejects.toThrow(/permission denied/);
      expect((await db.query(`select * from tenant_erasures`)).rows).toEqual([]);
      await expect(db.query(`insert into tenant_erasures(tenant_id, tenant_name, requested_by, reason, audit_entries) values ($1, 'x', 'me', 'r', 0)`, [t1])).rejects.toThrow();
    });
    expect(await count("agent_audit_log", t1)).toBe(1);
  });
});
