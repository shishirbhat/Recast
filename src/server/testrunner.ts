import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { verificationEnv } from "../core/engine.ts";
import { RelayError } from "../core/types.ts";
import { isTestFile } from "../analysis/depgraph.ts";

/**
 * The integrated test runner. It runs the project's real tests on the Relay machine:
 * - Node's built-in runner (`node --test`) with Relay's JSON reporter, read per test with Node's own source locations, when the
 *   project uses it (a `test` script that calls `node --test`, or test files and no other test script);
 * - otherwise the project's own `npm test`, reported by exit code and output only (no per-test parsing claimed).
 * Every run records its command and the exact workspace revision, so later results can be marked stale.
 */

export interface TestResult {
  name: string;
  file: string | null;
  line: number | null;
  status: "pass" | "fail" | "skip" | "todo";
  durationMs: number | null;
  error: string | null;
}

export interface TestRun {
  id: string;
  command: string;
  runner: "node-test" | "npm-script";
  files: string[];
  revision: string;
  status: "running" | "passed" | "failed" | "stopped" | "error";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  startedBy: string;
  results: TestResult[];
  output: string;
}

const OUTPUT_LIMIT = 400_000;

const REPORTER = fileURLToPath(new URL("./reporters/relay-reporter.mjs", import.meta.url));

/**
 * Per-test results from Relay's reporter (JSON lines carrying Node's own file/line). Suites are dropped: their
 * children carry the real results. Any other output (a test's console logs) is left in the raw output.
 */
export function parseReport(output: string, root: string): TestResult[] {
  const out: TestResult[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith('{"relay":1')) continue;
    try {
      const r = JSON.parse(line) as { name: string; file: string | null; line: number | null; type: string; status: TestResult["status"]; durationMs: number | null; error: string | null };
      if (r.type === "suite") continue;
      const file = r.file ? relative(root, r.file.replace(/^file:\/\//, "")).split("\\").join("/") : null;
      // Node reports a whole file as one entry when none of its tests were reported (e.g. a name filter matched
      // nothing there). A failure there is real (the file didn't load); a "pass" means nothing ran, so it isn't counted.
      if (file && r.name === file && r.status === "pass") continue;
      out.push({ name: r.name, file: file && !file.startsWith("..") ? file : null, line: r.line, status: r.status, durationMs: r.durationMs, error: r.error });
    } catch {}
  }
  return out;
}

export class TestRunner {
  private db: DatabaseSync;
  private root: string;
  private current: { run: TestRun; proc: ChildProcess } | null = null;
  private fingerprint: () => string;
  onChange: (() => void) | null = null;

  constructor(db: DatabaseSync, root: string, fingerprint: () => string) {
    this.db = db;
    this.root = root;
    this.fingerprint = fingerprint;
    db.exec(`CREATE TABLE IF NOT EXISTS test_runs (
      id TEXT PRIMARY KEY, command TEXT NOT NULL, runner TEXT NOT NULL, files TEXT NOT NULL, revision TEXT NOT NULL,
      status TEXT NOT NULL, exit_code INTEGER, started_at TEXT NOT NULL, ended_at TEXT, started_by TEXT NOT NULL,
      results TEXT NOT NULL, output TEXT NOT NULL
    )`);
  }

  /** What would run, and how results can be read. */
  discover(files: string[]): { runner: "node-test" | "npm-script" | null; command: string | null; testFiles: string[]; perTest: boolean; reason?: string } {
    let script: string | undefined;
    try {
      script = (JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.test;
    } catch {}
    const testFiles = files.filter((f) => isTestFile(f) && /\.(m|c)?(j|t)s$/.test(f));
    if ((script && /\bnode\s+(--[\w-]+\s+)*--test\b/.test(script)) || (!script && testFiles.length)) return { runner: "node-test", command: "node --test", testFiles, perTest: true };
    if (script && !/no test specified/.test(script)) return { runner: "npm-script", command: "npm test", testFiles, perTest: false, reason: `"${script}" isn't Node's test runner; results come from its exit code and output.` };
    return { runner: null, command: null, testFiles, perTest: false, reason: "No tests found: no test script in package.json and no *.test.* files." };
  }

  running(): TestRun | null {
    return this.current?.run ?? null;
  }

  start(opts: { files?: string[]; names?: string[]; by: string; projectFiles: string[] }): TestRun {
    if (this.current) throw new RelayError("conflict", "Tests are already running; stop them first");
    const d = this.discover(opts.projectFiles);
    if (!d.runner) throw new RelayError("invalid", d.reason!);
    const files = (opts.files ?? []).filter((f) => d.testFiles.includes(f));
    let cmd: string;
    let args: string[];
    if (d.runner === "node-test") {
      cmd = process.execPath;
      args = ["--test", `--test-reporter=${REPORTER}`, ...(opts.names?.length ? [`--test-name-pattern=^(${opts.names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`] : []), ...(files.length ? files : d.testFiles)];
    } else {
      cmd = "npm";
      args = ["test", "--silent"];
    }
    const run: TestRun = {
      id: randomUUID(),
      command: d.runner === "node-test" ? `node --test ${args.filter((a) => !a.startsWith("--test")).join(" ")}` : "npm test",
      runner: d.runner,
      files: files.length ? files : d.testFiles,
      revision: this.fingerprint(),
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      startedBy: opts.by,
      results: [],
      output: "",
    };
    const proc = spawn(cmd, args, { cwd: this.root, env: verificationEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.current = { run, proc };
    const take = (c: Buffer) => {
      run.output = (run.output + c.toString("utf8")).slice(-OUTPUT_LIMIT);
      if (run.runner === "node-test") run.results = parseReport(run.output, this.root);
      this.onChange?.();
    };
    proc.stdout!.on("data", take);
    proc.stderr!.on("data", take);
    proc.on("error", (e) => {
      run.output += `\n[relay] could not start ${cmd}: ${e.message}`;
      run.status = "error";
    });
    proc.on("close", (code, signal) => {
      run.exitCode = code;
      run.endedAt = new Date().toISOString();
      if (run.status === "running") run.status = signal ? "stopped" : code === 0 ? "passed" : "failed";
      if (run.runner === "node-test") run.results = parseReport(run.output, this.root);
      this.db
        .prepare("INSERT INTO test_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(run.id, run.command, run.runner, JSON.stringify(run.files), run.revision, run.status, run.exitCode, run.startedAt, run.endedAt, run.startedBy, JSON.stringify(run.results), run.output.slice(-100_000));
      this.current = null;
      this.onChange?.();
    });
    return run;
  }

  stop(): boolean {
    if (!this.current) return false;
    this.current.run.status = "stopped";
    try {
      process.kill(-this.current.proc.pid!, "SIGTERM");
    } catch {
      this.current.proc.kill("SIGTERM");
    }
    return true;
  }

  /** The current run, or the latest finished one, with whether its results still describe this workspace. */
  latest(): (TestRun & { stale: boolean }) | null {
    if (this.current) return { ...this.current.run, stale: false };
    const r = this.db.prepare("SELECT * FROM test_runs ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!r) return null;
    const run: TestRun = {
      id: r.id as string,
      command: r.command as string,
      runner: r.runner as TestRun["runner"],
      files: JSON.parse(r.files as string),
      revision: r.revision as string,
      status: r.status as TestRun["status"],
      exitCode: (r.exit_code as number) ?? null,
      startedAt: r.started_at as string,
      endedAt: (r.ended_at as string) ?? null,
      startedBy: r.started_by as string,
      results: JSON.parse(r.results as string),
      output: r.output as string,
    };
    return { ...run, stale: run.revision !== this.fingerprint() };
  }

  close(): void {
    this.stop();
  }
}
