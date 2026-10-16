// What both the proxy and server code need: which sign-in mode is on, and the session a request carries.
import { SESSION_COOKIE, verifySession, verifySupabaseJwt, type Session } from "./session";

export type AuthMode = "demo" | "local" | "supabase";
export const SB_ACCESS = "recast_sb_access", SB_REFRESH = "recast_sb_refresh";
export const DEMO_SESSION: Session = { userId: "00000000-0000-0000-0000-000000000000", email: "demo", via: "demo", exp: Number.MAX_SAFE_INTEGER };

/** Supabase when its three settings are present; local accounts when a session secret and users are; otherwise the demo.
 *  A database without any sign-in is refused: real data must never be served to an anonymous visitor. */
export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_JWT_SECRET) return "supabase";
  if (env.RECAST_SESSION_SECRET && env.RECAST_LOCAL_USERS) return "local";
  if (env.DATABASE_URL) throw new Error("DATABASE_URL is set but no sign-in is configured (set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET, or RECAST_SESSION_SECRET and RECAST_LOCAL_USERS)");
  return "demo";
}

export async function sessionFromCookies(get: (name: string) => string | undefined, env: Record<string, string | undefined> = process.env): Promise<Session | null> {
  const mode = authMode(env);
  if (mode === "demo") return DEMO_SESSION;
  if (mode === "local") return verifySession(get(SESSION_COOKIE), env.RECAST_SESSION_SECRET!);
  return verifySupabaseJwt(get(SB_ACCESS), env.SUPABASE_JWT_SECRET!);
}
