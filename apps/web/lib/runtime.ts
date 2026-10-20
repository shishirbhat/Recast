import "server-only";
import { runtimeClientFromEnv, type RuntimeClient } from "@recast/runtime-client";
import { withUser, type PoolLike } from "@recast/store";
import { getPool } from "./db";
import type { Session } from "./session";

/**
 * With RUNTIME_URL, RUNTIME_ADMIN_TOKEN and RUNTIME_TENANT_ID set, this talks to the real Agent Runtime with an operator token.
 * Without them it serves sample data, like the rest of the demo. The admin token never leaves the server.
 *
 * The admin token can do anything for that tenant, so the control center decides who may use it: only a signed-in person who is
 * a member of RUNTIME_TENANT_ID, checked in the database under that person's own identity (RLS `is_member`). A demo session or
 * a deployment without a database never reaches a real runtime.
 */
const g = globalThis as unknown as { __recastRuntime?: RuntimeClient };
const client = (): RuntimeClient => (g.__recastRuntime ??= runtimeClientFromEnv(process.env));
export const runtimeIsDemo = () => !(process.env.RUNTIME_URL && process.env.RUNTIME_ADMIN_TOKEN && process.env.RUNTIME_TENANT_ID);

export type RuntimeAccess = { ok: true; runtime: RuntimeClient } | { ok: false; reason: string };
export async function runtimeFor(session: Session): Promise<RuntimeAccess> {
  if (runtimeIsDemo()) return { ok: true, runtime: client() };
  if (session.via === "demo") throw new Error("RUNTIME_URL is set but sign-in is not: refusing to let anonymous visitors act on agents (configure sign-in and DATABASE_URL)");
  const pool = getPool(); if (!pool) throw new Error("RUNTIME_URL needs DATABASE_URL, to check who belongs to the runtime's tenant");
  const tenant = process.env.RUNTIME_TENANT_ID!;
  const member = await withUser(pool as unknown as PoolLike, session.userId, async (sql) => (await sql.query<{ ok: boolean }>("select is_member($1::uuid) as ok", [tenant])).rows[0]?.ok === true).catch(() => false);
  return member ? { ok: true, runtime: client() } : { ok: false, reason: "You are not a member of the account these agents belong to. Ask its owner to add you." };
}
