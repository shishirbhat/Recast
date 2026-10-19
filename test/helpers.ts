import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Relay } from "../src/core/engine.ts";
import type { Actor } from "../src/core/types.ts";

export const HUMAN: Actor = { kind: "human", id: "alice" };
export const AGENT_A: Actor = { kind: "agent", id: "claude-code" };
export const AGENT_B: Actor = { kind: "agent", id: "codex" };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A real git repository with one commit containing `files`. */
export function makeRepo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-repo-")));
  git(dir, "init", "-q", "-b", "main");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  return dir;
}

export function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "relay-db-")), "relay.db");
}

export const USER_API_V1 = "getUser(id) -> { id: string, name: string }";
export const USER_API_V2 = "getUser(id) -> { id: string, fullName: string }  (`name` removed)";

/**
 * The contract-change scenario: user-api v1 accepted; T-api owns the server, T-ui owns the client and
 * depends on user-api v1. Both tasks are queued, with base = HEAD of a fresh repo.
 */
export function scenario(): { relay: Relay; repo: string; db: string } {
  const repo = makeRepo({
    "src/server.js": "export function getUser(id) { return { id, name: 'Ada' }; }\n",
    "src/ui.js": "export function greet(user) { return 'Hello ' + user.name; }\n",
    "README.md": "demo\n",
  });
  const db = tempDb();
  const relay = new Relay(db);
  relay.proposeContract("user-api", USER_API_V1, HUMAN);
  relay.acceptContract("user-api", 1, HUMAN);
  const base = git(repo, "rev-parse", "HEAD");
  relay.createTask({ id: "T-api", objective: "Server side of user-api", scope: ["src/server.js"], contracts: { "user-api": 1 }, baseCommit: base }, HUMAN);
  relay.createTask({ id: "T-ui", objective: "Greeting UI", scope: ["src/ui.js"], contracts: { "user-api": 1 }, verify: ["node --check src/ui.js"], baseCommit: base }, HUMAN);
  relay.transition("T-api", "queued", HUMAN);
  relay.transition("T-ui", "queued", HUMAN);
  return { relay, repo, db };
}
