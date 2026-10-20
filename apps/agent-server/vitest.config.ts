import { defineConfig } from "vitest/config";
// Hooks start Postgres, HTTP servers or browsers; under a parallel full run a cold start can exceed the 10 s default.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 120_000 } });
