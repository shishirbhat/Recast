import { describe, expect, it } from "vitest";
import { MemoryRepository, SqlRepository, type Repository } from "../src";
import { A, as, freshDb } from "./pg";

type Make = () => Promise<{ repo: Repository; done?: () => Promise<void> }>;
const impls: Record<string, Make> = {
  memory: async () => ({ repo: new MemoryRepository() }),
  // SQL runs as a signed-in user so row-level security is in force, exactly as in production.
  sql: async () => {
    const db = await freshDb();
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${A}', false);`);
    return { repo: new SqlRepository(db) };
  },
};
void as;

for (const [name, make] of Object.entries(impls)) describe(`Repository contract: ${name}`, () => {
  it("stores, updates and lists objects; update keeps one row and audits create then update", async () => {
    const { repo } = await make();
    await repo.putObject({ id: "o1", kind: "Person", title: "Meera Iyer", data: { email: "meera@example.com" } });
    await repo.putObject({ id: "o1", kind: "Person", title: "Meera I.", data: { email: "meera@example.com" } });
    const objs = await repo.listObjects();
    expect(objs).toHaveLength(1); expect(objs[0]).toMatchObject({ id: "o1", title: "Meera I.", data: { email: "meera@example.com" } });
    expect((await repo.listAudit()).map((e) => e.action)).toEqual(["object.created", "object.updated"]);
  });

  it("deleting an object removes its relationships and audits once; deleting a missing one does nothing", async () => {
    const { repo } = await make();
    await repo.putObject({ id: "o1", kind: "Person", title: "Meera", data: {} });
    await repo.putRelationship({ id: "r1", relation: "attendee", fromId: "o1", toId: "e1" });
    await repo.deleteObject("o1"); await repo.deleteObject("nope");
    expect(await repo.listObjects()).toEqual([]); expect(await repo.listRelationships()).toEqual([]);
    expect((await repo.listAudit()).filter((e) => e.action === "object.deleted")).toHaveLength(1);
  });

  it("integrations record their reliability class and can be switched off", async () => {
    const { repo } = await make();
    await repo.setIntegration({ destination: "gcal", app: "Google Calendar", reliability: "official-api", enabled: true });
    await repo.setIntegration({ destination: "gcal", app: "Google Calendar", reliability: "official-api", enabled: false });
    expect(await repo.listIntegrations()).toEqual([{ destination: "gcal", app: "Google Calendar", reliability: "official-api", enabled: false }]);
    expect((await repo.listAudit()).map((e) => e.action)).toEqual(["integration.enabled", "integration.disabled"]);
  });

  it("grants can be revoked once; revoking again or a missing grant adds no audit noise", async () => {
    const { repo } = await make();
    await repo.grant({ id: "g1", destination: "gcal", scope: "events.write" });
    await repo.revokeGrant("g1"); await repo.revokeGrant("g1"); await repo.revokeGrant("missing");
    const g = (await repo.listGrants())[0]!;
    expect(g.revokedAt).toBeTruthy();
    expect((await repo.listAudit()).map((e) => e.action)).toEqual(["grant.created", "grant.revoked"]);
  });

  it("export contains everything, as JSON-safe data", async () => {
    const { repo } = await make();
    await repo.putObject({ id: "o1", kind: "Event", title: "Launch", data: { start: "2026-05-01" }, source: "page" });
    await repo.grant({ id: "g1", destination: "gcal", scope: "events.write" });
    const ex = await repo.exportAll();
    expect(JSON.parse(JSON.stringify(ex))).toMatchObject({ version: 1, objects: [{ id: "o1", source: "page" }], grants: [{ id: "g1" }] });
    expect(ex.audit.length).toBe(2);
  });

  it("deleteAll removes data but keeps one honest audit line", async () => {
    const { repo } = await make();
    await repo.putObject({ id: "o1", kind: "Person", title: "Meera", data: {} });
    await repo.grant({ id: "g1", destination: "gcal", scope: "s" });
    await repo.deleteAll();
    expect(await repo.listObjects()).toEqual([]); expect(await repo.listGrants()).toEqual([]);
    expect((await repo.listAudit()).at(-1)).toMatchObject({ action: "data.deleted" });
  });
});
