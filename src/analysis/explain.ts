import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { inScope } from "../core/conflicts.ts";
import type { ContractVersion, Explanation, ExplanationCause, FailedCheck, Integration, Task } from "../core/types.ts";
import { changedFiles, showAt } from "../git.ts";
import { DependencyGraph } from "./depgraph.ts";
import type { Consumer, InterfaceChange } from "./depgraph.ts";

/**
 * Why a combined change failed its verification, from evidence only.
 *
 * The decision to block is always the verification result; this only explains it. A cause is built from a chain of
 * recorded facts, never from names that look alike:
 *   1. an exported interface changed between the base revision and the combined tree (parsed from source),
 *   2. which task made that change (the agent run's own diff, or failing that the task's declared scope),
 *   3. a module that imports it and reads a property the interface no longer returns (static data flow),
 *   4. which task owns that consumer (declared scope),
 *   5. a failing test or check that points at the consumer: its reported location or output names a file that reaches
 *      the consumer through imports,
 *   6. the contract both tasks were built against, used only when it is accepted and current for both.
 *
 * "confirmed": every failing test is linked to exactly one concrete break by steps 1-5.
 * "likely":    some evidence points at a cause, but a link is missing or more than one cause fits. What's missing is said.
 * "unknown":   nothing in the evidence explains the failure. Nothing is guessed.
 */

export interface ExplainInput {
  cwd: string;
  base: string | null;
  tree: string;
  tasks: Task[];
  results: { command: string; exitCode: number | null; output: string }[];
  /** Files each task's own run changed, when the agent runner knows them. Otherwise ownership comes from task scope. */
  changedBy?: Record<string, string[]>;
  currentContract: (id: string) => ContractVersion | undefined;
}

/** Failing tests from TAP output (`not ok N - name` with its `location:`), relative to `cwd`. */
export function parseFailures(command: string, output: string, cwd: string): FailedCheck {
  const roots = [cwd, safeReal(cwd)].map((r) => r.replace(/\/$/, "") + "/");
  const rel = (p: string) => {
    let s = p.replace(/^file:\/\//, "");
    for (const r of roots) if (s.startsWith(r)) s = s.slice(r.length);
    return s;
  };
  const tests: FailedCheck["tests"] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]!);
    if (!m) continue;
    let file: string | null = null;
    let line: number | null = null;
    let message = "";
    const values: { expected?: string; actual?: string } = {};
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
      const l = lines[j]!;
      if (/^\s*(not )?ok \d+ - /.test(l) || /^\s*\.\.\.\s*$/.test(l)) break;
      const loc = /^\s*location:\s*'(.+):(\d+):\d+'\s*$/.exec(l);
      if (loc && !file) (file = rel(loc[1]!)), (line = Number(loc[2]));
      const err = /^\s*error:\s*'?(.*?)'?\s*$/.exec(l);
      if (err && !message) message = err[1] === "|-" ? (lines[j + 1] ?? "").trim() : err[1]!;
      const val = /^\s*(expected|actual):\s*(\S.*)$/.exec(l);
      if (val && val[2] !== "|-") values[val[1] as "expected" | "actual"] = val[2]!;
    }
    // An assertion's own values say more than its generic message ("Expected values to be strictly equal").
    if (values.expected && values.actual) message = `expected ${values.expected}, got ${values.actual}`;
    // The same failure reported twice (e.g. by a nested runner) is listed once; same-named tests in other files are kept.
    if (tests.some((t) => t.name === m[1]!.trim() && t.file === file)) continue;
    tests.push({ name: m[1]!.trim(), file, line, message });
  }
  const excerpt = lines.filter((l) => /not ok|Error|error|expected|actual|ERR_/.test(l)).slice(0, 12).join("\n").slice(0, 1500);
  return { command, tests, excerpt };
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function projectFiles(cwd: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n")
    .filter((f) => f && !f.startsWith(".relay/"));
}

const mentions = (text: string, word: string) => new RegExp(`(^|[^A-Za-z0-9_$])${word.replace(/[$]/g, "\\$")}([^A-Za-z0-9_$]|$)`).test(text);

export function explainIntegration(input: ExplainInput): Explanation | null {
  const failed = input.results.filter((r) => r.exitCode !== 0);
  if (!failed.length) return null;
  const failures = failed.map((r) => parseFailures(r.command, r.output, input.cwd));
  const base = { tree: input.tree, base: input.base, failures, causes: [] as ExplanationCause[], uncertain: [] as string[] };

  if (!input.base) {
    return { ...base, verdict: "unknown", summary: "Relay can't explain this failure: the tasks share no base revision to compare against.", uncertain: ["no common base revision"], resolve: "Read the failing output below." };
  }

  const files = projectFiles(input.cwd);
  const graph = new DependencyGraph(input.cwd);
  graph.refresh(files);
  const changed = changedFiles(input.cwd, input.base).filter((f) => !f.startsWith(".relay/"));
  const impact = graph.impact(input.base, changed, (p) => showAt(input.cwd, input.base!, p));

  // Who made a change: the run's own diff when known (observed), otherwise the task's declared scope.
  const changers = (file: string) => {
    const observed = input.tasks.filter((t) => input.changedBy?.[t.id]?.includes(file)).map((t) => t.id);
    if (observed.length) return { tasks: observed, how: "changed by its run" as const };
    return { tasks: input.tasks.filter((t) => inScope(t.scope, file)).map((t) => t.id), how: "in its declared scope" as const };
  };
  const owners = (file: string) => input.tasks.filter((t) => inScope(t.scope, file)).map((t) => t.id);

  // Which files each failure points at: test locations, else project files named literally in the output.
  const pointsAt = failures.map((f, i) => {
    const located = f.tests.map((t) => t.file).filter((x): x is string => !!x);
    if (located.length) return new Set(located);
    const out = failed[i]!.output;
    return new Set(files.filter((p) => out.includes(p)));
  });

  interface Candidate {
    iface: InterfaceChange;
    consumer: Consumer;
    brk: Consumer["breaks"][number] | null;
    reach: Set<string>;
  }
  const candidates: Candidate[] = [];
  for (const c of impact.consumers) {
    const iface = impact.interfaces.find((i) => i.symbol === c.symbol && i.change !== "added" && (c.breaks.length ? c.breaks.some((b) => i.removedKeys.includes(b.prop)) : true));
    if (!iface) continue;
    const reach = new Set([c.file, ...graph.testsReaching([c.file]).map((t) => t.file)]);
    if (c.breaks.length) for (const b of c.breaks) candidates.push({ iface, consumer: c, brk: b, reach });
    else if (iface.change !== "implementation") candidates.push({ iface, consumer: c, brk: null, reach });
  }

  // Link failures to candidates through the files they point at.
  const linked = new Map<Candidate, { check: number; test: string | null; file: string }[]>();
  const failureLinks: { check: number; test: string | null; file: string | null; candidates: Candidate[] }[] = [];
  failures.forEach((f, i) => {
    const units = f.tests.length ? f.tests.map((t) => ({ test: t.name as string | null, files: t.file ? [t.file] : [] })) : [{ test: null, files: [...pointsAt[i]!] }];
    for (const u of units) {
      const hits = candidates.filter((c) => u.files.some((p) => c.reach.has(p)));
      failureLinks.push({ check: i, test: u.test, file: u.files[0] ?? null, candidates: hits });
      for (const c of hits) {
        const l = linked.get(c) ?? [];
        l.push({ check: i, test: u.test, file: u.files.find((p) => c.reach.has(p))! });
        linked.set(c, l);
      }
    }
  });

  const causes: ExplanationCause[] = [];
  const uncertain: string[] = [];
  for (const c of candidates) {
    const links = linked.get(c) ?? [];
    const breaks = c.brk !== null;
    if (!links.length && !breaks) continue; // an interface change with consumers but no link to any failure: noise
    const sole = links.some((l) => failureLinks.find((f) => f.check === l.check && f.test === l.test)!.candidates.filter((x) => x.brk).length === 1);
    const confidence: ExplanationCause["confidence"] = breaks && links.length && sole ? "confirmed" : "likely";
    const provider = changers(c.iface.file);
    const consumerOwners = owners(c.consumer.file);
    const why: string[] = [];
    if (!breaks) why.push(`${c.consumer.file} uses ${c.iface.symbol}, which changed (${c.iface.change}), but Relay found no specific read that the change breaks`);
    if (!links.length) why.push(`no failing test or check could be traced to ${c.consumer.file}`);
    else if (!sole && breaks) why.push(`the failing test also reaches another candidate break, so Relay can't tell which one failed it`);
    if (!provider.tasks.length) why.push(`no task in this check owns ${c.iface.file}`);

    // Contract evidence: only an accepted contract that every involved task is on counts as current.
    const involved = [...new Set([...provider.tasks, ...consumerOwners])];
    const shared = [...new Set(input.tasks.filter((t) => involved.includes(t.id)).flatMap((t) => Object.keys(t.contracts)))].filter((cid) => involved.every((id) => cid in input.tasks.find((t) => t.id === id)!.contracts));
    const contracts: ExplanationCause["contracts"] = shared.map((cid) => {
      const cur = input.currentContract(cid);
      const behind = involved.filter((id) => input.tasks.find((t) => t.id === id)!.contracts[cid] !== cur?.version);
      if (!cur) return { id: cid, version: null, status: "missing" as const, detail: `contract ${cid} has no accepted version, so it is not used as evidence` };
      if (behind.length) return { id: cid, version: cur.version, status: "stale" as const, detail: `${behind.join(", ")} built against an older version of ${cid} than the current v${cur.version}; the contract is not used as evidence` };
      const def = cur.definition;
      const names = mentions(def, c.iface.symbol);
      const removedOut = c.iface.removedKeys.filter((k) => !mentions(def, k));
      const addedIn = c.iface.addedKeys.filter((k) => mentions(def, k));
      const detail = names
        ? `contract ${cid} v${cur.version} (shared by ${involved.join(", ")}) defines ${c.iface.symbol}: "${def}"${removedOut.length ? `; it does not include ${removedOut.map((k) => `\`${k}\``).join(", ")}` : ""}${addedIn.length ? `; it includes ${addedIn.map((k) => `\`${k}\``).join(", ")}` : ""}`
        : `contract ${cid} v${cur.version} is shared by ${involved.join(", ")}, but its definition doesn't name ${c.iface.symbol}, so it doesn't establish this link`;
      return { id: cid, version: cur.version, status: names ? ("current" as const) : ("unrelated" as const), detail };
    });
    for (const k of contracts.filter((x) => x.status === "stale" || x.status === "missing")) why.push(k.detail);

    const evidence = [
      `${c.iface.file}${c.iface.line ? `:${c.iface.line}` : ""}: ${c.iface.symbol} ${c.iface.change === "shape" ? `${c.iface.before} → ${c.iface.after}` : c.iface.change} (base ${input.base.slice(0, 10)} → combined tree)`,
      `${c.iface.file} ${provider.how === "changed by its run" ? "changed by" : "in the scope of"} ${provider.tasks.join(", ") || "no task in this check"}`,
      c.consumer.evidence.detail,
      ...(c.brk ? [`${c.consumer.file}:${c.brk.line} ${c.brk.reason}`] : []),
      ...links.map((l) => `${failures[l.check]!.command}: ${l.test ? `not ok "${l.test}"` : "failed"}${l.file ? ` (${l.file}${l.file === c.consumer.file ? "" : `, which reaches ${c.consumer.file} through imports`})` : ""}`),
      ...contracts.filter((x) => x.status === "current").map((x) => x.detail),
    ];
    causes.push({
      confidence,
      provider: { tasks: provider.tasks, how: provider.how, file: c.iface.file, symbol: c.iface.symbol, line: c.iface.line, change: c.iface.change, removedKeys: c.iface.removedKeys, addedKeys: c.iface.addedKeys },
      consumer: { tasks: consumerOwners, file: c.consumer.file, line: c.brk?.line ?? c.consumer.line, read: c.brk?.prop ?? null },
      contracts,
      failing: links.map((l) => ({ command: failures[l.check]!.command, test: l.test, file: l.file })),
      evidence,
      uncertain: why,
    });
  }

  for (const f of failureLinks) if (!f.candidates.length) uncertain.push(`${failures[f.check]!.command}: ${f.test ? `"${f.test}"` : "the failure"}${f.file ? ` (${f.file})` : ""} is not linked to any change Relay can trace`);
  const confirmed = causes.filter((c) => c.confidence === "confirmed");
  const allExplained = failureLinks.every((f) => f.candidates.some((c) => confirmed.some((x) => x.consumer.file === c.consumer.file && x.provider.file === c.iface.file && x.consumer.read === (c.brk?.prop ?? null))));
  const verdict: Explanation["verdict"] = !causes.length ? "unknown" : confirmed.length && allExplained ? "confirmed" : "likely";
  if (verdict === "likely" && confirmed.length) uncertain.push("not every failure is explained by a confirmed cause");
  if (causes.length > 1 && verdict !== "confirmed") uncertain.push(`${causes.length} possible causes; Relay does not choose between them`);

  const describe = (c: ExplanationCause) => {
    const who = (ids: string[]) => (ids.length ? ids.join(" and ") : "code outside this check");
    const shape = c.provider.removedKeys.length ? ` so it no longer returns \`${c.provider.removedKeys.join("`, `")}\`${c.provider.addedKeys.length ? ` (it now returns \`${c.provider.addedKeys.join("`, `")}\`)` : ""}` : ` (${c.provider.change})`;
    const contract = c.contracts.find((k) => k.status === "current");
    const read = c.consumer.read ? `still reads \`${c.consumer.read}\` from ${c.provider.symbol}() at ${c.consumer.file}:${c.consumer.line}` : `uses ${c.provider.symbol} at ${c.consumer.file}:${c.consumer.line}`;
    const fail = c.failing[0];
    return `${who(c.provider.tasks)} changed ${c.provider.symbol} in ${c.provider.file}${contract ? ` (part of contract ${contract.id} v${contract.version})` : ""}${shape}. ${who(c.consumer.tasks)} ${read}.${fail ? ` The combined verification failed on it: \`${fail.command}\`${fail.test ? `, "${fail.test}"` : ""}${fail.file ? ` (${fail.file})` : ""}.` : ""}`;
  };
  const head = verdict === "confirmed" ? "Confirmed cause" : verdict === "likely" ? "Likely cause (not confirmed)" : "Cause unknown";
  const summary =
    verdict === "unknown"
      ? `Cause unknown. Relay blocked integration because combined verification failed (${failures.map((f) => `\`${f.command}\``).join(", ")}), but none of the changes it can trace explains the failure.`
      : `${head}: ${(verdict === "confirmed" ? confirmed : causes).map(describe).join(" ")} Relay blocked integration because combined verification failed.`;
  const resolve =
    verdict === "unknown"
      ? "Read the failing output, find which change breaks it, fix that task and check together again."
      : `${[...new Set((verdict === "confirmed" ? confirmed : causes).flatMap((c) => [...c.provider.tasks, ...c.consumer.tasks]))].join(" and ") || "The changes"} must be made compatible: either the consumer moves to the new interface or the interface keeps what the consumer reads. Relay does not choose; the task owners decide, then check together again.`;
  return { ...base, verdict, summary, causes, uncertain: [...new Set(uncertain)], resolve };
}

/**
 * The text every client shows for a rehearsal: CLI, VS Code and logs print exactly this, so they can't disagree about
 * what was checked or why it was blocked. The verification result comes first; the explanation never replaces it.
 */
export function integrationReport(integ: Integration): string {
  const head = integ.status === "passed" ? "PASSED" : integ.status === "approved" ? "APPROVED" : "BLOCKED";
  const out = [
    `${head}  ${integ.tasks.join(" + ")}  (integration ${integ.id})`,
    `Checked: base ${integ.baseCommit?.slice(0, 10) ?? "unknown"}, combined tree ${integ.tree.slice(0, 10)}${Object.keys(integ.contracts).length ? `, contracts ${Object.entries(integ.contracts).map(([c, v]) => `${c} v${v}`).join(", ")}` : ""}`,
    "",
    "Combined verification:",
    ...(integ.results.length ? integ.results.map((r) => `  ${r.exitCode === 0 ? "pass" : "FAIL"}  ${r.command}${r.exitCode === 0 ? "" : ` (exit ${r.exitCode ?? "timeout"})`}`) : ["  (nothing ran)"]),
  ];
  const failing = integ.explanation?.failures.flatMap((f) => f.tests.map((t) => `  not ok  "${t.name}"${t.file ? ` (${t.file}${t.line ? `:${t.line}` : ""})` : ""}${t.message ? `: ${t.message}` : ""}`)) ?? [];
  if (failing.length) out.push("", "Failing tests:", ...failing);
  else for (const r of integ.results.filter((x) => x.exitCode !== 0)) out.push("", `Output of ${r.command}:`, ...r.output.split("\n").filter((l) => l.trim()).slice(-12).map((l) => `  ${l}`));
  if (integ.status === "blocked") out.push("", "Why Relay blocked it:", ...integ.gaps.map((g) => `  - ${g}`));
  const x = integ.explanation;
  if (x) {
    out.push("", `Cause (${x.verdict}): ${x.summary}`);
    x.causes.forEach((c, i) => {
      out.push("", `Evidence${x.causes.length > 1 ? ` for cause ${i + 1}` : ""} (${c.confidence}):`, ...c.evidence.map((e) => `  - ${e}`));
      if (c.uncertain.length) out.push("  Not established:", ...c.uncertain.map((u) => `  - ${u}`));
    });
    if (x.uncertain.length) out.push("", "Uncertain:", ...x.uncertain.map((u) => `  - ${u}`));
    out.push("", `To resolve: ${x.resolve}`);
  }
  if (integ.status === "passed") out.push("", "Nothing has been applied. A project owner must approve this integration to apply it; if the project changes first, Relay requires a new check.");
  if (integ.status === "blocked") out.push("", "Nothing was applied: a blocked check never changes the shared project.");
  return out.join("\n");
}
