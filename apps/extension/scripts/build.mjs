// Builds the production extension into dist/ and a test variant into dist-test/.
// The test variant differs ONLY by host_permissions for http://127.0.0.1/*, because Playwright cannot perform the
// user gesture that grants activeTab. The production manifest is audited by a test.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => path.join(root, "src", f);
for (const [dir, extra] of [["dist", {}], ["dist-test", { host_permissions: ["http://127.0.0.1/*"] }]]) {
  const out = path.join(root, dir);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  await build({ entryPoints: { page: src("page.ts"), popup: src("popup.ts") }, bundle: true, format: "iife", target: "es2022", platform: "browser", outdir: out, legalComments: "none", logLevel: "warning", minifySyntax: true, define: { __RECAST_TEST__: String(dir === "dist-test") } });
  cpSync(src("popup.html"), path.join(out, "popup.html")); cpSync(src("popup.css"), path.join(out, "popup.css"));
  cpSync(path.join(root, "../../design/tokens.css"), path.join(out, "tokens.css"));
  const manifest = { ...JSON.parse(readFileSync(src("manifest.json"), "utf8")), ...extra };
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
}
console.log("built dist/ and dist-test/");
