import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = { entryPoints: [path.join(root, "src/index.ts")], bundle: true, target: "es2022", platform: "browser", sourcemap: false, legalComments: "none", logLevel: "info" };
await build({ ...common, format: "esm", outfile: path.join(root, "dist/recast-core.esm.js") });
await build({ ...common, format: "iife", globalName: "RecastCore", outfile: path.join(root, "dist/recast-core.iife.js") });
