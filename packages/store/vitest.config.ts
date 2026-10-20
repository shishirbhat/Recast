import { defineConfig } from "vitest/config";
// PGlite boots a WebAssembly Postgres and runs the migrations per test; under a loaded machine that can exceed 5 s.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
