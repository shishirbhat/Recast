import { NextResponse, type NextRequest } from "next/server";
import { authMode, sessionFromCookies, SB_ACCESS, SB_REFRESH } from "./lib/auth-core";
import { verifySupabaseJwt } from "./lib/session";

/**
 * Sends anyone without a valid session to /signin before any page renders. For Supabase sessions it also renews an
 * expired access token with the refresh token, so people are not signed out every hour.
 */
export async function proxy(req: NextRequest) {
  if (authMode() === "demo") return NextResponse.next();
  if (await sessionFromCookies((n) => req.cookies.get(n)?.value)) return NextResponse.next();

  const refresh = req.cookies.get(SB_REFRESH)?.value;
  if (authMode() === "supabase" && refresh) {
    const renewed = await renew(refresh);
    if (renewed) {
      req.cookies.set(SB_ACCESS, renewed.access_token);
      const res = NextResponse.next({ request: { headers: req.headers } });
      setSupabaseCookies(res, renewed);
      return res;
    }
  }
  const url = req.nextUrl.clone(); url.pathname = "/signin"; url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

async function renew(refreshToken: string): Promise<{ access_token: string; refresh_token: string } | null> {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: process.env.SUPABASE_ANON_KEY!, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json() as { access_token?: string; refresh_token?: string };
    if (!j.access_token || !j.refresh_token || !(await verifySupabaseJwt(j.access_token, process.env.SUPABASE_JWT_SECRET!))) return null;
    return { access_token: j.access_token, refresh_token: j.refresh_token };
  } catch { return null; }
}

export function setSupabaseCookies(res: NextResponse, t: { access_token: string; refresh_token: string }) {
  const base = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" && process.env.RECAST_INSECURE_COOKIES !== "1", path: "/" };
  res.cookies.set(SB_ACCESS, t.access_token, { ...base, maxAge: 3600 });
  res.cookies.set(SB_REFRESH, t.refresh_token, { ...base, maxAge: 30 * 24 * 3600 });
}

// Everything except Next's own assets, the icon and the sign-in page itself.
export const config = { matcher: ["/((?!_next/|icon.svg|signin).*)"] };
