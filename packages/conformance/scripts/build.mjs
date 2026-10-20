// Builds the core bundles and the browser conformance bundle. Run before tests.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("node", [path.resolve(pkg, "../core/scripts/bundle.mjs")], { stdio: "inherit" });
await build({
  entryPoints: [path.join(pkg, "src/browser-entry.ts")], bundle: true, format: "iife", target: "es2022",
  platform: "browser", outfile: path.join(pkg, "dist/conformance.iife.js"), logLevel: "warning",
  external: ["@recast/core"],
});
