// Writes contract/v1.json: the baseline the compatibility test compares against. Run it only when a change is reviewed as
// non-breaking (an addition), so the new surface becomes the baseline.
import { writeFileSync } from "node:fs";
import { breakingChanges, surface } from "../src/compat";
import { readFileSync, existsSync } from "node:fs";
const file = new URL("../contract/v1.json", import.meta.url);
const next = surface();
if (existsSync(file)) { const broken = breakingChanges(JSON.parse(readFileSync(file, "utf8")), next); if (broken.length) { console.error(`refusing: these are breaking changes for v1:\n- ${broken.join("\n- ")}`); process.exit(1); } }
writeFileSync(file, JSON.stringify(next, null, 2) + "\n"); console.log("contract/v1.json updated");
