import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
export default function setup() {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync("node", [path.join(pkg, "scripts/build.mjs")], { stdio: "inherit" });
}
