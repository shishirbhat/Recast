import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");

/** An in-process Postgres with Supabase's `auth.uid()` and `authenticated` role stubbed, then our real migrations. */
export async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role authenticated nologin;
    grant usage on schema public to authenticated;
    grant usage on schema auth to authenticated;
    alter default privileges in schema public grant all on tables to authenticated;
  `);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(path.join(dir, f), "utf8"));
  await db.exec(`grant all on all tables in schema public to authenticated; grant all on all sequences in schema public to authenticated;`);
  return db;
}

/** Run `fn` as a signed-in user (RLS applies), like a Supabase request with that user's JWT. */
export async function as<T>(db: PGlite, user: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
export const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
