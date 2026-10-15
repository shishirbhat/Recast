import pg from "pg";
import { MemoryKeyStore, SqlCorrectionStore, SqlKeyStore, SqlUsageStore, createApi, type Api, type ApiDeps, type Tier } from "@recast/api-core";
import { createResolver } from "@recast/resolve";

/**
 * With DATABASE_URL set, keys, usage and corrections live in Postgres (the Supabase migrations); issue keys with `pnpm --filter @recast/api keys`.
 * Without it, keys come from RECAST_API_KEYS="sk_live_abc...:tenant_id:tier[:optin],..." and counts live in memory (local and tests).
 * With nothing configured every authenticated call is a 401, which is the safe default.
 * No embedding or model provider is configured: the rules stage runs alone, and `meta.stage` says so.
 */
export async function storesFromEnv(env: NodeJS.ProcessEnv): Promise<Pick<ApiDeps, "keys" | "usage" | "corrections">> {
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX ?? 5), idleTimeoutMillis: Number(env.DATABASE_IDLE_TIMEOUT_MS ?? 10_000) });
    return { keys: new SqlKeyStore(pool), usage: new SqlUsageStore(pool), corrections: new SqlCorrectionStore(pool) };
  }
  const keys = new MemoryKeyStore();
  for (const entry of (env.RECAST_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, tenantId, tier = "free", optin] = entry.split(":");
    if (key && tenantId && ["free", "pro", "scale", "enterprise"].includes(tier)) await keys.add(key, { tenantId, tier: tier as Tier, correctionsOptIn: optin === "optin" });
  }
  return { keys };
}

const build = async (): Promise<Api> => createApi({ resolver: createResolver(), ...(await storesFromEnv(process.env)) });
const g = globalThis as unknown as { __recastApi?: Promise<Api> };
export const getApi = () => (g.__recastApi ??= build());
