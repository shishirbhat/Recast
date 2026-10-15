import { b64u, fromB64u, randomHex, utf8 } from "./b64";
import { AuthError } from "./errors";
import { sign, verify, type AgentRegistry, type AgentRecord } from "./identity";

export const MAX_TOKEN_TTL_SEC = 900;
export interface TokenClaims { iss: string; sub: string; aud: string; iat: number; exp: number; jti: string; scope?: string; act?: { sub: string } }

const enc = (o: unknown) => b64u(utf8(JSON.stringify(o)));

/** Compact EdDSA token. The agent signs it with its own private key: possession of that key is the proof of identity. */
export async function signToken(privateJwk: JsonWebKey, claims: Omit<TokenClaims, "jti" | "iat" | "exp"> & { ttlSec?: number; now?: number; jti?: string }, kid = claims.iss): Promise<string> {
  const nowSec = Math.floor((claims.now ?? Date.now()) / 1000); const { ttlSec = 300, now: _n, jti, ...rest } = claims;
  const header = enc({ alg: "EdDSA", typ: "JWT", kid });
  const payload = enc({ ...rest, iat: nowSec, exp: nowSec + ttlSec, jti: jti ?? randomHex(8) });
  return `${header}.${payload}.${await sign(privateJwk, `${header}.${payload}`)}`;
}

export interface VerifyOptions { registry: AgentRegistry; audience: string; now?: number; maxTtlSec?: number; isRevoked?: (jti: string) => boolean | Promise<boolean>; skewSec?: number }

/** Checks, in order: shape, algorithm, known and unrevoked agent, signature, time window, audience, lifetime, token revocation. */
export async function verifyAgentToken(token: string, o: VerifyOptions): Promise<{ claims: TokenClaims; agent: AgentRecord }> {
  const parts = token.split("."); if (parts.length !== 3 || token.length > 4096) throw new AuthError("malformed", "not a compact token");
  let header: any, claims: TokenClaims;
  try { header = JSON.parse(new TextDecoder().decode(fromB64u(parts[0]!))); claims = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!))); } catch { throw new AuthError("malformed", "token is not valid base64url JSON"); }
  if (header?.alg !== "EdDSA") throw new AuthError("bad_algorithm", "only EdDSA is accepted");   // rejects "none" and HMAC downgrade
  if (typeof claims?.iss !== "string" || claims.iss !== claims.sub || header.kid !== claims.iss) throw new AuthError("malformed", "iss, sub and kid must all be the agent id");
  const agent = await o.registry.get(claims.iss);
  if (!agent) throw new AuthError("unknown_agent", "no such agent");
  if (agent.revokedAt) throw new AuthError("agent_revoked", "this agent has been revoked");
  if (!(await verify(agent.publicJwk, `${parts[0]}.${parts[1]}`, parts[2]!))) throw new AuthError("bad_signature", "signature does not match the agent's key");
  const now = Math.floor((o.now ?? Date.now()) / 1000), skew = o.skewSec ?? 30;
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") throw new AuthError("malformed", "iat and exp are required");
  if (claims.exp <= now) throw new AuthError("expired", "token has expired");
  if (claims.iat > now + skew) throw new AuthError("not_yet_valid", "token was issued in the future");
  if (claims.aud !== o.audience) throw new AuthError("wrong_audience", "token is for a different audience");
  if (claims.exp - claims.iat > (o.maxTtlSec ?? MAX_TOKEN_TTL_SEC)) throw new AuthError("ttl_too_long", `tokens may live at most ${o.maxTtlSec ?? MAX_TOKEN_TTL_SEC} seconds`);
  if (o.isRevoked && (await o.isRevoked(claims.jti))) throw new AuthError("token_revoked", "this token was revoked");
  return { claims, agent };
}
