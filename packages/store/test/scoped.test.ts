import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { A, B, freshDb } from "../src/testing";
import { userRepository, withUser, type PoolLike } from "../src";

let db: PGlite; let pool: PoolLike;
beforeEach(async () => {
  db = await freshDb();
  // PGlite is one connection; this pool hands it out, which is all the code under test needs.
  pool = { connect: async () => ({ query: (t, p) => db.query(t, p) as never, release() {} }) };
});

describe("per-user repository over a privileged connection", () => {
  it("each person sees and changes only their own rows, though the server connects as one role", async () => {
    const a = userRepository(pool, A), b = userRepository(pool, B);
    await a.putObject({ id: "o1", kind: "Person", title: "Meera", data: {} });
    await b.putObject({ id: "o1", kind: "Event", title: "B's own o1", data: {} });
    expect((await a.listObjects()).map((o) => o.title)).toEqual(["Meera"]);
    expect((await b.listObjects()).map((o) => o.title)).toEqual(["B's own o1"]);
    await b.deleteAll();
    expect(await a.listObjects()).toHaveLength(1);
    expect((await a.listAudit()).map((e) => e.action)).toEqual(["object.created"]);
  });
  it("a whole method is one transaction: a failure leaves nothing half-done", async () => {
    await expect(withUser(pool, A, async (sql) => {
      await sql.query(`insert into objects(id, kind, title, data) values ('x', 'Person', 'X', '{}')`);
      await sql.query(`select 1/0`);
    })).rejects.toThrow();
    expect(await userRepository(pool, A).listObjects()).toEqual([]);
  });
  it("identity does not leak to the next use of the connection", async () => {
    await userRepository(pool, A).putObject({ id: "o1", kind: "Person", title: "Meera", data: {} });
    expect((await db.query(`select current_setting('request.jwt.claim.sub', true) as s, current_user as u`)).rows[0]).toEqual({ s: "", u: "postgres" });
  });
  it("can be awaited and returned from async functions like any value", async () => {
    const repo = await (async () => userRepository(pool, A))();
    expect(await repo.listObjects()).toEqual([]);
  });
  it("refuses an id that is not a uuid (it is interpolated into session settings)", async () => {
    await expect(withUser(pool, "' or 1=1 --", async () => 1)).rejects.toThrow("uuid");
  });
});
