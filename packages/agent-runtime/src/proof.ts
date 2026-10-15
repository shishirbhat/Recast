import { sha256Hex } from "@recast/core";
import { b64u, fromB64u, randomHex, utf8 } from "./b64";
import { AuthError } from "./errors";
import { sign, verify, type AgentRecord } from "./identity";

/**
 * DPoP-style proof of possession (RFC 9449 shape): every request carries a small JWT signed by the agent's key,
 * naming the method, the URL and a hash of the access token. A stolen access token is useless without the key,
 * and a captured proof is useless for a different request or a second time.
 */
export interface ProofClaims { htm: string; htu: string; iat: number; jti: string; ath: string }
const sha256B64u = async (s: string) => { const hex = await sha256Hex(s); return b64u(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))); };
/** Query and fragment are not part of the bound URL. */
export const normaliseUrl = (u: string) => { const x = new URL(u); return `${x.origin}${x.pathname}`; };

export async function createProof(privateJwk: JsonWebKey, o: { agentId: string; method: string; url: string; accessToken: string; now?: number; jti?: string }): Promise<string> {
  const header = b64u(utf8(JSON.stringify({ typ: "dpop+jwt", alg: "EdDSA", kid: o.agentId })));
  const payload = b64u(utf8(JSON.stringify({ htm: o.method.toUpperCase(), htu: normaliseUrl(o.url), iat: Math.floor((o.now ?? Date.now()) / 1000), jti: o.jti ?? randomHex(8), ath: await sha256B64u(o.accessToken) } satisfies ProofClaims)));
  return `${header}.${payload}.${await sign(privateJwk, `${header}.${payload}`)}`;
}

/** First use of a proof id wins. The same id again, within the window, is a replay. */
export interface ReplayCache { firstUse(tenantId: string, jti: string, nowMs: number): Promise<boolean> }
export class MemoryReplayCache implements ReplayCache {
  private seen = new Map<string, number>(); constructor(private windowMs = 120_000) {}
  async firstUse(tenantId: string, jti: string, now: number) {
    for (const [k, t] of this.seen) if (now - t > this.windowMs) this.seen.delete(k);
    const k = `${tenantId}|${jti}`; if (this.seen.has(k)) return false; this.seen.set(k, now); return true;
  }
}

export async function verifyProof(proof: string, o: { agent: AgentRecord; method: string; url: string; accessToken: string; replay: ReplayCache; now?: number; windowSec?: number }): Promise<ProofClaims> {
  const parts = proof.split("."); if (parts.length !== 3 || proof.length > 2048) throw new AuthError("malformed", "proof is not a compact token");
  let header: any, c: ProofClaims;
  try { header = JSON.parse(new TextDecoder().decode(fromB64u(parts[0]!))); c = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!))); } catch { throw new AuthError("malformed", "proof is not valid base64url JSON"); }
  if (header?.typ !== "dpop+jwt" || header?.alg !== "EdDSA" || header?.kid !== o.agent.agentId) throw new AuthError("bad_signature", "proof header does not match this agent");
  if (!(await verify(o.agent.publicJwk, `${parts[0]}.${parts[1]}`, parts[2]!))) throw new AuthError("bad_signature", "proof was not signed by this agent's key");
  const now = o.now ?? Date.now(), win = (o.windowSec ?? 60) * 1000;
  if (typeof c.iat !== "number" || Math.abs(now - c.iat * 1000) > win) throw new AuthError("expired", "proof is outside its time window");
  if (c.htm !== o.method.toUpperCase() || c.htu !== normaliseUrl(o.url)) throw new AuthError("wrong_audience", "proof was made for a different request");
  if (c.ath !== (await sha256B64u(o.accessToken))) throw new AuthError("bad_signature", "proof is not bound to this access token");
  if (typeof c.jti !== "string" || !c.jti || !(await o.replay.firstUse(o.agent.tenantId, c.jti, now))) throw new AuthError("token_revoked", "this proof was already used");
  return c;
}
