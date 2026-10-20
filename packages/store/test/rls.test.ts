import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { A, B, as, freshDb } from "./pg";

let db: PGlite;
beforeEach(async () => { db = await freshDb(); });
const put = (u: string, id: string, title: string) => as(db, u, () => db.query(`insert into objects(id, kind, title, data) values ($1,'Person',$2,'{}')`, [id, title]));
const titles = (u: string | null) => as(db, u, async () => (await db.query<{ title: string }>(`select title from objects order by title`)).rows.map((r) => r.title));

describe("row-level security (real Postgres via PGlite, real migrations)", () => {
  it("each user sees only their own objects", async () => {
    await put(A, "o1", "Meera"); await put(B, "o1", "Priya");   // same id, different owners: allowed
    expect(await titles(A)).toEqual(["Meera"]);
    expect(await titles(B)).toEqual(["Priya"]);
  });

  it("a signed-out request sees nothing and cannot write", async () => {
    await put(A, "o1", "Meera");
    expect(await titles(null)).toEqual([]);
    await expect(as(db, null, () => db.query(`insert into objects(id, kind, title, data) values ('x','Person','x','{}')`))).rejects.toThrow();
  });

  it("cannot write a row owned by someone else", async () => {
    await expect(as(db, A, () => db.query(`insert into objects(id, owner, kind, title, data) values ('x', $1, 'Person', 'x', '{}')`, [B]))).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another user's row (silently affects zero rows)", async () => {
    await put(A, "o1", "Meera");
    const u = await as(db, B, () => db.query(`update objects set title = 'hacked'`));
    const d = await as(db, B, () => db.query(`delete from objects`));
    expect(u.affectedRows).toBe(0); expect(d.affectedRows).toBe(0);
    expect(await titles(A)).toEqual(["Meera"]);
  });

  it("every other table is isolated the same way", async () => {
    await as(db, A, async () => {
      await db.query(`insert into relationships(id, relation, from_id, to_id) values ('r','attendee','o1','e1')`);
      await db.query(`insert into integrations(destination, app, reliability) values ('google-calendar.event-editor','Google Calendar','official-api')`);
      await db.query(`insert into grants(id, destination, scope) values ('g','google-calendar.event-editor','events.write')`);
    });
    for (const t of ["relationships", "integrations", "grants"]) {
      expect((await as(db, B, () => db.query(`select * from ${t}`))).rows).toEqual([]);
      expect((await as(db, A, () => db.query(`select * from ${t}`))).rows).toHaveLength(1);
    }
  });

  it("rejects an unknown reliability class", async () => {
    await expect(as(db, A, () => db.query(`insert into integrations(destination, app, reliability) values ('d','a','magic')`))).rejects.toThrow();
  });

  it("the audit log is append-only: insert and read your own, never update or delete", async () => {
    await as(db, A, () => db.query(`insert into audit_events(action, subject) values ('object.placed','o1')`));
    expect((await as(db, A, () => db.query(`select * from audit_events`))).rows).toHaveLength(1);
    expect((await as(db, B, () => db.query(`select * from audit_events`))).rows).toHaveLength(0);
    expect((await as(db, A, () => db.query(`update audit_events set action = 'x'`))).affectedRows).toBe(0);
    expect((await as(db, A, () => db.query(`delete from audit_events`))).affectedRows).toBe(0);
    expect((await as(db, A, () => db.query(`select * from audit_events`))).rows).toHaveLength(1);
  });

  it("delete_my_data removes only the caller's data and leaves an audit trail", async () => {
    await put(A, "o1", "Meera"); await put(B, "o1", "Priya");
    await as(db, A, () => db.query(`select delete_my_data()`));
    expect(await titles(A)).toEqual([]); expect(await titles(B)).toEqual(["Priya"]);
    const a = await as(db, A, () => db.query<{ action: string }>(`select action from audit_events`));
    expect(a.rows.map((r) => r.action)).toEqual(["data.deleted"]);
    await expect(as(db, null, () => db.query(`select delete_my_data()`))).rejects.toThrow(/not signed in/);
  });
});
