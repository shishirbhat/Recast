import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Relay } from "./core/engine.ts";
import { RelayError, TASK_STATES } from "./core/types.ts";
import type { Actor, TaskState } from "./core/types.ts";
import { resolveCommit } from "./git.ts";
import { HOOK_MATCHER, runHook } from "./hooks/claude-code.ts";
import { runMcp } from "./mcp/server.ts";

const RELAY_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/relay");

const USAGE = `relay — coordinate humans and coding agents on one repository

  relay init
  relay task create <id> --objective TEXT --scope PATH... [--contract ID@VER...] [--prereq ID...] [--verify CMD...] [--base REF]
  relay task list | show <id>
  relay task approve <id>                       proposed -> queued (human)
  relay task move <id> <state> [--reason TEXT]
  relay task complete <id> --cwd DIR            human approval; enforces the completion gate
  relay contract propose <id> --definition TEXT [--rationale TEXT] [--accept]
  relay contract accept|reject <id> <version>
  relay contract show <id>
  relay intent approve <intent-id>
  relay integrate check <task,task...> --cwd DIR [--verify CMD...]   cross-task gate (Relay runs every check)
  relay integrate approve <integration-id> --cwd DIR                 human approval; completes all its tasks
  relay check <task> --cwd DIR                  diff-time conflict check (records evidence)
  relay verify <task> --cwd DIR                 run the task's verification commands (records evidence)
  relay events [task]
  relay agent-config claude-code --task ID --root DIR --out DIR
  relay hook claude-code --task ID --root DIR   (invoked by Claude Code)
  relay mcp --task ID --root DIR --agent NAME   (invoked by an agent as an MCP server)

Options: --db PATH (default $RELAY_DB or .relay/relay.db), --json, --as NAME (human actor id)`;

const { values: o, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    json: { type: "boolean" },
    as: { type: "string" },
    objective: { type: "string" },
    scope: { type: "string", multiple: true },
    contract: { type: "string", multiple: true },
    prereq: { type: "string", multiple: true },
    verify: { type: "string", multiple: true },
    base: { type: "string" },
    reason: { type: "string" },
    cwd: { type: "string" },
    definition: { type: "string" },
    rationale: { type: "string" },
    accept: { type: "boolean" },
    task: { type: "string" },
    root: { type: "string" },
    agent: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const dbPath = resolve(o.db ?? process.env.RELAY_DB ?? ".relay/relay.db");
const human: Actor = { kind: "human", id: o.as ?? process.env.USER ?? "human" };

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === "") throw new RelayError("usage", `Missing ${what}`);
  return v;
}

function print(value: unknown, text?: string): void {
  if (o.json || text === undefined) console.log(JSON.stringify(value, null, 2));
  else console.log(text);
}

function parseContracts(specs: string[] = []): Record<string, number> {
  return Object.fromEntries(
    specs.map((s) => {
      const m = /^([^@]+)@(\d+)$/.exec(s);
      if (!m) throw new RelayError("usage", `Contract must look like id@version, got ${s}`);
      return [m[1]!, Number(m[2])];
    }),
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function main(): Promise<void> {
  const [cmd, sub, a1, a2] = args;
  if (!cmd || o.help) return void console.log(USAGE);

  // Long-running or agent-invoked entry points manage their own engine lifetime.
  if (cmd === "hook") {
    if (sub !== "claude-code") throw new RelayError("usage", `Unknown hook adapter ${sub}`);
    return runHook({ db: dbPath, task: need(o.task, "--task"), root: need(o.root, "--root") });
  }
  if (cmd === "mcp") {
    return runMcp({ db: dbPath, task: need(o.task, "--task"), root: need(o.root, "--root"), agent: need(o.agent, "--agent") });
  }
  if (cmd === "agent-config") {
    if (sub !== "claude-code") throw new RelayError("usage", `Unknown agent ${sub}`);
    const task = need(o.task, "--task");
    const root = resolve(need(o.root, "--root"));
    const out = resolve(need(o.out, "--out"));
    mkdirSync(out, { recursive: true });
    const base = `${shellQuote(RELAY_BIN)} --db ${shellQuote(dbPath)}`;
    // `|| printf deny`: if the hook process cannot even start, the action is still denied.
    const failClosed = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Relay hook failed to start; failing closed."}}'`;
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: `${base} hook claude-code --task ${shellQuote(task)} --root ${shellQuote(root)} || ${failClosed}`, timeout: 10 }] }],
      },
    };
    const mcp = { mcpServers: { relay: { command: RELAY_BIN, args: ["--db", dbPath, "mcp", "--task", task, "--root", root, "--agent", "claude-code"] } } };
    writeFileSync(join(out, "settings.json"), JSON.stringify(settings, null, 2));
    writeFileSync(join(out, "mcp.json"), JSON.stringify(mcp, null, 2));
    return print({ settings: join(out, "settings.json"), mcpConfig: join(out, "mcp.json"), launch: ["--settings", join(out, "settings.json"), "--mcp-config", join(out, "mcp.json"), "--strict-mcp-config"] });
  }

  const relay = new Relay(dbPath);
  try {
    switch (cmd) {
      case "init":
        return print({ db: dbPath }, `Relay project database at ${dbPath}`);
      case "task": {
        if (sub === "create") {
          const t = relay.createTask(
            {
              id: need(a1, "task id"),
              objective: need(o.objective, "--objective"),
              scope: need(o.scope, "--scope"),
              contracts: parseContracts(o.contract),
              prerequisites: o.prereq ?? [],
              verify: o.verify ?? [],
              owner: human.id,
              baseCommit: resolveCommit(o.cwd ?? process.cwd(), o.base ?? "HEAD"),
            },
            human,
          );
          return print(t, `Created ${t.id} (proposed). Approve with: relay task approve ${t.id}`);
        }
        if (sub === "list") {
          const ts = relay.listTasks();
          return print(ts, ts.map((t) => `${t.id.padEnd(20)} ${t.state.padEnd(16)} ${t.agent ?? "-"}  ${t.objective}`).join("\n") || "No tasks.");
        }
        if (sub === "show") return print({ task: relay.requireTask(need(a1, "task id")), intents: relay.intents(a1!), evidence: relay.evidence(a1!) });
        if (sub === "approve") return print(relay.transition(need(a1, "task id"), "queued", human, { expectedFrom: "proposed" }), `${a1} queued`);
        if (sub === "move") {
          const to = need(a2, "state") as TaskState;
          if (!TASK_STATES.includes(to)) throw new RelayError("usage", `State must be one of ${TASK_STATES.join(", ")}`);
          return print(relay.transition(need(a1, "task id"), to, human, { reason: o.reason }), `${a1} -> ${to}`);
        }
        if (sub === "complete") {
          return print(relay.transition(need(a1, "task id"), "completed", human, { expectedFrom: "review_required", cwd: resolve(need(o.cwd, "--cwd")) }), `${a1} completed`);
        }
        break;
      }
      case "contract": {
        if (sub === "propose") {
          const c = relay.proposeContract(need(a1, "contract id"), need(o.definition, "--definition"), human, o.rationale);
          if (!o.accept) return print(c, `Proposed ${c.id} v${c.version}`);
          const r = relay.acceptContract(c.id, c.version, human);
          return print(r, `Accepted ${c.id} v${c.version}${r.affectedTasks.length ? `; now stale: ${r.affectedTasks.join(", ")}` : ""}`);
        }
        if (sub === "accept") {
          const r = relay.acceptContract(need(a1, "contract id"), Number(need(a2, "version")), human);
          return print(r, `Accepted ${a1} v${a2}${r.affectedTasks.length ? `; now stale: ${r.affectedTasks.join(", ")}` : ""}`);
        }
        if (sub === "reject") return print(relay.rejectContract(need(a1, "contract id"), Number(need(a2, "version")), human, o.reason));
        if (sub === "show") return print(relay.contractHistory(need(a1, "contract id")));
        break;
      }
      case "integrate": {
        if (sub === "check") {
          const r = relay.checkIntegration(need(a1, "task ids").split(",").filter(Boolean), resolve(need(o.cwd, "--cwd")), o.verify ?? []);
          print(r, r.status === "passed" ? `PASSED ${r.id}\nApprove with: relay integrate approve ${r.id} --cwd ${o.cwd}` : `BLOCKED ${r.id}\n` + r.gaps.map((g) => `  - ${g}`).join("\n"));
          if (r.status !== "passed") process.exitCode = 1;
          return;
        }
        if (sub === "approve") {
          const r = relay.approveIntegration(need(a1, "integration id"), human, resolve(need(o.cwd, "--cwd")));
          return print(r, `Approved ${r.id}: completed ${r.tasks.join(", ")}`);
        }
        break;
      }
      case "intent":
        if (sub === "approve") return print(relay.approveIntent(need(a1, "intent id"), human));
        break;
      case "check": {
        const r = relay.diffCheck(need(sub, "task id"), resolve(need(o.cwd, "--cwd")));
        const blocking = Object.entries(r.decisions).filter(([, d]) => d.decision === "deny");
        print(r, blocking.length ? `BLOCKED (${blocking.length}):\n` + blocking.map(([f, d]) => `  ${f}: ${d.reason}`).join("\n") : `OK: ${r.files.length} changed file(s), no blocking conflicts`);
        if (blocking.length) process.exitCode = 1;
        return;
      }
      case "verify": {
        const ev = relay.runVerification(need(sub, "task id"), resolve(need(o.cwd, "--cwd")));
        print(ev, ev.map((e) => `${e.exitCode === 0 ? "PASS" : "FAIL"} ${e.command}`).join("\n") || "No verification commands on this task.");
        if (ev.some((e) => e.exitCode !== 0)) process.exitCode = 1;
        return;
      }
      case "events": {
        const evs = relay.events(sub);
        return print(evs, evs.map((e) => `${e.at} ${e.type.padEnd(28)} ${e.taskId ?? "-"} ${e.actor} ${e.fromState ? `${e.fromState}->${e.toState}` : ""}`).join("\n"));
      }
    }
    throw new RelayError("usage", `Unknown command: ${args.join(" ")}\n\n${USAGE}`);
  } finally {
    relay.close();
  }
}

main().catch((err) => {
  const code = err instanceof RelayError ? err.code : "internal";
  console.error(`relay: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = code === "usage" ? 2 : 1;
});
