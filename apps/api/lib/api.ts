import pg from "pg";
import { CredentialCipher, MemoryKeyStore, SqlCredentialStore, SqlPlacementStore, SqlCorrectionStore, SqlIdempotencyStore, SqlKeyStore, SqlRateLimiter, SqlUsageStore, createApi, type Api, type ApiDeps, type Tier } from "@recast/api-core";
import { createResolver } from "@recast/resolve";
import { isCohort, releaseFromEnv } from "@recast/release";

/**
 * With DATABASE_URL set, keys, usage, corrections, rate-limit buckets and idempotency records live in Postgres (the Supabase migrations); issue keys with `pnpm --filter @recast/api keys`.
 * Without it, keys come from RECAST_API_KEYS="sk_live_abc...:tenant_id:tier[:optin][:cohort],..." and counts live in memory (local and tests).
 * With nothing configured every authenticated call is a 401, which is the safe default.
 * A key without a cohort is `public` (docs/RELEASE_STATES.md); RECAST_RELEASE overrides release states per deployment.
 * No embedding or model provider is configured: the rules stage runs alone, and `meta.stage` says so.
 */
export async function storesFromEnv(env: NodeJS.ProcessEnv): Promise<Pick<ApiDeps, "keys" | "usage" | "corrections" | "limiter" | "idempotency" | "placement">> {
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX ?? 5), idleTimeoutMillis: Number(env.DATABASE_IDLE_TIMEOUT_MS ?? 10_000) });
    // Rate limits and idempotency live in the database too, so every instance (every Vercel function) enforces the same numbers.
    return { keys: new SqlKeyStore(pool), usage: new SqlUsageStore(pool), corrections: new SqlCorrectionStore(pool), limiter: new SqlRateLimiter(pool), idempotency: new SqlIdempotencyStore(pool),
      // Placements need the key that seals destination tokens; without it /v1/place answers 501.
      ...(env.RECAST_CREDENTIALS_KEY ? { placement: { credentials: new SqlCredentialStore(pool, new CredentialCipher(env.RECAST_CREDENTIALS_KEY)), placements: new SqlPlacementStore(pool) } } : {}) };
  }
  const keys = new MemoryKeyStore();
  for (const entry of (env.RECAST_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, tenantId, tier = "free", ...rest] = entry.split(":");
    const cohort = rest.find(isCohort) ?? "public";
    if (key && tenantId && ["free", "pro", "scale", "enterprise"].includes(tier)) await keys.add(key, { tenantId, tier: tier as Tier, correctionsOptIn: rest.includes("optin"), cohort });
  }
  return { keys };
}

const build = async (): Promise<Api> => createApi({ resolver: createResolver(), release: releaseFromEnv(process.env), ...(await storesFromEnv(process.env)) });
const g = globalThis as unknown as { __recastApi?: Promise<Api> };
export const getApi = () => (g.__recastApi ??= build());
