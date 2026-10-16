import { backendFromEnv } from "./backend";
import { createMcpHttpServer } from "./http";

const backend = backendFromEnv(process.env); const port = Number(process.env.PORT ?? 3300);
createMcpHttpServer(backend).listen(port, () => console.log(`recast mcp (${backend.mode}) on :${port}/mcp`));
