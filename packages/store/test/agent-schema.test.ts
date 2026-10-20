import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { A, B, as, freshDb } from "./pg";

const MEMBER = "00000000-0000-0000-0000-0000000000c1";
const JWK = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "abc" });
let db: PGlite; let ta: string, tb: string, agentA: string, agentB: string;
beforeEach(async () => {
  db = await freshDb();
  const t = async (n: string) => (await db.query<{ id: string }>(`insert into tenants(name) values ($1) returning id`, [n])).rows[0]!.id; ta = await t("Acme"); tb = await t("Beta");
  await db.query(`insert into tenant_members values ($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')`, [ta, A, MEMBER, tb, B]);
  const ag = async (tenant: string, key: string) => (await db.query<{ id: string }>(`insert into agents(tenant_id, agent_key, name, public_key) values ($1,$2,'bot',$3) returning id`, [tenant, key, JWK])).rows[0]!.id;
  agentA = await ag(ta, "agt_aaaaaaaaaaaa"); agentB = await ag(tb, "agt_bbbbbbbbbbbb");
});
const audit = (tenant: string, seq: number, prev: string, hash: string) =>
  db.query(`insert into agent_audit_log(tenant_id, seq, request_id, tool, action, result, key_id, prev_hash, hash, signature) values ($1,$2,'r','t','a','success','k1',$3,$4,'sig')`, [tenant, seq, prev, hash]);
const G = "0".repeat(64);

describe("agents and scopes: tenant isolation and who may create them", () => {
  it("members see only their tenant's agents; only owners can create or revoke", async () => {
    expect((await as(db, A, () => db.query(`select agent_key from agents`))).rows).toEqual([{ agent_key: "agt_aaaaaaaaaaaa" }]);
    await expect(as(db, MEMBER, () => db.query(`insert into agents(tenant_id, agent_key, name, public_key) values ($1,'agt_cccccccccccc','x',$2)`, [ta, JWK]))).rejects.toThrow(/row-level security/);
    await expect(as(db, A, () => db.query(`insert into agents(tenant_id, agent_key, name, public_key) values ($1,'agt_dddddddddddd','x',$2)`, [tb, JWK]))).rejects.toThrow(/row-level security/);
    expect((await as(db, MEMBER, () => db.query(`update agents set revoked_at = now()`))).affectedRows).toBe(0);
    expect((await as(db, A, () => db.query(`update agents set revoked_at = now()`))).affectedRows).toBe(1);
  });
  it("a public key must be a public Ed25519 key: private material and other curves are refused", async () => {
    const bad = (jwk: object) => db.query(`insert into agents(tenant_id, agent_key, name, public_key) values ($1,'agt_eeeeeeeeeeee','x',$2)`, [ta, JSON.stringify(jwk)]);
    await expect(bad({ kty: "OKP", crv: "Ed25519", x: "abc", d: "PRIVATE" })).rejects.toThrow(); await expect(bad({ kty: "EC", crv: "P-256", x: "a" })).rejects.toThrow();
    await expect(db.query(`insert into agents(tenant_id, agent_key, name, public_key) values ($1,'not-an-id','x',$2)`, [ta, JWK])).rejects.toThrow();
  });
  it("identity cannot be edited, and revocation is permanent", async () => {
    await expect(db.query(`update agents set public_key = $1 where id = $2`, [JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "different" }), agentA])).rejects.toThrow(/cannot be changed/);
    await expect(db.query(`update agents set agent_key = 'agt_ffffffffffff' where id = $1`, [agentA])).rejects.toThrow(/cannot be changed/);
    await db.query(`update agents set revoked_at = now() where id = $1`, [agentA]);
    await expect(db.query(`update agents set revoked_at = null where id = $1`, [agentA])).rejects.toThrow(/stays revoked/);
  });
  it("scopes can only be created by owners, for a live agent of the same tenant", async () => {
    const mk = (u: string, tenant: string, agent: string) => as(db, u, () => db.query(`insert into agent_scopes(tenant_id, agent_id, tool, action, expires_at) values ($1,$2,'gmail','send', now() + interval '1 hour')`, [tenant, agent]));
    await mk(A, ta, agentA);
    await expect(mk(MEMBER, ta, agentA)).rejects.toThrow(/row-level security/);
    await expect(mk(A, ta, agentB)).rejects.toThrow(/row-level security/);            // someone else's agent
    await db.query(`update agents set revoked_at = now() where id = $1`, [agentA]);
    await expect(mk(A, ta, agentA)).rejects.toThrow(/row-level security/);            // revoked agent
    expect((await as(db, B, () => db.query(`select 1 from agent_scopes`))).rows).toEqual([]);
  });
  it("consume_scope spends calls one at a time, never past the limit, never after expiry", async () => {
    const id = (await db.query<{ id: string }>(`insert into agent_scopes(tenant_id, agent_id, tool, action, max_calls, expires_at) values ($1,$2,'x','y',2, now() + interval '1 hour') returning id`, [ta, agentA])).rows[0]!.id;
    const spend = async () => (await db.query<{ consume_scope: boolean }>(`select consume_scope($1)`, [id])).rows[0]!.consume_scope;
    expect([await spend(), await spend(), await spend()]).toEqual([true, true, false]);
    const old = (await db.query<{ id: string }>(`insert into agent_scopes(tenant_id, agent_id, tool, action, expires_at) values ($1,$2,'x','z', now() - interval '1 second') returning id`, [ta, agentA])).rows[0]!.id;
    expect((await db.query<{ consume_scope: boolean }>(`select consume_scope($1)`, [old])).rows[0]!.consume_scope).toBe(false);
  });
  it("only one policy is active per tenant", async () => {
    await db.query(`insert into agent_policies(tenant_id, name, version, rule_yaml, active) values ($1,'p',1,'rules: []',true)`, [ta]);
    await expect(db.query(`insert into agent_policies(tenant_id, name, version, rule_yaml, active) values ($1,'p',2,'rules: []',true)`, [ta])).rejects.toThrow();
    await db.query(`insert into agent_policies(tenant_id, name, version, rule_yaml, active) values ($1,'p',2,'rules: []',false)`, [ta]);
    await db.query(`insert into agent_policies(tenant_id, name, version, rule_yaml, active) values ($1,'p',1,'rules: []',true)`, [tb]);   // another tenant is independent
  });
});

describe("audit log: append-only for every role, linear, tenant-private", () => {
  it("updates, deletes and truncates are refused, even for the service role", async () => {
    await audit(ta, 1, G, "h1");
    await expect(db.query(`update agent_audit_log set result = 'denied'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from agent_audit_log`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate agent_audit_log`)).rejects.toThrow(/append-only/);
    expect((await db.query(`select count(*)::int as n from agent_audit_log`)).rows[0]).toEqual({ n: 1 });
  });
  it("the chain cannot fork or repeat a position", async () => {
    await audit(ta, 1, G, "h1"); await audit(ta, 2, "h1", "h2");
    await expect(audit(ta, 3, "h1", "h3")).rejects.toThrow();          // second child of h1
    await expect(audit(ta, 2, "h2", "h9")).rejects.toThrow();          // seq 2 already taken
    await audit(tb, 1, G, "x1");                                       // another tenant has its own chain from the start
  });
  it("members read their own tenant's log, nobody writes it, nobody reads another's", async () => {
    await audit(ta, 1, G, "h1"); await audit(tb, 1, G, "x1");
    expect((await as(db, A, () => db.query(`select hash from agent_audit_log`))).rows).toEqual([{ hash: "h1" }]);
    expect((await as(db, MEMBER, () => db.query(`select hash from agent_audit_log`))).rows).toEqual([{ hash: "h1" }]);
    await expect(as(db, A, () => audit(ta, 2, "h1", "h2"))).rejects.toThrow(/row-level security/);
    expect((await as(db, B, () => db.query(`select hash from agent_audit_log`))).rows).toEqual([{ hash: "x1" }]);
  });
  it("a tenant with audit history cannot simply be deleted: erasure needs a deliberate process (not built yet)", async () => {
    await audit(ta, 1, G, "h1");
    await expect(db.query(`delete from tenants where id = $1`, [ta])).rejects.toThrow(/append-only/);
    await db.query(`delete from tenants where id = $1`, [tb]);          // a tenant with no audit history deletes normally
  });
  it("results outside the known set are refused", async () => {
    await expect(db.query(`insert into agent_audit_log(tenant_id, seq, request_id, tool, action, result, key_id, prev_hash, hash, signature) values ($1,1,'r','t','a','maybe','k',$2,'h','s')`, [ta, G])).rejects.toThrow();
  });
});
