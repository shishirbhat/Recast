import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({ entryPoints: [path.join(root, "src/index.ts")], bundle: true, format: "iife", globalName: "RecastExtract", target: "es2022", platform: "browser", outfile: path.join(root, "dist/recast-extract.iife.js"), legalComments: "none", logLevel: "warning" });
