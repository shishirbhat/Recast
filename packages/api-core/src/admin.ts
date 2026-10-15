import type { Sql } from "./sql";
import type { Tier } from "./tiers";

/** Operator actions on tenants and keys. Runs as the service role. Plain keys exist only in the return value of `issueKey`. */
const TIER_NAMES: readonly Tier[] = ["free", "pro", "scale", "enterprise"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AdminError extends Error {}

/** Same digest as `hashKey` in ./stores, kept here so this module (and the CLI) loads without the core's generated validators. */
const hashKey = async (key: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((x) => x.toString(16).padStart(2, "0")).join("");

export function generateApiKey(env: "live" | "test" = "live"): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return `sk_${env}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

const tierOf = (t: string): Tier => { if (!(TIER_NAMES as readonly string[]).includes(t)) throw new AdminError(`tier must be one of ${TIER_NAMES.join(", ")}`); return t as Tier; };
const uuidOf = (id: string | undefined, what = "tenant id"): string => { if (!id || !UUID.test(id)) throw new AdminError(`${what} must be a uuid`); return id; };

export async function createTenant(sql: Sql, name: string, tier: Tier = "free", correctionsOptIn = false): Promise<string> {
  if (!name.trim()) throw new AdminError("tenant name is required");
  const { rows } = await sql.query<{ id: string }>(`insert into tenants(name, tier, corrections_opt_in) values ($1,$2,$3) returning id`, [name.trim(), tierOf(tier), correctionsOptIn]);
  return rows[0]!.id;
}

export async function issueKey(sql: Sql, tenantId: string, label?: string, env: "live" | "test" = "live"): Promise<{ key: string; hash: string }> {
  const { rows } = await sql.query(`select 1 from tenants where id = $1`, [uuidOf(tenantId)]);
  if (!rows.length) throw new AdminError("no such tenant");
  const key = generateApiKey(env); const hash = await hashKey(key);
  await sql.query(`insert into api_keys(tenant_id, key_hash, label) values ($1,$2,$3)`, [tenantId, hash, label ?? null]);
  return { key, hash };
}

/** Accepts the plain key or its hash (64 hex), so a leaked key can be revoked even if only the hash was logged. Returns whether a live key was revoked. */
export async function revokeKey(sql: Sql, keyOrHash: string): Promise<boolean> {
  const hash = /^[0-9a-f]{64}$/.test(keyOrHash) ? keyOrHash : await hashKey(keyOrHash);
  const { rows } = await sql.query(`update api_keys set revoked_at = now() where key_hash = $1 and revoked_at is null returning id`, [hash]);
  return rows.length > 0;
}

export async function listKeys(sql: Sql, tenantId: string) {
  const { rows } = await sql.query<{ key_hash: string; label: string | null; revoked_at: unknown; created_at: Date | string }>(
    `select key_hash, label, revoked_at, created_at from api_keys where tenant_id = $1 order by created_at, id`, [uuidOf(tenantId)]);
  return rows.map((r) => ({ hashPrefix: r.key_hash.slice(0, 12), label: r.label, revoked: r.revoked_at !== null, createdAt: new Date(r.created_at).toISOString() }));
}

export async function setTenant(sql: Sql, tenantId: string, patch: { tier?: Tier; correctionsOptIn?: boolean }): Promise<void> {
  const { rows } = await sql.query(`update tenants set tier = coalesce($2, tier), corrections_opt_in = coalesce($3, corrections_opt_in) where id = $1 returning id`,
    [uuidOf(tenantId), patch.tier === undefined ? null : tierOf(patch.tier), patch.correctionsOptIn ?? null]);
  if (!rows.length) throw new AdminError("no such tenant");
}

export const KEYS_USAGE = `recast-keys: manage API tenants and keys (needs DATABASE_URL)

  tenant create <name> [--tier free|pro|scale|enterprise] [--corrections-opt-in]
  tenant set <tenant-id> [--tier <tier>] [--corrections-opt-in | --no-corrections-opt-in]
  key issue <tenant-id> [--label <text>] [--test]     prints the key once; only its hash is stored
  key revoke <key-or-hash>
  key list <tenant-id>`;

/** The command line, minus process handling, so tests run it directly. Returns the exit code. */
export async function runKeysCli(argv: string[], sql: Sql, out: (s: string) => void, errOut: (s: string) => void = out): Promise<number> {
  const flags = new Map<string, string | true>(); const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) { const v = argv[i + 1]; if (["--tier", "--label"].includes(a)) { if (v === undefined) { errOut(`${a} needs a value`); return 2; } flags.set(a, v); i++; } else flags.set(a, true); }
    else pos.push(a);
  }
  const [group, cmd, arg] = pos;
  try {
    if (group === "tenant" && cmd === "create" && arg) {
      out(await createTenant(sql, arg, tierOf(String(flags.get("--tier") ?? "free")), flags.has("--corrections-opt-in"))); return 0;
    }
    if (group === "tenant" && cmd === "set" && arg) {
      const optIn = flags.has("--corrections-opt-in") ? true : flags.has("--no-corrections-opt-in") ? false : undefined;
      await setTenant(sql, arg, { ...(flags.has("--tier") ? { tier: tierOf(String(flags.get("--tier"))) } : {}), ...(optIn === undefined ? {} : { correctionsOptIn: optIn }) }); out("updated"); return 0;
    }
    if (group === "key" && cmd === "issue" && arg) {
      const label = flags.get("--label"); const { key } = await issueKey(sql, arg, typeof label === "string" ? label : undefined, flags.has("--test") ? "test" : "live");
      out(key); errOut("Store this key now. It is not shown again and cannot be recovered."); return 0;
    }
    if (group === "key" && cmd === "revoke" && arg) { const ok = await revokeKey(sql, arg); out(ok ? "revoked" : "no live key matched"); return ok ? 0 : 1; }
    if (group === "key" && cmd === "list" && arg) { for (const k of await listKeys(sql, arg)) out(`${k.hashPrefix}…  ${k.revoked ? "revoked" : "active "}  ${k.createdAt}  ${k.label ?? ""}`.trimEnd()); return 0; }
    errOut(KEYS_USAGE); return 2;
  } catch (e) {
    if (e instanceof AdminError) { errOut(`error: ${e.message}`); return 1; }
    throw e;
  }
}
