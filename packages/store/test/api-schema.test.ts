import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { A, B, as, freshDb } from "./pg";

let db: PGlite; let ta: string, tb: string;
beforeEach(async () => {
  db = await freshDb();
  ta = (await db.query<{ id: string }>(`insert into tenants(name) values ('Acme') returning id`)).rows[0]!.id;
  tb = (await db.query<{ id: string }>(`insert into tenants(name, corrections_opt_in) values ('Beta', true) returning id`)).rows[0]!.id;
  await db.query(`insert into tenant_members values ($1,$2,'owner'), ($1,$3,'member'), ($4,$5,'owner')`, [ta, A, "00000000-0000-0000-0000-0000000000c1", tb, B]);
  await db.query(`insert into api_keys(tenant_id, key_hash, label) values ($1,'hash-a','prod'), ($2,'hash-b','prod')`, [ta, tb]);
});
const keys = (u: string) => as(db, u, async () => (await db.query<{ label: string; key_hash: string }>(`select label, key_hash from api_keys`)).rows);

describe("API tables: tenant isolation (real Postgres via PGlite)", () => {
  it("members see only their own tenant, keys and usage", async () => {
    expect((await keys(A)).map((k) => k.key_hash)).toEqual(["hash-a"]); expect((await keys(B)).map((k) => k.key_hash)).toEqual(["hash-b"]);
    expect((await as(db, A, () => db.query(`select id from tenants`))).rows).toEqual([{ id: ta }]);
  });
  it("only an owner can create or revoke keys; a plain member cannot", async () => {
    const member = "00000000-0000-0000-0000-0000000000c1";
    await expect(as(db, member, () => db.query(`insert into api_keys(tenant_id, key_hash) values ($1,'h2')`, [ta]))).rejects.toThrow(/row-level security/);
    expect((await as(db, member, () => db.query(`update api_keys set revoked_at = now()`))).affectedRows).toBe(0);
    await as(db, A, () => db.query(`insert into api_keys(tenant_id, key_hash) values ($1,'h2')`, [ta]));
    expect((await as(db, A, () => db.query(`update api_keys set revoked_at = now() where key_hash = 'h2'`))).affectedRows).toBe(1);
  });
  it("an owner cannot create a key for someone else's tenant", async () => {
    await expect(as(db, A, () => db.query(`insert into api_keys(tenant_id, key_hash) values ($1,'evil')`, [tb]))).rejects.toThrow(/row-level security/);
  });
  it("dashboard users can never write usage or corrections", async () => {
    await expect(as(db, A, () => db.query(`insert into api_usage(tenant_id, month, resolutions) values ($1,'2026-10',1)`, [ta]))).rejects.toThrow(/row-level security/);
    await expect(as(db, B, () => db.query(`insert into api_corrections(tenant_id, object_id, kind) values ($1,'rc_1','edit')`, [tb]))).rejects.toThrow(/row-level security/);
  });
  it("key hashes are unique, and a month must look like YYYY-MM", async () => {
    await expect(db.query(`insert into api_keys(tenant_id, key_hash) values ($1,'hash-a')`, [ta])).rejects.toThrow();
    await expect(db.query(`insert into api_usage(tenant_id, month) values ($1,'October')`, [ta])).rejects.toThrow();
  });
});

describe("usage counting and consent", () => {
  it("record_usage adds atomically and returns the running total", async () => {
    expect(Number((await db.query<{ record_usage: string }>(`select record_usage($1,'2026-10',3)`, [ta])).rows[0]!.record_usage)).toBe(3);
    expect(Number((await db.query<{ record_usage: string }>(`select record_usage($1,'2026-10',4)`, [ta])).rows[0]!.record_usage)).toBe(7);
    expect(Number((await db.query<{ record_usage: string }>(`select record_usage($1,'2026-11',1)`, [ta])).rows[0]!.record_usage)).toBe(1);
    expect((await as(db, A, () => db.query<{ resolutions: string }>(`select resolutions from api_usage order by month`))).rows.map((r) => Number(r.resolutions))).toEqual([7, 1]);
  });
  it("corrections are refused at the database for a tenant that has not opted in, even for the service role", async () => {
    await expect(db.query(`insert into api_corrections(tenant_id, object_id, kind) values ($1,'rc_1','edit')`, [ta])).rejects.toThrow(/not opted in/);
    await db.query(`insert into api_corrections(tenant_id, object_id, kind) values ($1,'rc_1','edit')`, [tb]);
    expect((await db.query(`select count(*)::int as n from api_corrections`)).rows[0]).toEqual({ n: 1 });
    await db.query(`update tenants set corrections_opt_in = true where id = $1`, [ta]);
    await db.query(`insert into api_corrections(tenant_id, object_id, kind) values ($1,'rc_2','undo')`, [ta]);
  });
  it("members read their tenant's corrections and nobody else's", async () => {
    await db.query(`insert into api_corrections(tenant_id, object_id, kind) values ($1,'rc_9','reject')`, [tb]);
    expect((await as(db, B, () => db.query(`select object_id from api_corrections`))).rows).toEqual([{ object_id: "rc_9" }]);
    expect((await as(db, A, () => db.query(`select object_id from api_corrections`))).rows).toEqual([]);
  });
});
