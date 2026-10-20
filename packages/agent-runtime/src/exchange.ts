import { signToken } from "./token";

/** Where the real upstream credentials live. The agent never sees these; only the gateway does. */
export interface CredentialVault { get(tenantId: string, tool: string): Promise<string | null> }
export class MemoryVault implements CredentialVault {
  private m = new Map<string, string>();
  set(tenantId: string, tool: string, secret: string) { this.m.set(`${tenantId}|${tool}`, secret); }
  async get(t: string, tool: string) { return this.m.get(`${t}|${tool}`) ?? null; }
}

export interface Exchange { tokenType: "Bearer"; accessToken: string; scope: string; actor: string; expiresInSec: number }
/**
 * RFC 8693 style: the agent's identity token is traded for a credential scoped to one tool and one action.
 * Two modes: hand the upstream its own stored credential (vault), or mint a short runtime-signed token that
 * carries the agent as `act` for upstreams that trust the runtime.
 */
export async function exchangeToken(o: { tenantId: string; agentId: string; tool: string; action: string; mode: "vault" | "runtime-jwt"; vault?: CredentialVault; runtime?: { privateJwk: JsonWebKey; issuer: string }; now?: number }): Promise<Exchange | null> {
  const scope = `${o.tool}:${o.action}`;
  if (o.mode === "vault") {
    const secret = await o.vault?.get(o.tenantId, o.tool); if (!secret) return null;
    return { tokenType: "Bearer", accessToken: secret, scope, actor: o.agentId, expiresInSec: 60 };
  }
  if (!o.runtime) return null;
  const t = await signToken(o.runtime.privateJwk, { iss: o.runtime.issuer, sub: o.tenantId, aud: o.tool, scope, act: { sub: o.agentId }, ttlSec: 60, ...(o.now !== undefined ? { now: o.now } : {}) }, o.runtime.issuer);
  return { tokenType: "Bearer", accessToken: t, scope, actor: o.agentId, expiresInSec: 60 };
}
