import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };

/** `scrypt$<salt b64>$<hash b64>`: what goes in RECAST_LOCAL_USERS. Make one with `pnpm --filter @recast/web hash-password`. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16); const h = await scrypt(pw, salt, 32, PARAMS);
  return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}
export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64"); const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, PARAMS);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface LocalUser { email: string; hash: string; userId: string }
/** RECAST_LOCAL_USERS="email|scrypt$..$..|uuid;email2|...". Malformed entries are ignored, never half-trusted. */
export function parseLocalUsers(v: string | undefined): LocalUser[] {
  return (v ?? "").split(";").map((s) => s.trim()).filter(Boolean).flatMap((e) => {
    const [email, hash, userId] = e.split("|");
    return email && hash?.startsWith("scrypt$") && userId && /^[0-9a-f-]{36}$/i.test(userId) ? [{ email: email.toLowerCase(), hash, userId }] : [];
  });
}
