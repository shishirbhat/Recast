// Sessions without a framework: HMAC-signed cookies for local accounts, and verification of Supabase access tokens (HS256).
// Pure functions over WebCrypto so they are unit-testable and run in the proxy and in server code alike.

export interface Session { userId: string; email: string; via: "demo" | "local" | "supabase"; exp: number }

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => { const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
const hmacKey = (secret: string) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SESSION_COOKIE = "recast_session";
export const SESSION_TTL_S = 8 * 3600;

/** `payload.signature`, both base64url. The secret must be at least 32 characters. */
export async function signSession(s: Omit<Session, "exp">, secret: string, now = Date.now()): Promise<string> {
  if (secret.length < 32) throw new Error("RECAST_SESSION_SECRET must be at least 32 characters");
  const body = b64u(enc.encode(JSON.stringify({ ...s, exp: Math.floor(now / 1000) + SESSION_TTL_S })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64u(sig)}`;
}

export async function verifySession(token: string | undefined, secret: string, now = Date.now()): Promise<Session | null> {
  if (!token || secret.length < 32) return null;
  const [body, sig, extra] = token.split("."); if (!body || !sig || extra !== undefined) return null;
  try {
    // verify() compares in constant time.
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(sig), enc.encode(body)))) return null;
    const s = JSON.parse(new TextDecoder().decode(unb64u(body))) as Session;
    if (typeof s.exp !== "number" || s.exp * 1000 <= now || !UUID.test(s.userId) || typeof s.email !== "string" || s.via !== "local") return null;
    return s;
  } catch { return null; }
}

/** A Supabase access token (legacy HS256 project JWT secret). Checks signature, expiry, audience and that the subject is a user id. */
export async function verifySupabaseJwt(token: string | undefined, jwtSecret: string, now = Date.now()): Promise<Session | null> {
  if (!token || !jwtSecret) return null;
  const parts = token.split("."); if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(new TextDecoder().decode(unb64u(h))) as { alg?: string };
    if (header.alg !== "HS256") return null;   // never "none", never a key-confusion alg
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(jwtSecret), unb64u(sig), enc.encode(`${h}.${p}`)))) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64u(p))) as { sub?: string; email?: string; exp?: number; aud?: string | string[]; role?: string };
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!c.sub || !UUID.test(c.sub) || typeof c.exp !== "number" || c.exp * 1000 <= now || !aud.includes("authenticated") || c.role !== "authenticated") return null;
    return { userId: c.sub, email: c.email ?? "", via: "supabase", exp: c.exp };
  } catch { return null; }
}

/** Test and tooling helper: an HS256 JWT the way Supabase issues them. */
export async function signHs256(claims: Record<string, unknown>, secret: string): Promise<string> {
  const h = b64u(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))), p = b64u(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}

/** Only same-site paths: "/x" yes; "//evil.com", "https://evil.com", "/\\evil" no. */
export const safeNext = (n: unknown): string => (typeof n === "string" && /^\/(?![/\\])[\x21-\x7e]*$/.test(n) ? n : "/");
