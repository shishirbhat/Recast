import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runAsync } from "../core/engine.ts";
import { RelayError } from "../core/types.ts";
import { sanitize } from "../knowledge/sanitize.ts";
import { isSecretPath } from "../server/files.ts";

/**
 * Project onboarding: what Relay can find out about how this project is built and checked, offered as proposals.
 *
 * Every proposal cites where it was found (file and line). Nothing is applied by discovery: an owner accepts or
 * dismisses each one. A proposed command can be tried first: Relay runs it on a copy of the project's current files
 * and records what happened, so "this is how you test it" is shown working (or not) before anyone relies on it.
 * Accepted check commands become the default checks for new tasks.
 */

export type ProposalKind = "verify-command" | "install" | "runtime" | "scope-area" | "note";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  /** The command or value proposed. */
  value: string;
  evidence: { file: string; line: number | null; text: string }[];
  status: "proposed" | "accepted" | "dismissed";
  decidedBy: string | null;
  trial: { at: string; by: string; exitCode: number | null; ms: number; output: string } | null;
}

const idOf = (kind: string, value: string) => `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;

function lineOf(text: string, needle: string): number | null {
  const i = text.indexOf(needle);
  return i < 0 ? null : text.slice(0, i).split("\n").length;
}

function read(root: string, p: string): string | null {
  try {
    return readFileSync(join(root, p), "utf8");
  } catch {
    return null;
  }
}

/** What the repository says, as proposals (without status). */
export function discover(root: string, files: string[]): Omit<Proposal, "status" | "decidedBy" | "trial">[] {
  const out: Omit<Proposal, "status" | "decidedBy" | "trial">[] = [];
  const add = (kind: ProposalKind, title: string, value: string, evidence: Proposal["evidence"]) => {
    const id = idOf(kind, value);
    const have = out.find((p) => p.id === id);
    if (have) have.evidence.push(...evidence);
    else out.push({ id, kind, title, value, evidence });
  };

  const pkgText = read(root, "package.json");
  let pkg: { scripts?: Record<string, string>; engines?: { node?: string } } = {};
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {};
  } catch {
    if (pkgText) add("note", "package.json isn't valid JSON", "package.json", [{ file: "package.json", line: null, text: "could not be parsed" }]);
  }
  const scripts = pkg.scripts ?? {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (name === "test" && /no test specified/.test(cmd)) continue;
    if (/^(test|lint|typecheck|check|tsc|test:unit)$/.test(name))
      add("verify-command", `Check with npm ${name === "test" ? "test" : `run ${name}`}`, name === "test" ? "npm test" : `npm run ${name}`, [{ file: "package.json", line: pkgText ? lineOf(pkgText, `"${name}"`) : null, text: `"${name}": "${cmd}"` }]);
  }
  const lock = [["package-lock.json", "npm ci"], ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"], ["yarn.lock", "yarn install --frozen-lockfile"], ["bun.lockb", "bun install"]].find(([f]) => files.includes(f!));
  if (lock) add("install", `Install dependencies with ${lock[1]}`, lock[1]!, [{ file: lock[0]!, line: null, text: "lockfile present" }]);

  const nvmrc = read(root, ".nvmrc")?.trim();
  const wanted = nvmrc ?? pkg.engines?.node;
  if (wanted) {
    const major = /(\d+)/.exec(wanted)?.[1];
    const have = process.versions.node.split(".")[0];
    add("runtime", major && major !== have ? `Node ${wanted} is expected; this server runs Node ${process.versions.node}` : `Node ${wanted} is expected; the server's Node ${process.versions.node} matches`, `node ${wanted}`, [{ file: nvmrc ? ".nvmrc" : "package.json", line: nvmrc ? 1 : pkgText ? lineOf(pkgText, '"node"') : null, text: wanted }]);
  }

  // CI: the commands the project's own pipeline runs are strong evidence of how it is checked.
  for (const f of files.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x))) {
    const text = read(root, f) ?? "";
    text.split("\n").forEach((l, i) => {
      const m = /^\s*(?:-\s*)?run:\s*(.+?)\s*$/.exec(l);
      if (!m || m[1] === "|" || m[1] === ">") return;
      const cmd = m[1]!.replace(/^["']|["']$/g, "");
      if (/\b(test|lint|tsc|typecheck|check|pytest|go test|cargo test)\b/.test(cmd)) add("verify-command", `Check with ${cmd} (the CI runs it)`, cmd, [{ file: f, line: i + 1, text: l.trim() }]);
      else if (/\b(npm ci|npm install|pnpm install|yarn install|pip install)\b/.test(cmd)) add("install", `Install dependencies with ${cmd} (the CI does)`, cmd, [{ file: f, line: i + 1, text: l.trim() }]);
    });
  }
  if (files.includes("pyproject.toml") || files.includes("pytest.ini") || files.some((x) => /(^|\/)test_[^/]+\.py$/.test(x))) add("verify-command", "Check with pytest", "pytest", [{ file: files.find((x) => x === "pyproject.toml" || x === "pytest.ini" || /test_[^/]+\.py$/.test(x))!, line: null, text: "Python tests found" }]);
  const make = read(root, "Makefile");
  if (make && /^test:/m.test(make)) add("verify-command", "Check with make test", "make test", [{ file: "Makefile", line: lineOf(make, "test:"), text: "test:" }]);
  if (!Object.keys(scripts).includes("test") && files.some((x) => /\.test\.(m|c)?(j|t)s$/.test(x))) add("verify-command", "Check with node --test (test files, no test script)", "node --test", [{ file: files.find((x) => /\.test\.(m|c)?(j|t)s$/.test(x))!, line: null, text: "a Node test file" }]);

  // Areas: top-level folders with code, as starting points for task scopes.
  const top = new Map<string, number>();
  for (const f of files) if (f.includes("/") && /\.(m|c)?(j|t)sx?$|\.py$|\.go$|\.rs$/.test(f)) top.set(f.split("/")[0]!, (top.get(f.split("/")[0]!) ?? 0) + 1);
  for (const [dir, n] of [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) add("scope-area", `${dir}/ (${n} code file${n === 1 ? "" : "s"}) can be a task's scope`, `${dir}/`, [{ file: `${dir}/`, line: null, text: `${n} code files` }]);
  const secrets = files.filter((f) => isSecretPath(f));
  if (secrets.length) add("note", `${secrets.length} file${secrets.length === 1 ? "" : "s"} that may hold secrets ${secrets.length === 1 ? "is" : "are"} never shared or shown to agents`, secrets.join(", "), secrets.slice(0, 5).map((f) => ({ file: f, line: null, text: "protected path" })));
  if (!out.some((p) => p.kind === "verify-command")) add("note", "No way to check the project was found: tasks will need their check commands written by hand", "no-checks", [{ file: "package.json", line: null, text: pkgText ? "no test script" : "no package.json" }]);
  return out;
}

/** Every file git sees in the project (tracked and untracked, not ignored), secret ones included by name only. */
export function onboardingFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter((f) => f && !f.startsWith(".relay/"));
}

export class Onboarding {
  private db: DatabaseSync;
  private root: string;

  constructor(db: DatabaseSync, root: string) {
    this.db = db;
    this.root = root;
    db.exec("CREATE TABLE IF NOT EXISTS onboarding (id TEXT PRIMARY KEY, status TEXT NOT NULL, decided_by TEXT, decided_at TEXT, trial TEXT)");
  }

  proposals(files: string[]): Proposal[] {
    const stored = new Map((this.db.prepare("SELECT * FROM onboarding").all() as { id: string; status: string; decided_by: string | null; trial: string | null }[]).map((r) => [r.id, r]));
    return discover(this.root, files).map((p) => {
      const s = stored.get(p.id);
      return { ...p, status: (s?.status as Proposal["status"]) ?? "proposed", decidedBy: s?.decided_by ?? null, trial: s?.trial ? JSON.parse(s.trial) : null };
    });
  }

  /** Accepted check commands: the default checks for new tasks. */
  defaultVerify(files: string[]): string[] {
    return this.proposals(files).filter((p) => p.kind === "verify-command" && p.status === "accepted").map((p) => p.value);
  }

  decide(id: string, files: string[], status: "accepted" | "dismissed" | "proposed", by: string): Proposal {
    const p = this.proposals(files).find((x) => x.id === id);
    if (!p) throw new RelayError("not_found", "That proposal isn't found in the project any more");
    if (status === "accepted" && (p.kind === "note" || p.kind === "runtime" || p.kind === "scope-area")) throw new RelayError("invalid", "That's information, not something to accept; dismiss it once read");
    this.db.prepare("INSERT INTO onboarding (id, status, decided_by, decided_at, trial) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET status = excluded.status, decided_by = excluded.decided_by, decided_at = excluded.decided_at").run(id, status, by, new Date().toISOString());
    return this.proposals(files).find((x) => x.id === id)!;
  }

  /** Run a proposed command on a copy of the project's current files (git's view: tracked and untracked, not ignored). */
  async tryCommand(id: string, files: string[], by: string, timeoutMs = 180_000): Promise<Proposal> {
    const p = this.proposals(files).find((x) => x.id === id);
    if (!p) throw new RelayError("not_found", "That proposal isn't found in the project any more");
    if (p.kind !== "verify-command" && p.kind !== "install") throw new RelayError("invalid", "Only proposed commands can be tried");
    const dir = mkdtempSync(join(tmpdir(), "relay-try-"));
    const idx = mkdtempSync(join(tmpdir(), "relay-try-idx-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(idx, "index") };
      execFileSync("git", ["add", "-A", "--", ":/", ":(exclude).relay"], { cwd: this.root, env, stdio: "ignore" });
      execFileSync("git", [`--work-tree=${dir}`, "checkout-index", "-a"], { cwd: this.root, env, stdio: "ignore" });
      // Like an agent's worktree, the copy never holds files that may contain secrets.
      for (const f of files.filter((x) => isSecretPath(x))) rmSync(join(dir, f), { force: true });
      if (existsSync(join(this.root, "node_modules")) && !existsSync(join(dir, "node_modules"))) symlinkSync(join(this.root, "node_modules"), join(dir, "node_modules"));
      const t0 = Date.now();
      const r = await runAsync(p.value, dir, timeoutMs);
      const trial = { at: new Date().toISOString(), by, exitCode: r.exitCode, ms: Date.now() - t0, output: sanitize(r.output.slice(-3000), dir).text };
      this.db.prepare("INSERT INTO onboarding (id, status, trial) VALUES (?, 'proposed', ?) ON CONFLICT(id) DO UPDATE SET trial = excluded.trial").run(id, JSON.stringify(trial));
      return this.proposals(files).find((x) => x.id === id)!;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(idx, { recursive: true, force: true });
    }
  }
}
