import { describe, expect, it } from "vitest";
import { authMode, DEMO_SESSION, sessionFromCookies } from "../lib/auth-core";
import { checkPassword, hashPassword, parseLocalUsers } from "../lib/passwords";
import { safeNext, signHs256, signSession, verifySession, verifySupabaseJwt } from "../lib/session";

const SECRET = "x".repeat(40); const U = "00000000-0000-0000-0000-00000000000a"; const NOW = Date.parse("2026-10-16T10:00:00Z");

describe("local session cookies", () => {
  it("round-trips, and expires after 8 hours", async () => {
    const t = await signSession({ userId: U, email: "a@x.com", via: "local" }, SECRET, NOW);
    expect(await verifySession(t, SECRET, NOW + 1000)).toMatchObject({ userId: U, email: "a@x.com", via: "local" });
    expect(await verifySession(t, SECRET, NOW + 8 * 3600_000 + 1)).toBeNull();
  });
  it("rejects tampering, another secret, junk and short secrets", async () => {
    const t = await signSession({ userId: U, email: "a@x.com", via: "local" }, SECRET, NOW);
    const [body, sig] = t.split(".");
    const forged = btoa(JSON.stringify({ userId: "00000000-0000-0000-0000-00000000000b", email: "b@x.com", via: "local", exp: 9e9 })).replace(/=+$/, "");
    for (const bad of [`${forged}.${sig}`, `${body}.${sig}x`, `${body}.${sig}.x`, "", "a.b", undefined]) expect(await verifySession(bad, SECRET, NOW)).toBeNull();
    expect(await verifySession(t, "y".repeat(40), NOW)).toBeNull();
    await expect(signSession({ userId: U, email: "", via: "local" }, "short")).rejects.toThrow("32 characters");
  });
});

describe("Supabase access tokens", () => {
  const claims = { sub: U, email: "a@x.com", aud: "authenticated", role: "authenticated", exp: NOW / 1000 + 3600 };
  it("accepts a valid token", async () => { expect(await verifySupabaseJwt(await signHs256(claims, SECRET), SECRET, NOW)).toMatchObject({ userId: U, via: "supabase" }); });
  it("rejects expiry, wrong audience or role, a non-uuid subject, another secret, and alg none", async () => {
    for (const c of [{ ...claims, exp: NOW / 1000 - 1 }, { ...claims, aud: "anon" }, { ...claims, role: "anon" }, { ...claims, sub: "admin" }])
      expect(await verifySupabaseJwt(await signHs256(c, SECRET), SECRET, NOW)).toBeNull();
    expect(await verifySupabaseJwt(await signHs256(claims, "z".repeat(40)), SECRET, NOW)).toBeNull();
    const none = `${btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "")}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.`;
    expect(await verifySupabaseJwt(none, SECRET, NOW)).toBeNull();
  });
});

describe("passwords and accounts", () => {
  it("scrypt hashes verify only the right password and are salted", async () => {
    const h = await hashPassword("correct horse battery"); expect(h).toMatch(/^scrypt\$/);
    expect(await checkPassword("correct horse battery", h)).toBe(true); expect(await checkPassword("wrong", h)).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(h); expect(await checkPassword("x", "plain")).toBe(false);
  });
  it("RECAST_LOCAL_USERS ignores malformed entries and lower-cases emails", () => {
    expect(parseLocalUsers(`A@X.com|scrypt$a$b|${U};bad;x|plain|${U};y|scrypt$a$b|not-uuid`)).toEqual([{ email: "a@x.com", hash: "scrypt$a$b", userId: U }]);
  });
});

describe("modes", () => {
  it("demo without anything; refuses a database with no sign-in; picks local or Supabase", async () => {
    expect(authMode({})).toBe("demo");
    expect(() => authMode({ DATABASE_URL: "postgres://x" })).toThrow("no sign-in is configured");
    expect(authMode({ DATABASE_URL: "x", RECAST_SESSION_SECRET: SECRET, RECAST_LOCAL_USERS: "a" })).toBe("local");
    expect(authMode({ SUPABASE_URL: "u", SUPABASE_ANON_KEY: "k", SUPABASE_JWT_SECRET: "s", RECAST_SESSION_SECRET: SECRET, RECAST_LOCAL_USERS: "a" })).toBe("supabase");
    expect(await sessionFromCookies(() => undefined, {})).toEqual(DEMO_SESSION);
    expect(await sessionFromCookies(() => undefined, { RECAST_SESSION_SECRET: SECRET, RECAST_LOCAL_USERS: "a" })).toBeNull();
  });
  it("only same-site redirect targets after sign-in", () => {
    for (const ok of ["/", "/approvals", "/a?b=c"]) expect(safeNext(ok)).toBe(ok);
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil", "/a b", 5, undefined]) expect(safeNext(bad)).toBe("/");
  });
});
