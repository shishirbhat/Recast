import { isTestFile } from "./depgraph.ts";
import type { DependencyGraph } from "./depgraph.ts";

/**
 * Relevant-test selection: the test files that reach a change through imports, each with the import chain that links
 * it (the evidence), plus the changed code that no test reaches, said as a gap rather than hidden. Static: a test that
 * loads code dynamically, or only through a process it starts, is not seen, so running the selection is a fast first
 * check, never a replacement for the task's full verification.
 */
export interface RelevantTests {
  changed: string[];
  tests: { file: string; chain: string[]; changedItself: boolean }[];
  /** Changed code files that no test reaches through imports. */
  unreached: string[];
  /** For each changed code file, the test files that reach it. */
  reachedBy: Record<string, string[]>;
  limits: string[];
}

export function relevantTests(graph: DependencyGraph, changed: string[]): RelevantTests {
  const code = changed.filter((f) => /\.(m|c)?(j|t)sx?$/.test(f));
  const reached = graph.testsReaching(code);
  const tests = new Map<string, { file: string; chain: string[]; changedItself: boolean }>();
  for (const t of reached) tests.set(t.file, { file: t.file, chain: t.chain, changedItself: changed.includes(t.file) });
  for (const f of changed) if (isTestFile(f) && !tests.has(f)) tests.set(f, { file: f, chain: [f], changedItself: true });
  // Covered means some test reaches the file, judged per file (a test's listed chain is only its shortest one).
  const reachedBy = new Map(code.filter((f) => !isTestFile(f)).map((f) => [f, graph.testsReaching([f]).map((t) => t.file)]));
  return {
    changed,
    tests: [...tests.values()].sort((a, b) => a.chain.length - b.chain.length || a.file.localeCompare(b.file)),
    unreached: [...reachedBy.entries()].filter(([, ts]) => !ts.length).map(([f]) => f),
    reachedBy: Object.fromEntries(reachedBy),
    limits: ["Found by following imports in JavaScript and TypeScript. Tests that load code dynamically, or through a process they start, aren't found: run the task's full checks before integrating."],
  };
}
