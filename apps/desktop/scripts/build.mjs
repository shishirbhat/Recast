// Builds the desktop app into dist/: the main process, the preload door, the pages, fonts, icons, and the playground
// (the try-it page with sample data, offline). Everything is bundled, so the packaged app carries no node_modules.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const out = path.join(root, "dist");
execFileSync("node", [path.join(repo, "packages/overlay/scripts/build-css.mjs")], { stdio: "inherit" });
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const common = { bundle: true, target: "es2022", legalComments: "none", logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } };
await build({ ...common, entryPoints: [path.join(root, "src/main.ts")], platform: "node", format: "cjs", outfile: path.join(out, "main.js"), external: ["electron"], target: "node22" });
await build({ ...common, entryPoints: [path.join(root, "src/preload.ts")], platform: "node", format: "cjs", outfile: path.join(out, "preload.js"), external: ["electron"], target: "node22" });
for (const name of ["renderer", "connections"]) await build({ ...common, entryPoints: [path.join(root, `src/${name}.ts`)], platform: "browser", format: "iife", outfile: path.join(out, `${name}.js`) });
await build({ entryPoints: [path.join(repo, "design/fonts.css")], bundle: true, outfile: path.join(out, "fonts.css"), loader: { ".woff2": "file", ".woff": "file" }, nodePaths: [path.join(repo, "apps/harness/node_modules")], logLevel: "warning" });
for (const f of ["index.html", "connections.html", "app.css"]) cpSync(path.join(root, "src", f), path.join(out, f));
for (const f of readdirSync(path.join(root, "build"))) if (/^tray/.test(f)) cpSync(path.join(root, "build", f), path.join(out, f));
// The playground: the try-it page (sample data, stand-in destinations, said so on every review), built if needed.
const harness = path.join(repo, "apps/harness/dist");
if (!existsSync(path.join(harness, "clay.html"))) execFileSync("pnpm", ["--filter", "@recast/harness", "build"], { stdio: "inherit", cwd: repo });
mkdirSync(path.join(out, "playground"));
for (const f of readdirSync(harness)) if (f === "clay.html" || f === "fonts.css" || /\.woff2?$/.test(f)) cpSync(path.join(harness, f), path.join(out, "playground", f));
console.log("desktop built");
