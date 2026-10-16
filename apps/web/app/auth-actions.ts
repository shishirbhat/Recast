"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authMode, SB_ACCESS, SB_REFRESH } from "@/lib/auth-core";
import { checkPassword, parseLocalUsers } from "@/lib/passwords";
import { SESSION_COOKIE, SESSION_TTL_S, safeNext, signSession, verifySupabaseJwt } from "@/lib/session";

// Brute-force brake: after 5 failures for an email within 15 minutes, that email is locked for 15 minutes.
// In memory, so per instance; a shared store would be needed across many instances.
const failures = new Map<string, { n: number; first: number }>();
const WINDOW = 15 * 60_000, LIMIT = 5;
const locked = (email: string) => { const f = failures.get(email); if (!f) return false; if (Date.now() - f.first > WINDOW) { failures.delete(email); return false; } return f.n >= LIMIT; };
const fail = (email: string) => { const f = failures.get(email); if (!f || Date.now() - f.first > WINDOW) failures.set(email, { n: 1, first: Date.now() }); else f.n++; };

const cookieBase = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" && process.env.RECAST_INSECURE_COOKIES !== "1", path: "/" });

export async function signIn(fd: FormData) {
  const email = String(fd.get("email") ?? "").trim().toLowerCase(); const password = String(fd.get("password") ?? "");
  const next = safeNext(fd.get("next"));
  const back = (err: string) => redirect(`/signin?error=${err}&next=${encodeURIComponent(next)}`);
  if (!email || !password || email.length > 320 || password.length > 1024) back("missing");
  if (locked(email)) back("locked");
  const jar = await cookies(); const mode = authMode();

  if (mode === "local") {
    const user = parseLocalUsers(process.env.RECAST_LOCAL_USERS).find((u) => u.email === email);
    // Hash even for unknown emails, so timing does not reveal which accounts exist.
    const ok = await checkPassword(password, user?.hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    if (!user || !ok) { fail(email); back("invalid"); }
    jar.set(SESSION_COOKIE, await signSession({ userId: user!.userId, email, via: "local" }, process.env.RECAST_SESSION_SECRET!), { ...cookieBase(), maxAge: SESSION_TTL_S });
  } else if (mode === "supabase") {
    let tokens: { access_token?: string; refresh_token?: string } = {};
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: process.env.SUPABASE_ANON_KEY!, "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(8000) });
      if (r.ok) tokens = await r.json() as typeof tokens;
    } catch { back("unavailable"); }
    if (!tokens.access_token || !tokens.refresh_token || !(await verifySupabaseJwt(tokens.access_token, process.env.SUPABASE_JWT_SECRET!))) { fail(email); back("invalid"); }
    jar.set(SB_ACCESS, tokens.access_token!, { ...cookieBase(), maxAge: 3600 });
    jar.set(SB_REFRESH, tokens.refresh_token!, { ...cookieBase(), maxAge: 30 * 24 * 3600 });
  } else redirect("/");
  failures.delete(email);
  redirect(next);
}

export async function signOut() {
  const jar = await cookies();
  const access = jar.get(SB_ACCESS)?.value;
  if (access && authMode() === "supabase") await fetch(`${process.env.SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: process.env.SUPABASE_ANON_KEY!, authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  for (const n of [SESSION_COOKIE, SB_ACCESS, SB_REFRESH]) jar.delete(n);
  redirect("/signin");
}
