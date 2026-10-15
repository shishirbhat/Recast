import { MemoryKeyStore, createApi, type Api, type Tier } from "@recast/api-core";
import { createResolver } from "@recast/resolve";

/**
 * Keys come from RECAST_API_KEYS="sk_live_abc...:tenant_id:tier[:optin],..." until the Supabase-backed key store exists.
 * With nothing configured every authenticated call is a 401, which is the safe default.
 * No embedding or model provider is configured: the rules stage runs alone, and `meta.stage` says so.
 */
async function build(): Promise<Api> {
  const keys = new MemoryKeyStore();
  for (const entry of (process.env.RECAST_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [key, tenantId, tier = "free", optin] = entry.split(":");
    if (key && tenantId && ["free", "pro", "scale", "enterprise"].includes(tier)) await keys.add(key, { tenantId, tier: tier as Tier, correctionsOptIn: optin === "optin" });
  }
  return createApi({ resolver: createResolver(), keys });
}
const g = globalThis as unknown as { __recastApi?: Promise<Api> };
export const getApi = () => (g.__recastApi ??= build());
