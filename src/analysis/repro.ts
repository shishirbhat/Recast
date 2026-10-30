import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsync } from "../core/engine.ts";
import type { Relay } from "../core/engine.ts";
import { RelayError } from "../core/types.ts";
import { sanitize } from "../knowledge/sanitize.ts";
import { parseFailures } from "./explain.ts";

/**
 * Reproduction from failure evidence. Every check Relay runs records the git tree it ran on (`write-tree` stores that
 * tree in the repository's object database), so a failure can be rebuilt from exactly the files it saw, in a fresh
 * directory, without touching anyone's checkout, and its command run again.
 *
 * Honest about what that proves: the same exit status and failing tests means "reproduced"; a pass means "did not
 * reproduce" (flaky, or it depends on something outside the files: time, network, machine state); a failure with
 * different tests is reported as such. Files git doesn't hold (installed dependencies) aren't in the tree; the
 * project's own `node_modules` is linked in when it exists, and that is said.
 */

export type ReproTarget = { kind: "evidence"; id: string } | { kind: "integration"; id: string; command: string };
export type ReproOutcome = "reproduced" | "different-failure" | "did-not-reproduce";

export interface ReproAttempt {
  at: string;
  by: string;
  exitCode: number | null;
  outcome: ReproOutcome;
  failingTests: string[];
  excerpt: string;
}

export interface ReproBundle {
  target: ReproTarget;
  tasks: string[];
  command: string;
  exitCode: number | null;
  recordedAt: string;
  /** The exact files the failure ran on, as a git tree hash. */
  tree: string | null;
  /** Whether that tree can be rebuilt from this repository right now, and if not, why. */
  rebuildable: { ok: boolean; reason: string | null };
  failingTests: { name: string; file: string | null; line: number | null; message: string }[];
  excerpt: string;
  /** Commands that rebuild the files and rerun the check, from a clone of this repository. */
  script: string;
  attempts: ReproAttempt[];
  reproducibility: "not-attempted" | ReproOutcome;
  limits: string[];
}

const keyOf = (t: ReproTarget) => (t.kind === "evidence" ? `evidence:${t.id}` : `integration:${t.id}:${t.command}`);

function treeExists(root: string, tree: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${tree}^{tree}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveTarget(relay: Relay, t: ReproTarget): { tasks: string[]; command: string; exitCode: number | null; output: string; tree: string | null; cwd: string; at: string } {
  if (t.kind === "evidence") {
    const r = relay.db.prepare("SELECT task_id, kind, command, exit_code, output, environment, created_at FROM evidence WHERE id = ?").get(t.id) as { task_id: string; kind: string; command: string | null; exit_code: number | null; output: string; environment: string; created_at: string } | undefined;
    if (!r) throw new RelayError("not_found", `No evidence ${t.id}`);
    if (r.kind !== "command" || !r.command) throw new RelayError("invalid", "Only a command Relay ran can be reproduced");
    const env = JSON.parse(r.environment) as Record<string, string>;
    return { tasks: [r.task_id], command: r.command, exitCode: r.exit_code, output: r.output, tree: env.tree ?? null, cwd: env.cwd ?? "", at: r.created_at };
  }
  const integ = relay.getIntegration(t.id);
  if (!integ) throw new RelayError("not_found", `No integration ${t.id}`);
  const res = integ.results.find((r) => r.command === t.command);
  if (!res) throw new RelayError("not_found", `The check of ${integ.tasks.join(" + ")} didn't run ${t.command}`);
  return { tasks: integ.tasks, command: res.command, exitCode: res.exitCode, output: res.output, tree: integ.tree, cwd: "", at: integ.createdAt };
}

function attempts(relay: Relay, target: ReproTarget): ReproAttempt[] {
  const key = keyOf(target);
  return (relay.db.prepare("SELECT actor, at, data FROM events WHERE type = 'repro.attempted' ORDER BY seq").all() as { actor: string; at: string; data: string }[])
    .map((e) => ({ e, d: JSON.parse(e.data) as { target: string; exitCode: number | null; outcome: ReproOutcome; failingTests: string[]; excerpt: string } }))
    .filter(({ d }) => d.target === key)
    .map(({ e, d }) => ({ at: e.at, by: e.actor, exitCode: d.exitCode, outcome: d.outcome, failingTests: d.failingTests, excerpt: d.excerpt }));
}

export function reproBundle(relay: Relay, root: string, target: ReproTarget): ReproBundle {
  const f = resolveTarget(relay, target);
  if (f.exitCode === 0) throw new RelayError("invalid", `${f.command} passed; there's no failure to reproduce`);
  const changedDuring = f.tree?.startsWith("changed-during-run:");
  const tree = f.tree && !changedDuring ? f.tree : null;
  const rebuildable = !tree
    ? { ok: false, reason: changedDuring ? "The files changed while the check ran, so no single version of them produced this failure." : "No file tree was recorded for this check." }
    : treeExists(root, tree)
      ? { ok: true, reason: null }
      : { ok: false, reason: "The recorded tree is no longer in this repository (git may have pruned it)." };
  const failed = parseFailures(f.command, f.output, f.cwd || root);
  const tail = sanitize(f.output.slice(-4000), root).text;
  const tries = attempts(relay, target);
  return {
    target,
    tasks: f.tasks,
    command: f.command,
    exitCode: f.exitCode,
    recordedAt: f.at,
    tree,
    rebuildable,
    failingTests: failed.tests,
    excerpt: tail,
    script: tree
      ? [`# Rebuild exactly the files the failure ran on (tree ${tree}) and run the check again.`, `dir=$(mktemp -d)`, `GIT_INDEX_FILE="$dir/.relay-index" git read-tree ${tree}`, `GIT_INDEX_FILE="$dir/.relay-index" git --work-tree="$dir" checkout-index -a`, `rm "$dir/.relay-index"`, `[ -d node_modules ] && ln -s "$PWD/node_modules" "$dir/node_modules"`, `(cd "$dir" && ${f.command})`].join("\n")
      : "# The failure can't be rebuilt from a recorded tree; see rebuildable.reason.",
    attempts: tries,
    reproducibility: tries.at(-1)?.outcome ?? "not-attempted",
    limits: ["Only files git tracks or sees are rebuilt; installed dependencies come from the project's node_modules if present.", "Time, network, environment variables and machine state aren't recorded; a failure that depends on them may not reproduce."],
  };
}

/** Rebuild the failure's files in a temporary directory, run the command again, record and return the outcome. */
export async function reproduce(relay: Relay, root: string, target: ReproTarget, by: string, timeoutMs = 300_000): Promise<ReproAttempt> {
  const b = reproBundle(relay, root, target);
  if (!b.rebuildable.ok || !b.tree) throw new RelayError("stale_state", `Can't rebuild this failure: ${b.rebuildable.reason}`);
  const dir = mkdtempSync(join(tmpdir(), "relay-repro-"));
  const index = join(mkdtempSync(join(tmpdir(), "relay-repro-idx-")), "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync("git", ["read-tree", b.tree], { cwd: root, env, stdio: "ignore" });
    execFileSync("git", [`--work-tree=${dir}`, "checkout-index", "-a"], { cwd: root, env, stdio: "ignore" });
    if (existsSync(join(root, "node_modules")) && !existsSync(join(dir, "node_modules"))) symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
    const r = await runAsync(b.command, dir, timeoutMs);
    const now = parseFailures(b.command, r.output, dir).tests.map((t) => t.name);
    const before = b.failingTests.map((t) => t.name);
    const outcome: ReproOutcome = r.exitCode === 0 ? "did-not-reproduce" : before.length && now.length && !before.some((n) => now.includes(n)) ? "different-failure" : "reproduced";
    const attempt: ReproAttempt = { at: new Date().toISOString(), by, exitCode: r.exitCode, outcome, failingTests: now, excerpt: sanitize(r.output.slice(-2000), dir).text };
    relay.record("repro.attempted", by, { target: keyOf(target), tree: b.tree, command: b.command, exitCode: r.exitCode, outcome, failingTests: now, excerpt: attempt.excerpt }, b.tasks.length === 1 ? b.tasks[0] : undefined);
    return attempt;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(index, ".."), { recursive: true, force: true });
  }
}

export function reproText(b: ReproBundle): string {
  return [
    `Failure: ${b.command} (exit ${b.exitCode ?? "timeout"}) for ${b.tasks.join(" + ")}, recorded ${b.recordedAt}`,
    `Files: ${b.tree ? `tree ${b.tree}` : "not recorded"} · ${b.rebuildable.ok ? "can be rebuilt here" : `can't be rebuilt: ${b.rebuildable.reason}`}`,
    `Reproducibility: ${b.reproducibility === "not-attempted" ? "not attempted yet" : b.reproducibility.replace(/-/g, " ")}${b.attempts.length ? ` (${b.attempts.length} attempt${b.attempts.length === 1 ? "" : "s"}, latest ${b.attempts.at(-1)!.at})` : ""}`,
    ...(b.failingTests.length ? ["Failing tests:", ...b.failingTests.map((t) => `  ${t.name}${t.file ? ` (${t.file}${t.line ? `:${t.line}` : ""})` : ""}${t.message ? `: ${t.message}` : ""}`)] : []),
    "",
    "To reproduce from a clone of this repository:",
    b.script,
    "",
    ...b.limits.map((l) => `Note: ${l}`),
  ].join("\n");
}
