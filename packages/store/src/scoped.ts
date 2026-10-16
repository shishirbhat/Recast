import { SqlRepository, type Sql } from "./sql";
import type { Repository } from "./types";

/** A Postgres pool, as node-postgres exposes it. Each checkout is one connection. */
export interface PoolLike { connect(): Promise<{ query: Sql["query"]; release(): void }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction as the signed-in user: role `authenticated`, and the JWT claims Supabase's auth.uid() reads
 * (both the legacy single setting and the claims JSON). Row-level security then decides which rows exist. Both settings
 * are transaction-local, so a pooled connection never carries one person's identity into the next request.
 */
export async function withUser<T>(pool: PoolLike, userId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error("user id must be a uuid");
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [userId, JSON.stringify({ sub: userId, role: "authenticated" })]);
    const out = await fn({ query: (text, params) => c.query(text, params) });
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally { c.release(); }
}

/** The control center's repository for one person: every method is one transaction under their identity.
 *  Explicit methods, not a Proxy: a Proxy would also answer `then`, and `await repo` would run a query. */
export function userRepository(pool: PoolLike, userId: string): Repository {
  const run = <T>(fn: (r: SqlRepository) => Promise<T>) => withUser(pool, userId, (sql) => fn(new SqlRepository(sql)));
  return {
    listObjects: () => run((r) => r.listObjects()),
    putObject: (o) => run((r) => r.putObject(o)),
    deleteObject: (id) => run((r) => r.deleteObject(id)),
    listRelationships: () => run((r) => r.listRelationships()),
    putRelationship: (x) => run((r) => r.putRelationship(x)),
    listIntegrations: () => run((r) => r.listIntegrations()),
    setIntegration: (i) => run((r) => r.setIntegration(i)),
    listGrants: () => run((r) => r.listGrants()),
    grant: (g) => run((r) => r.grant(g)),
    revokeGrant: (id) => run((r) => r.revokeGrant(id)),
    listAudit: () => run((r) => r.listAudit()),
    exportAll: () => run((r) => r.exportAll()),
    deleteAll: () => run((r) => r.deleteAll()),
  };
}
