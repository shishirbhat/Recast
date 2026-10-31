/**
 * Summarise evaluation results. Every number comes from trials in the results files given; nothing is estimated.
 * Simulated and real-agent results are never added together: each agent gets its own section.
 *
 *   node eval/report.ts eval/results/<run>/results.json [more results.json ...] [--md out.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

interface Workflow {
  outcome: string;
  decision?: string;
  truth?: string;
  rehearsal?: string;
  why?: string;
  seconds?: number;
  costUsd?: number | null;
  brokenIntoProject?: boolean;
  unchangedAfterReject?: boolean | null;
  staleRefused?: boolean | null;
  appliedMatchesTruth?: boolean | null;
  explanation?: { verdict: string } | null;
  explanationCitesRealFailures?: boolean | null;
  assurance?: { level: string; gaps: string[] } | null;
  error?: string | null;
  tasks?: { id: string; agent: { ok: boolean; costUsd: number | null; seconds: number | null; tokens: { input: number; output: number; cacheRead: number; cacheCreation: number } | null; model: string | null; error: string | null }; ownCheck: boolean | null; outOfScope: string[]; guardDenials?: number }[];
}
interface Trial {
  scenario: string;
  version: number;
  designed: string;
  trial: number;
  baseline: Workflow;
  relay: Workflow;
}
interface Results {
  format: string;
  agent: { kind: string; real: boolean; version: string; baselineConfig: string; relayConfig: string };
  relayCommit: string;
  startedAt: string;
  trials: Trial[];
}

const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--md");
const mdOut = process.argv.includes("--md") ? process.argv[process.argv.indexOf("--md") + 1] : null;
const runs = files.map((f) => ({ file: f, r: JSON.parse(readFileSync(f, "utf8")) as Results }));
const byAgent = new Map<string, { file: string; r: Results }[]>();
for (const x of runs) byAgent.set(`${x.r.agent.real ? "REAL" : "SIMULATED"}: ${x.r.agent.version}`, [...(byAgent.get(`${x.r.agent.real ? "REAL" : "SIMULATED"}: ${x.r.agent.version}`) ?? []), x]);

const OUTCOMES = ["correct-block", "correct-pass", "correct-conflict", "missed-break", "false-block", "missed-conflict", "inconclusive-was-broken", "inconclusive-was-fine", "not-compared"];
const row = (...c: (string | number)[]) => `| ${c.join(" | ")} |`;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
const money = (x: number | null) => (x === null ? "not reported" : `$${x.toFixed(2)}`);
const tasksCost = (w: Workflow) => (w.tasks ?? []).map((t) => t.agent.costUsd);
const sumKnown = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number").reduce((a, b) => a + b, 0);

const lines: string[] = ["# Relay evaluation results", "", `Generated ${new Date().toISOString()} by \`node eval/report.ts\` from ${runs.length} results file(s). Every figure below is counted from the trials listed; nothing is estimated or extrapolated. Simulated and real-agent results are reported separately and never combined.`, ""];
for (const [agent, group] of byAgent) {
  const trials = group.flatMap((g) => g.r.trials.map((t) => ({ ...t, file: g.file })));
  const real = group[0]!.r.agent.real;
  lines.push(`## ${agent}`, "", real ? "Real agent runs. Agents vary from run to run; each trial is one sample." : "**Simulated agent** (scripted, deterministic edits). These results check that the harness and Relay's logic behave as designed; they say nothing about how real agents behave.", "");
  lines.push(`Sample: ${trials.length} trial(s) over ${new Set(trials.map((t) => t.scenario)).size} scenario(s); runs from ${group.map((g) => g.r.startedAt.slice(0, 16)).join(", ")}; Relay commit ${[...new Set(group.map((g) => g.r.relayCommit.slice(0, 10) + ((g.r as { relayDirty?: boolean }).relayDirty ? " plus uncommitted changes" : "")))].join(", ")}.`, "");
  lines.push(`Baseline: ${group[0]!.r.agent.baselineConfig}. Relay: ${group[0]!.r.agent.relayConfig}.`, "");
  lines.push("### Outcomes against ground truth (hidden oracle tests on each workflow's own combined patches)", "", row("Outcome", "Baseline", "Relay"), row("---", "---", "---"));
  for (const o of OUTCOMES) {
    const b = trials.filter((t) => t.baseline?.outcome === o).length;
    const r = trials.filter((t) => t.relay?.outcome === o).length;
    if (b || r) lines.push(row(o, b, r));
  }
  const compared = (w: "baseline" | "relay") => trials.filter((t) => t[w]?.outcome && t[w].outcome !== "not-compared");
  const broken = (w: "baseline" | "relay") => trials.filter((t) => t[w]?.brokenIntoProject).length;
  lines.push(
    "",
    row("Measure", "Baseline", "Relay"),
    row("---", "---", "---"),
    row("Trials compared (agents finished, no harness error)", compared("baseline").length, compared("relay").length),
    row("Broken combinations that reached the project", broken("baseline"), broken("relay")),
    row("Working combinations stopped (false blocks)", trials.filter((t) => t.baseline?.outcome === "false-block").length, trials.filter((t) => t.relay?.outcome === "false-block").length),
    row("Inconclusive (Relay passed with named coverage gaps)", "n/a", trials.filter((t) => t.relay?.outcome?.startsWith("inconclusive")).length),
    row("Project unchanged after a rejected integration", "n/a", `${trials.filter((t) => t.relay?.unchangedAfterReject === true).length} of ${trials.filter((t) => t.relay?.unchangedAfterReject !== null && t.relay?.unchangedAfterReject !== undefined).length}`),
    row("Approval refused after the project moved (evidence went stale)", "n/a", `${trials.filter((t) => t.relay?.staleRefused === true).length} of ${trials.filter((t) => t.relay?.staleRefused !== null && t.relay?.staleRefused !== undefined).length}`),
    row("Applied project matches ground truth", "n/a", `${trials.filter((t) => t.relay?.appliedMatchesTruth === true).length} of ${trials.filter((t) => t.relay?.appliedMatchesTruth !== null && t.relay?.appliedMatchesTruth !== undefined).length}`),
    row("Blocks with an explanation citing tests that really failed", "n/a", `${trials.filter((t) => t.relay?.explanationCitesRealFailures === true).length} of ${trials.filter((t) => t.relay?.rehearsal === "blocked").length}`),
    row("Agent sessions that failed or errored", trials.flatMap((t) => t.baseline?.tasks ?? []).filter((x) => !x.agent.ok).length, trials.flatMap((t) => t.relay?.tasks ?? []).filter((x) => !x.agent.ok).length),
    row("Agent cost (sum of reported)", money(real ? sumKnown(trials.flatMap((t) => tasksCost(t.baseline))) : 0), money(real ? sumKnown(trials.flatMap((t) => tasksCost(t.relay))) : 0)),
    row("Agent sessions with no cost reported", trials.flatMap((t) => tasksCost(t.baseline)).filter((x) => x === null).length, trials.flatMap((t) => tasksCost(t.relay)).filter((x) => x === null).length),
    row("Median workflow time (s)", median(trials.map((t) => t.baseline?.seconds).filter((x): x is number => typeof x === "number")) ?? "—", median(trials.map((t) => t.relay?.seconds).filter((x): x is number => typeof x === "number")) ?? "—"),
    "",
    "Explanation verdicts on blocks: " + (["confirmed", "likely", "unknown"].map((v) => `${v} ${trials.filter((t) => t.relay?.explanation?.verdict === v).length}`).join(", ")) + ".",
    "",
    "### Every trial",
    "",
    row("Scenario (version)", "Trial", "Designed", "Baseline: truth / decision / outcome", "Relay: truth / result / outcome", "Relay note", "Raw"),
    row("---", "---", "---", "---", "---", "---", "---"),
    ...trials.map((t) =>
      row(
        `${t.scenario} (v${t.version})`,
        t.trial,
        t.designed,
        `${t.baseline?.truth ?? "—"} / ${t.baseline?.decision ?? "error"} / **${t.baseline?.outcome}**`,
        `${t.relay?.truth ?? "—"} / ${t.relay?.rehearsal ?? "error"}${t.relay?.assurance ? ` (${t.relay.assurance.level})` : ""} / **${t.relay?.outcome}**`,
        (t.relay?.error ?? t.relay?.assurance?.gaps?.[0] ?? (t.relay?.explanation ? `cause ${t.relay.explanation.verdict}` : "")).replace(/\|/g, "/").slice(0, 140),
        `\`${relative(process.cwd(), t.file).replace(/results\.json$/, "")}${t.scenario}/trial-${t.trial}/\``,
      ),
    ),
    "",
  );
}
lines.push("## How to read this", "", "- Ground truth is each workflow's own two patches combined on the base and run against the scenario's hidden oracle tests (`eval/scenarios.ts`). Because real agents differ between workflows, each workflow has its own ground truth per trial.", "- *Inconclusive* means Relay's checks passed but it named gaps (changed code no test reaches, interactions it can't follow). It is counted separately, never as a pass or a block.", "- *Not compared* means an agent didn't finish or the harness failed; such trials are listed, not dropped.", "- These are small samples. No rate here is a statistically significant estimate of real-world behaviour.", "");
const md = lines.join("\n");
if (mdOut) writeFileSync(mdOut, md);
console.log(md);
