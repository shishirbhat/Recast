import { b64u, fromB64u, randomHex, utf8 } from "./b64";

export interface AgentIdentity { agentId: string; name: string; org: string; publicJwk: JsonWebKey; createdAt: string }
/** The private half never leaves the caller's machine; the runtime only ever stores the public JWK. */
export interface AgentKeyPair extends AgentIdentity { privateJwk: JsonWebKey }

export async function generateKeyPair(): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const [publicJwk, privateJwk] = await Promise.all([crypto.subtle.exportKey("jwk", kp.publicKey), crypto.subtle.exportKey("jwk", kp.privateKey)]);
  return { publicJwk, privateJwk };
}
export async function createAgentIdentity(name: string, org: string, now: () => Date = () => new Date()): Promise<AgentKeyPair> {
  if (!/^[\w .-]{1,64}$/.test(name)) throw new Error("agent name must be 1 to 64 letters, digits, spaces, dots, dashes or underscores");
  const { publicJwk, privateJwk } = await generateKeyPair();
  return { agentId: `agt_${randomHex(6)}`, name, org, publicJwk, privateJwk, createdAt: now().toISOString() };
}
export const importPrivate = (jwk: JsonWebKey) => crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
export const importPublic = (jwk: JsonWebKey) => crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
export async function sign(privateJwk: JsonWebKey, data: string): Promise<string> { return b64u(await crypto.subtle.sign({ name: "Ed25519" }, await importPrivate(privateJwk), utf8(data))); }
export async function verify(publicJwk: JsonWebKey, data: string, sigB64u: string): Promise<boolean> {
  try { return await crypto.subtle.verify({ name: "Ed25519" }, await importPublic(publicJwk), fromB64u(sigB64u), utf8(data)); } catch { return false; }
}

/** What the runtime knows about an agent. */
export interface AgentRecord { agentId: string; tenantId: string; name: string; publicJwk: JsonWebKey; ownerUserId?: string; revokedAt?: string }
export interface AgentRegistry { get(agentId: string): Promise<AgentRecord | null> }
export class MemoryAgentRegistry implements AgentRegistry {
  private m = new Map<string, AgentRecord>();
  async register(rec: AgentRecord) { this.m.set(rec.agentId, { ...rec }); }
  async get(id: string) { return this.m.get(id) ?? null; }
  async revoke(id: string, at = new Date().toISOString()) { const r = this.m.get(id); if (r) r.revokedAt = at; }
}
