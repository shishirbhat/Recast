import { describe, expect, it } from "vitest";
import { b64u, utf8 } from "../src/b64";
import { AuditLog, GENESIS, MemoryAgentRegistry, MemoryAuditStore, MemoryScopeStore, checkConstraints, createAgentIdentity, evaluate, generateKeyPair, parsePolicy, redact, signToken, verifyAgentToken, verifyChain, AuthError, type AuditEntry } from "../src";

const T0 = Date.parse("2026-10-15T10:00:00Z");
async function setup() {
  const id = await createAgentIdentity("calendar-bot", "acme"); const reg = new MemoryAgentRegistry();
  await reg.register({ agentId: id.agentId, tenantId: "t1", name: id.name, publicJwk: id.publicJwk }); return { id, reg };
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AuthError ? e.code : `other:${e}`));

describe("agent identity and tokens", () => {
  it("an agent gets an id and an Ed25519 key pair; the registry only needs the public half", async () => {
    const { id } = await setup();
    expect(id.agentId).toMatch(/^agt_[0-9a-f]{12}$/); expect(id.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519" }); expect(id.publicJwk.d).toBeUndefined(); expect(id.privateJwk.d).toBeTruthy();
    await expect(createAgentIdentity("bad/name", "acme")).rejects.toThrow(/agent name/);
  });
  it("a token signed by the agent verifies and carries the audience and a short lifetime", async () => {
    const { id, reg } = await setup();
    const t = await signToken(id.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: T0, ttlSec: 300 });
    const v = await verifyAgentToken(t, { registry: reg, audience: "gw", now: T0 + 1000 });
    expect(v.claims).toMatchObject({ iss: id.agentId, aud: "gw" }); expect(v.claims.exp - v.claims.iat).toBe(300); expect(v.agent.tenantId).toBe("t1");
  });
  it("rejects: another agent's key, tampered claims, expired, wrong audience, too-long lifetime, future, revoked agent, revoked token", async () => {
    const { id, reg } = await setup(); const other = await generateKeyPair();
    const good = await signToken(id.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: T0 });
    const forged = await signToken(other.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: T0 });
    expect(await code(verifyAgentToken(forged, { registry: reg, audience: "gw", now: T0 }))).toBe("bad_signature");
    const [h, p, s] = good.split("."); const edited = JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/"))); edited.aud = "other";
    expect(await code(verifyAgentToken(`${h}.${b64u(utf8(JSON.stringify(edited)))}.${s}`, { registry: reg, audience: "other", now: T0 }))).toBe("bad_signature");
    expect(await code(verifyAgentToken(good, { registry: reg, audience: "gw", now: T0 + 301_000 }))).toBe("expired");
    expect(await code(verifyAgentToken(good, { registry: reg, audience: "somewhere-else", now: T0 }))).toBe("wrong_audience");
    const long = await signToken(id.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: T0, ttlSec: 7200 });
    expect(await code(verifyAgentToken(long, { registry: reg, audience: "gw", now: T0 }))).toBe("ttl_too_long");
    const future = await signToken(id.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: T0 + 600_000 });
    expect(await code(verifyAgentToken(future, { registry: reg, audience: "gw", now: T0 }))).toBe("not_yet_valid");
    expect(await code(verifyAgentToken(good, { registry: reg, audience: "gw", now: T0, isRevoked: () => true }))).toBe("token_revoked");
    await reg.revoke(id.agentId); expect(await code(verifyAgentToken(good, { registry: reg, audience: "gw", now: T0 }))).toBe("agent_revoked");
  });
  it("rejects alg:none, unknown agents and garbage", async () => {
    const { reg } = await setup();
    const none = `${b64u(utf8(JSON.stringify({ alg: "none", kid: "agt_x" })))}.${b64u(utf8(JSON.stringify({ iss: "agt_x", sub: "agt_x" })))}.`;
    expect(await code(verifyAgentToken(none, { registry: reg, audience: "gw" }))).toBe("bad_algorithm");
    const ghost = await createAgentIdentity("ghost", "x"); const t = await signToken(ghost.privateJwk, { iss: ghost.agentId, sub: ghost.agentId, aud: "gw", now: T0 });
    expect(await code(verifyAgentToken(t, { registry: reg, audience: "gw", now: T0 }))).toBe("unknown_agent");
    for (const junk of ["", "a.b", "a.b.c.d", "!!!.!!!.!!!"]) expect(await code(verifyAgentToken(junk, { registry: reg, audience: "gw" }))).toBe("malformed");
  });
});

describe("scopes", () => {
  it("constraints: max, min, eq, in; arrays count by length; a missing constrained param fails", () => {
    const c = { attendees: { max: 3 }, calendar: { in: ["primary"] } };
    expect(checkConstraints(c, { attendees: ["a", "b"], calendar: "primary" })).toBeNull();
    expect(checkConstraints(c, { attendees: ["a", "b", "c", "d"], calendar: "primary" })).toMatch(/at most 3/);
    expect(checkConstraints(c, { attendees: ["a"], calendar: "work" })).toMatch(/one of/);
    expect(checkConstraints(c, { calendar: "primary" })).toMatch(/required/);
  });
  it("a grant has a call budget that is spent atomically, and expires", async () => {
    const s = new MemoryScopeStore(); const g = await s.grant({ agentId: "a", tenantId: "t", tool: "x", action: "y", maxCalls: 2, expiresAt: new Date(T0 + 60_000).toISOString() });
    const results = await Promise.all([1, 2, 3, 4].map(() => s.consume(g.id, T0)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await s.find("a", "x", "y", T0)).toEqual([]);                               // exhausted
    const g2 = await s.grant({ agentId: "a", tenantId: "t", tool: "x", action: "z", maxCalls: 5, expiresAt: new Date(T0 + 1000).toISOString() });
    expect(await s.consume(g2.id, T0 + 2000)).toBe(false);                             // expired
  });
});

describe("policy", () => {
  const call = { agentId: "agt_1", tool: "gmail", action: "send_email" };
  it("default is deny; a missing fact never unlocks an allow", () => {
    const p = parsePolicy(`rules:\n  - tool: gmail\n    action: send_email\n    when: { recipient_domain: internal }\n    then: allow\n`);
    expect(evaluate(p, call, { recipient_domain: "internal" }).decision).toBe("allow");
    expect(evaluate(p, call, {}).decision).toBe("deny");
    expect(evaluate(p, { ...call, tool: "notion" }, { recipient_domain: "internal" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/default/) });
  });
  it("deny beats require_approval beats allow, whatever order the rules are in", () => {
    const p = parsePolicy(`rules:\n  - { id: a, tool: gmail, then: allow }\n  - { id: r, tool: gmail, action: send_email, then: require_approval }\n  - { id: d, tool: gmail, when: { recipient_domain: banned }, then: deny }\n`);
    expect(evaluate(p, call, {})).toMatchObject({ decision: "require_approval", ruleId: "r" });
    expect(evaluate(p, call, { recipient_domain: "banned" })).toMatchObject({ decision: "deny", ruleId: "d" });
  });
  it("conditions: comparison strings and operator objects", () => {
    const p = parsePolicy(`rules:\n  - tool: google_calendar\n    when:\n      confidence: ">= 0.9"\n      attendee_count: { lte: 10 }\n      domain: { in: [a.com, b.com], notIn: [b.com] }\n    then: allow\n`);
    const c = { agentId: "x", tool: "google_calendar", action: "create_event" };
    expect(evaluate(p, c, { confidence: 0.95, attendee_count: 3, domain: "a.com" }).decision).toBe("allow");
    expect(evaluate(p, c, { confidence: 0.85, attendee_count: 3, domain: "a.com" }).decision).toBe("deny");
    expect(evaluate(p, c, { confidence: 0.95, attendee_count: 11, domain: "a.com" }).decision).toBe("deny");
    expect(evaluate(p, c, { confidence: 0.95, attendee_count: 3, domain: "b.com" }).decision).toBe("deny");
  });
  it("bad policy text is refused with a message, not half-applied", () => {
    expect(() => parsePolicy(`default: maybe`)).toThrow(/default must be/);
    expect(() => parsePolicy(`rules:\n  - { tool: x, then: sure }`)).toThrow(/rule 0/);
    expect(() => parsePolicy(`rules:\n  - { tool: x, when: { a: { matches: "(" } }, then: allow }`)).toThrow(/bad regex/);
  });
});

describe("audit chain", () => {
  async function filled(n = 4) {
    const signer = await generateKeyPair(); const store = new MemoryAuditStore(); const log = new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "k1" }, () => new Date(T0));
    for (let i = 0; i < n; i++) await log.append({ tenantId: "t1", agentId: "agt_1", requestId: `r${i}`, tool: "gmail", action: "send", params: { to: `u${i}@x.com` }, result: "success" });
    return { store, keys: { k1: signer.publicJwk }, entries: await store.list("t1") };
  }
  it("links entries by hash, signs each, and verifies end to end", async () => {
    const { entries, keys } = await filled();
    expect(entries[0]!.prevHash).toBe(GENESIS); expect(entries[1]!.prevHash).toBe(entries[0]!.hash); expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await verifyChain(entries, keys, entries.at(-1)!.hash)).toEqual({ ok: true, entries: 4 });
  });
  it("detects an edited entry, a removed one, a reordered pair, a forged signature and a cut-off tail", async () => {
    const { entries, keys } = await filled(); const clone = () => structuredClone(entries) as AuditEntry[];
    const edited = clone(); (edited[1]!.params as any).to = "evil@x.com"; expect(await verifyChain(edited, keys)).toMatchObject({ ok: false, brokenAt: 2, reason: "entry contents were changed" });
    const removed = clone(); removed.splice(1, 1); expect(await verifyChain(removed, keys)).toMatchObject({ ok: false });
    const swapped = clone(); [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!]; expect(await verifyChain(swapped, keys)).toMatchObject({ ok: false });
    const other = await generateKeyPair(); expect(await verifyChain(entries, { k1: other.publicJwk })).toMatchObject({ ok: false, reason: "signature is invalid" });
    expect(await verifyChain(entries.slice(0, 3), keys, entries.at(-1)!.hash)).toMatchObject({ ok: false, reason: "entries are missing from the end" });
  });
  it("concurrent appends still form one straight chain", async () => {
    const signer = await generateKeyPair(); const store = new MemoryAuditStore(); const log = new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "k1" });
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append({ tenantId: "t", agentId: "a", requestId: `r${i}`, tool: "x", action: "y", params: {}, result: "success" })));
    expect(await verifyChain(await store.list("t"), { k1: signer.publicJwk })).toEqual({ ok: true, entries: 20 });
  });
  it("two writers cannot fork the chain: the second append with a stale head is refused", async () => {
    const { store, entries } = await filled(2);
    await expect(store.append({ ...entries[1]!, seq: 3 })).rejects.toThrow(/conflict/);
  });
  it("credentials in parameters never reach the log", async () => {
    expect(redact({ to: "a@x.com", api_key: "sk-123", nested: { Authorization: "Bearer abc", ok: 1 }, list: [{ password: "p" }] })).toEqual({ to: "a@x.com", api_key: "[redacted]", nested: { Authorization: "[redacted]", ok: 1 }, list: [{ password: "[redacted]" }] });
  });
});
