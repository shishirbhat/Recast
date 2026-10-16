import type { Sql } from "./sql";
import type { Tier } from "./tiers";
import { CredentialCipher, PLACE_TARGETS } from "./place";

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

/** Tables a tenant owns, exported before erasure. Key hashes are cut to a prefix; transient state (proofs seen, idempotency) is left out. */
const EXPORT_TABLES: Record<string, string> = {
  tenant: `select id, name, tier, corrections_opt_in, created_at from tenants where id = $1`,
  members: `select user_id, role from tenant_members where tenant_id = $1 order by user_id`,
  api_keys: `select left(key_hash, 12) as hash_prefix, label, revoked_at, created_at from api_keys where tenant_id = $1 order by created_at, id`,
  usage: `select month, resolutions from api_usage where tenant_id = $1 order by month`,
  corrections: `select object_id, field, old_value, new_value, kind, at from api_corrections where tenant_id = $1 order by at, id`,
  agents: `select id, agent_key, name, public_key, owner_user_id, created_at, revoked_at from agents where tenant_id = $1 order by created_at, id`,
  scopes: `select id, agent_id, tool, action, constraints, max_calls, calls, issued_at, expires_at from agent_scopes where tenant_id = $1 order by issued_at, id`,
  policies: `select name, version, rule_yaml, active, created_at from agent_policies where tenant_id = $1 order by name, version`,
  approvals: `select id, agent_id, tool, action, request_hash, status, created_ms, decided_by from agent_approvals where tenant_id = $1 order by created_ms, id`,
  placements: `select receipt_id, destination, target, receipt, data_moved, status, created_at, undone_at from api_placements where tenant_id = $1 order by created_at, receipt_id`,
  connected_destinations: `select destination, updated_at from api_credentials where tenant_id = $1 order by destination`,
  audit_log: `select seq, entry, prev_hash, hash, signature, key_id, at from agent_audit_log where tenant_id = $1 order by seq`,
};

/** Everything the tenant owns, as one JSON document. The audit log is exported whole (signed entries and hashes), so it can be verified offline. */
export async function exportTenant(sql: Sql, tenantId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { format: "recast.tenant-export/1", exported_at: new Date().toISOString() };
  for (const [name, q] of Object.entries(EXPORT_TABLES)) out[name] = (await sql.query(q, [uuidOf(tenantId)])).rows;
  if (!(out.tenant as unknown[]).length) throw new AdminError("no such tenant");
  out.tenant = (out.tenant as unknown[])[0];
  return out;
}

/** Irreversible. The database checks the confirmation (exactly "ERASE <tenant-id>") and writes a receipt that outlives the tenant. */
export async function eraseTenant(sql: Sql, tenantId: string, confirm: string, requestedBy: string, reason: string): Promise<string> {
  if (confirm !== `ERASE ${uuidOf(tenantId)}`) throw new AdminError(`confirmation must be exactly: ERASE ${tenantId}`);
  if (!requestedBy.trim() || !reason.trim()) throw new AdminError("who asked (--by) and why (--reason) are required");
  try {
    const { rows } = await sql.query<{ id: string }>(`select erase_tenant($1, $2, $3, $4) as id`, [tenantId, confirm, requestedBy.trim(), reason.trim()]);
    return rows[0]!.id;
  } catch (e) { if (/no such tenant/.test(String((e as Error).message))) throw new AdminError("no such tenant"); throw e; }
}

/** Stores a destination token for a tenant, sealed with the server's credentials key. OAuth sign-in will call the same function. */
export async function setCredential(sql: Sql, cipher: CredentialCipher, tenantId: string, destination: string, accessToken: string): Promise<void> {
  if (!PLACE_TARGETS[destination]) throw new AdminError(`destination must be one of ${Object.keys(PLACE_TARGETS).join(", ")}`);
  const token = accessToken.trim(); if (!token || /\s/.test(token)) throw new AdminError("the token is empty or contains whitespace");
  const { rows } = await sql.query(`select 1 from tenants where id = $1`, [uuidOf(tenantId)]); if (!rows.length) throw new AdminError("no such tenant");
  const sealed = await cipher.seal(tenantId, destination, { accessToken: token });
  await sql.query(`insert into api_credentials(tenant_id, destination, sealed) values ($1,$2,$3) on conflict (tenant_id, destination) do update set sealed = excluded.sealed, updated_at = now()`, [tenantId, destination, sealed]);
}

export const KEYS_USAGE = `recast-keys: manage API tenants and keys (needs DATABASE_URL)

  tenant create <name> [--tier free|pro|scale|enterprise] [--corrections-opt-in]
  tenant set <tenant-id> [--tier <tier>] [--corrections-opt-in | --no-corrections-opt-in]
  key issue <tenant-id> [--label <text>] [--test]     prints the key once; only its hash is stored
  key revoke <key-or-hash>
  key list <tenant-id>
  tenant export <tenant-id>                            everything the tenant owns, as JSON on stdout
  tenant erase <tenant-id> --confirm "ERASE <tenant-id>" --by <who> --reason <why>
                                                       irreversible; export first. Leaves an erasure receipt
  credential set <tenant-id> <destination>             reads the access token from stdin; needs RECAST_CREDENTIALS_KEY
  credential remove <tenant-id> <destination>
  credentials-key generate                             prints a new RECAST_CREDENTIALS_KEY`;

/** The command line, minus process handling, so tests run it directly. Returns the exit code. */
export async function runKeysCli(argv: string[], sql: Sql, out: (s: string) => void, errOut: (s: string) => void = out, io: { stdin?: () => Promise<string>; credentialsKey?: string } = {}): Promise<number> {
  const flags = new Map<string, string | true>(); const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) { const v = argv[i + 1]; if (["--tier", "--label", "--confirm", "--by", "--reason"].includes(a)) { if (v === undefined) { errOut(`${a} needs a value`); return 2; } flags.set(a, v); i++; } else flags.set(a, true); }
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
    if (group === "credentials-key" && cmd === "generate") { out(CredentialCipher.generateKey()); return 0; }
    if (group === "credential" && (cmd === "set" || cmd === "remove") && arg && pos[3]) {
      if (cmd === "remove") { const r = await sql.query(`delete from api_credentials where tenant_id = $1 and destination = $2 returning 1`, [uuidOf(arg), pos[3]]); out(r.rows.length ? "removed" : "nothing to remove"); return r.rows.length ? 0 : 1; }
      if (!io.credentialsKey) throw new AdminError("RECAST_CREDENTIALS_KEY is not set");
      if (!io.stdin) throw new AdminError("pipe the token on stdin");
      await setCredential(sql, new CredentialCipher(io.credentialsKey), arg, pos[3], await io.stdin()); out("stored (sealed)"); return 0;
    }
    if (group === "tenant" && cmd === "export" && arg) { out(JSON.stringify(await exportTenant(sql, arg), null, 2)); return 0; }
    if (group === "tenant" && cmd === "erase" && arg) {
      const v = (f: string) => { const x = flags.get(f); return typeof x === "string" ? x : ""; };
      const receipt = await eraseTenant(sql, arg, v("--confirm"), v("--by"), v("--reason"));
      out(`erased; receipt ${receipt}`); return 0;
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
