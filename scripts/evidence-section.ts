/**
 * The integration proof keeps deterministic and real-agent evidence in one file, in separate sections that each script
 * owns. A script replaces only the text between its own markers, so rerunning one never rewrites the other's results.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function writeSection(file: string, name: string, body: string): void {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const a = cur.indexOf(start);
  const b = cur.indexOf(end);
  const next = a >= 0 && b > a ? cur.slice(0, a) + block + cur.slice(b + end.length) : `${cur.trimEnd()}${cur.trim() ? "\n\n" : ""}${block}\n`;
  writeFileSync(file, next);
}
