#!/usr/bin/env -S npx tsx
// For desktop agents (Claude Desktop, IDEs): runs over stdin/stdout. RECAST_API_KEY switches from the local engine to the hosted API.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { backendFromEnv } from "./backend";
import { createRecastMcpServer } from "./server";

await createRecastMcpServer(backendFromEnv(process.env)).connect(new StdioServerTransport());
