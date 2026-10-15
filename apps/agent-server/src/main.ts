import pg from "pg";
import { loadConfig } from "./config";
import { createRuntimeServer } from "./server";

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const { server } = createRuntimeServer(config, pool as unknown as Parameters<typeof createRuntimeServer>[1]);
server.listen(config.port, () => console.log(`agent runtime listening on :${config.port} (proof: ${config.proof})`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { server.close(() => { void pool.end().then(() => process.exit(0)); }); });
