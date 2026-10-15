import pg from "pg";
import { KEYS_USAGE, runKeysCli } from "@recast/api-core/admin";

const url = process.env.DATABASE_URL;
if (!url) { console.error(`DATABASE_URL is not set.\n\n${KEYS_USAGE}`); process.exit(2); }
const pool = new pg.Pool({ connectionString: url, max: 1 });
try { process.exitCode = await runKeysCli(process.argv.slice(2), pool, (s) => console.log(s), (s) => console.error(s)); }
finally { await pool.end(); }
