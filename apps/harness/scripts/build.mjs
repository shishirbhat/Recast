import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("node", [path.join(root, "../../packages/overlay/scripts/build-css.mjs")], { stdio: "inherit" });
const out = path.join(root, "dist");
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
await build({ entryPoints: [path.join(root, "src/main.ts")], bundle: true, format: "iife", target: "es2022", platform: "browser", outfile: path.join(out, "main.js"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, legalComments: "none", logLevel: "warning" });
// Fonts: bundled from @fontsource next to the page, so screenshots show the real type without any network.
await build({ entryPoints: [path.join(root, "../../design/fonts.css")], bundle: true, outfile: path.join(out, "fonts.css"), loader: { ".woff2": "file", ".woff": "file" }, nodePaths: [path.join(root, "node_modules")], logLevel: "warning" });
cpSync(path.join(root, "src/index.html"), path.join(out, "index.html")); cpSync(path.join(root, "src/compose.html"), path.join(out, "compose.html")); cpSync(path.join(root, "src/harness.css"), path.join(out, "harness.css"));
cpSync(path.join(root, "../../design/tokens.css"), path.join(out, "tokens.css"));
console.log("harness built");
await import("./build-clay.mjs");
