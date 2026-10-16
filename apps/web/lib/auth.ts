import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authMode, sessionFromCookies } from "./auth-core";
import type { Session } from "./session";

export { authMode };
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return sessionFromCookies((n) => jar.get(n)?.value);
}
/** Every page and action that touches data calls this, as well as the proxy checking first (defence in depth). */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/signin");
  return s;
}
