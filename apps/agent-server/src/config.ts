import type { CredentialVault } from "@recast/agent-runtime";
import { parseOverrides, ReleaseConfigError, type Capability, type ReleaseState } from "@recast/release";

export interface ServerConfig {
  port: number; databaseUrl: string;
  /** The audience agent tokens are issued for. */
  audience: string;
  /** The MCP server behind the gateway. */
  upstreamUrl: string;
  /** The URL clients call, for proof binding when a proxy sits in front. */
  publicUrl?: string;
  proof: "off" | "optional" | "required";
  adminToken: string;
  signingKey: { privateJwk: JsonWebKey; publicJwk: JsonWebKey; keyId: string };
  vault: Record<string, Record<string, string>>;
  /** "required": every tool call must fit an active Space of the agent (docs/16-spaces.md). */
  spaces: "off" | "required";
  /** Directory of reviewed recipes (docs/19-recipes.md). Without it, no recipe can be applied. */
  recipesDir?: string;
  /** RECAST_RELEASE overrides (docs/RELEASE_STATES.md). */
  release: Partial<Record<Capability, ReleaseState>>;
}

export class ConfigError extends Error { constructor(m: string) { super(m); this.name = "ConfigError"; } }

/** Everything comes from the environment. Missing or weak values stop the server at start-up, not at the first request. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const need = (k: string) => { const v = env[k]; if (!v) throw new ConfigError(`${k} is required`); return v; };
  const adminToken = need("ADMIN_TOKEN"); if (adminToken.length < 24) throw new ConfigError("ADMIN_TOKEN must be at least 24 characters");
  let jwk: JsonWebKey; try { jwk = JSON.parse(need("RUNTIME_SIGNING_KEY")); } catch { throw new ConfigError("RUNTIME_SIGNING_KEY must be an Ed25519 private JWK as JSON"); }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new ConfigError("RUNTIME_SIGNING_KEY must be an Ed25519 private JWK (kty OKP, crv Ed25519, with d and x)");
  const proof = (env.PROOF_MODE ?? "required") as ServerConfig["proof"]; if (!["off", "optional", "required"].includes(proof)) throw new ConfigError("PROOF_MODE must be off, optional or required");
  let vault: ServerConfig["vault"] = {}; if (env.RECAST_VAULT) { try { vault = JSON.parse(env.RECAST_VAULT); } catch { throw new ConfigError("RECAST_VAULT must be JSON: {\"<tenant id>\": {\"<tool>\": \"<credential>\"}}"); } }
  const port = Number(env.PORT ?? 8080); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("PORT must be a port number");
  const upstreamUrl = need("UPSTREAM_URL"); try { new URL(upstreamUrl); } catch { throw new ConfigError("UPSTREAM_URL must be a URL"); }
  const spaces = (env.SPACES_MODE ?? "off") as ServerConfig["spaces"]; if (!["off", "required"].includes(spaces)) throw new ConfigError("SPACES_MODE must be off or required");
  let release: ServerConfig["release"]; try { release = parseOverrides(env.RECAST_RELEASE); } catch (e) { if (e instanceof ReleaseConfigError) throw new ConfigError(e.message); throw e; }
  return { spaces, release, ...(env.RECIPES_DIR ? { recipesDir: env.RECIPES_DIR } : {}), port, databaseUrl: need("DATABASE_URL"), audience: env.GATEWAY_AUDIENCE ?? "recast-gateway", upstreamUrl, ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}), proof, adminToken,
    signingKey: { privateJwk: jwk, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, keyId: env.RUNTIME_KEY_ID ?? "rt-1" }, vault };
}

/** Credentials from configuration. A real deployment would read a secrets manager behind this same interface. */
export class ConfigVault implements CredentialVault {
  constructor(private v: ServerConfig["vault"]) {}
  async get(tenantId: string, tool: string) { return this.v[tenantId]?.[tool] ?? null; }
}
