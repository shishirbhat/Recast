import "server-only";
import pg from "pg";

/** One pool per server process. It connects as a privileged role; every query for a person runs under their identity (withUser). */
const g = globalThis as unknown as { __recastPool?: pg.Pool };
export const getPool = (): pg.Pool | null => {
  if (!process.env.DATABASE_URL) return null;
  return (g.__recastPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_MAX ?? 5), idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 10_000) }));
};
