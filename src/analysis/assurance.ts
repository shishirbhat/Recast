import { isTestFile } from "./depgraph.ts";
import { DependencyGraph } from "./depgraph.ts";
import { relevantTests } from "./relevant.ts";
import { changedFiles, showAt } from "../git.ts";
import { listProjectFiles } from "../server/files.ts";

/**
 * How much a passing check actually covers. A combined change that passes every check is "verified" only when:
 *   - every changed code file is reached (through imports) by a test file;
 *   - every such test file was run by one of the checks (a whole-suite command runs them all);
 *   - nothing between the changed code and its consumers is invisible to the analysis (computed imports, computed keys).
 * Otherwise it is "verified-with-gaps", and each gap says what wasn't covered. Passing is still passing; the gaps tell a
 * person what the evidence doesn't reach, so they can decide whether it matters. JavaScript and TypeScript only: in
 * other languages Relay can't tell, and says so.
 */
export interface Assurance {
  level: "verified" | "verified-with-gaps" | "not-analysed";
  gaps: string[];
  /** Test files the checks ran that reach the change. */
  covering: string[];
}

const WHOLE_SUITE = /^(npm (run )?test|yarn test|pnpm test|node --test)\s*$/;

function runsFile(commands: string[], file: string): boolean {
  return commands.some((c) => WHOLE_SUITE.test(c.trim()) || c.split(/\s+/).includes(file) || c.includes(` ${file}`));
}

export function assurance(cwd: string, base: string | null, commands: string[], exclude: string[] = []): Assurance {
  if (!base) return { level: "not-analysed", gaps: ["No base revision: what changed can't be determined"], covering: [] };
  const changed = changedFiles(cwd, base, exclude).filter((f) => !exclude.includes(f));
  const code = changed.filter((f) => /\.(m|c)?(j|t)sx?$/.test(f));
  const other = changed.filter((f) => !code.includes(f) && !/\.(md|txt|json)$/.test(f));
  const gaps: string[] = [];
  if (other.length) gaps.push(`Not analysed (only JavaScript and TypeScript are): ${other.join(", ")}`);
  if (!code.length) return { level: gaps.length ? "verified-with-gaps" : "verified", gaps, covering: [] };
  const graph = new DependencyGraph(cwd);
  graph.refresh(listProjectFiles(cwd));
  const rel = relevantTests(graph, changed);
  const covering = rel.tests.filter((t) => runsFile(commands, t.file)).map((t) => t.file);
  const notRun = rel.tests.filter((t) => !covering.includes(t.file));
  for (const f of rel.unreached) gaps.push(`No test reaches ${f}, which changed`);
  if (notRun.length) gaps.push(`Tests that reach the change but no check ran: ${notRun.map((t) => t.file).join(", ")}`);
  const reachedOnlyByUnrun = code.filter((f) => !isTestFile(f) && !rel.unreached.includes(f) && !(rel.reachedBy[f] ?? []).some((t) => runsFile(commands, t)));
  if (reachedOnlyByUnrun.length) gaps.push(`Changed code reached only by tests no check ran: ${reachedOnlyByUnrun.join(", ")}`);
  // What the analysis can't follow between the changed code and the code that uses it.
  const impact = graph.impact(base, code, (p) => showAt(cwd, base, p));
  const near = new Set([...code, ...impact.consumers.map((c) => c.file), ...graph.modules().filter((m) => m.imports.some((i) => i.to && code.includes(i.to))).map((m) => m.path)]);
  for (const m of graph.modules()) if (near.has(m.path)) for (const g of m.gaps) gaps.push(g);
  for (const g of impact.gaps) if (/can't be (followed|narrowed)/.test(g) && !gaps.includes(g)) gaps.push(g);
  return { level: gaps.length ? "verified-with-gaps" : "verified", gaps: [...new Set(gaps)], covering };
}
