import pg from "pg";
import { KEYS_USAGE, runKeysCli } from "@recast/api-core/admin";

const url = process.env.DATABASE_URL;
if (!url) { console.error(`DATABASE_URL is not set.\n\n${KEYS_USAGE}`); process.exit(2); }
const pool = new pg.Pool({ connectionString: url, max: 1 });
const stdin = async () => { const c: Buffer[] = []; for await (const x of process.stdin) c.push(x as Buffer); return Buffer.concat(c).toString("utf8"); };
try { process.exitCode = await runKeysCli(process.argv.slice(2), pool, (s) => console.log(s), (s) => console.error(s), { stdin, ...(process.env.RECAST_CREDENTIALS_KEY ? { credentialsKey: process.env.RECAST_CREDENTIALS_KEY } : {}) }); }
finally { await pool.end(); }
