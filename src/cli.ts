import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Relay } from "./core/engine.ts";
import { RelayError, TASK_STATES } from "./core/types.ts";
import type { Actor, TaskState } from "./core/types.ts";
import { resolveCommit } from "./git.ts";
import { changeRecord } from "./analysis/change.ts";
import { ImpactService } from "./analysis/impact.ts";
import { Records } from "./knowledge/records.ts";
import { listProjectFiles } from "./server/files.ts";
import { HOOK_MATCHER, runHook } from "./hooks/claude-code.ts";
import { runMcp } from "./mcp/server.ts";
import { startServer } from "./server/server.ts";
import { Members } from "./server/auth.ts";
import { RemoteError, call, errorText, forgetSession, join as remoteJoin, loadSession } from "./remote.ts";
import type { OwnedFile, Radar } from "./analysis/radar.ts";
import type { Integration } from "./core/types.ts";
import type { Role } from "./server/auth.ts";

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
  relay integrate together <task,task...> [--verify CMD...]         Check Together on the running server (agent work
                                                included): rehearses the combined change, prints the result and why.
                                                Never applies. Exit 0 passed, 1 blocked, 2 usage, 3 could not complete
  relay radar [--json]                          Conflict Radar from the running server: what could go wrong between pieces
                                                of work, known vs suspected, with evidence. Exit 0 none high, 1 high alerts
  relay ownership [--json]                      changed files with the tasks that own them and who changed them, where
  relay remote join <invite-link>              sign this checkout in to a running Relay server (one-time invite)
  relay remote status | leave                  which server and member this checkout uses / sign out
  relay check <task> --cwd DIR                  diff-time conflict check (records evidence)
  relay verify <task> --cwd DIR                 run the task's verification commands (records evidence)
  relay impact [--base REF | --task ID] --cwd DIR   what a change affects: interfaces, consumers, tests, tasks, stale evidence
  relay change <task> --cwd DIR              one record: stages (claimed..integrated), tests and freshness, blockers, approvals, rollback
  relay context <task> --cwd DIR             accepted decisions, current contracts, conflicts and obsolete records for a task
  relay decision list | accept|reject <id> | invalidate <id> --reason TEXT --cwd DIR
  relay investigation list | show <id> --cwd DIR
  relay events [task]
  relay ide [--port N] [--host ADDR] [--cwd DIR] [--allow-terminal]
                                                start the collaborative IDE server (127.0.0.1:4747 by default);
                                                the terminal is owner-only and off on non-loopback hosts unless --allow-terminal
  relay ide invite <name> [--role owner|editor|viewer] [--port N]   one-time join link for a collaborator
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
    port: { type: "string" },
    host: { type: "string" },
    role: { type: "string" },
    "allow-terminal": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const dbPath = resolve(o.db ?? process.env.RELAY_DB ?? ".relay/relay.db");
// The CLI's session with a running Relay server, kept beside the project database.
const sessionFile = join(dirname(dbPath), "remote-session.json");
/** Exit codes for commands that ask the server for a verdict: 0 passed, 1 blocked, 2 usage, 3 could not complete. */
const COULD_NOT_COMPLETE = 3;
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
  if (cmd === "ide") {
    const port = o.port ? Number(o.port) : 4747;
    const host = o.host ?? "127.0.0.1";
    if (sub === "invite") {
      const relay = new Relay(dbPath);
      try {
        const { member, token } = new Members(relay.db).invite(need(a1, "name"), (o.role ?? "editor") as Role);
        return print({ member, joinUrl: `http://${host}:${port}/join#${token}` }, `Invite for ${member.name} (${member.role}). One-time link, valid 72 hours:\n  http://${host}:${port}/join#${token}`);
      } finally {
        relay.close();
      }
    }
    const root = resolve(o.cwd ?? process.cwd());
    const server = await startServer({ root, dbPath, port, host, staticDir: resolve(dirname(RELAY_BIN), "../ide/web/out"), allowTerminal: o["allow-terminal"] === true });
    if (host !== "127.0.0.1" && host !== "localhost") console.error("relay: warning: serving on a network interface without TLS. Put it behind an HTTPS reverse proxy or tunnel.");
    if (server.members.list().length === 0) {
      const { member, token } = server.members.invite(process.env.USER || "owner", "owner");
      console.log(`Relay IDE for ${root}\n  ${server.url}\n\nYou are the first member (${member.name}, owner). Open this one-time link to sign in:\n  ${server.url}/join#${token}`);
    } else console.log(`Relay IDE for ${root}\n  ${server.url}\nNeed a link? relay ide invite <name> --role editor`);
    const stop = () => server.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return new Promise<void>(() => {});
  }
  if (cmd === "remote") {
    if (sub === "join") {
      const r = await remoteJoin(need(a1, "invite link"), sessionFile);
      return print({ server: r.server, name: r.name, role: r.role }, `Signed in to ${r.server} as ${r.name} (${r.role}).`);
    }
    if (sub === "status") {
      const s = loadSession(sessionFile);
      if (!s) return print({ server: null }, "Not signed in to a Relay server. Use: relay remote join <invite-link>");
      const r = await call<{ me: { name: string; role: string } }>(s.server, s.cookie, "GET", "/state");
      if (r.status !== 200) throw new RemoteError(r.status, `${s.server}: ${errorText(r.body, `HTTP ${r.status}`)}`);
      return print({ server: s.server, name: r.body.me.name, role: r.body.me.role }, `${s.server} as ${r.body.me.name} (${r.body.me.role})`);
    }
    if (sub === "leave") {
      const s = loadSession(sessionFile);
      if (s) await call(s.server, s.cookie, "POST", "/logout").catch(() => {});
      forgetSession(sessionFile);
      return print({ server: null }, "Signed out.");
    }
    throw new RelayError("usage", `Unknown command: ${args.join(" ")}\n\n${USAGE}`);
  }
  if (cmd === "integrate" && sub === "together") return integrateTogether(need(a1, "task ids (comma-separated)"));
  if (cmd === "radar") return radarCmd();
  if (cmd === "ownership") return ownershipCmd();
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
      case "impact": {
        const r = new ImpactService(relay, resolve(o.cwd ?? process.cwd()), dbPath).compute({ base: o.base, taskId: o.task });
        const lines = [
          `Base ${r.base.slice(0, 7)} · ${r.changedFiles.length} changed file(s) · ${r.stats.files} modules (${r.stats.parsed} parsed, ${r.stats.cached} cached, ${r.stats.ms} ms)`,
          ...r.interfaces.filter((i) => i.change !== "added").map((i) => `CHANGED  ${i.file}#${i.symbol} (${i.change})${i.before ? `: ${i.before} -> ${i.after ?? "removed"}` : ""}`),
          ...r.consumers.map((c) => `CONSUMER ${c.evidence.detail}${c.breaks.map((b) => `\n         line ${b.line}: ${b.reason}`).join("")}`),
          ...r.tests.map((t) => `TEST     ${t.chain.join(" -> ")}`),
          ...r.tasks.map((t) => `TASK     ${t.taskId} (${t.state}): ${t.reasons.map((x) => `[${x.kind}] ${x.detail}`).join("; ")}`),
          ...r.stale.map((s) => `STALE    ${s.taskId} ${s.kind}${s.command ? ` "${s.command}"` : ""}: ${s.reason}`),
          ...r.suggestions.map((s) => `NEXT     ${s}`),
          ...r.gaps.map((g) => `UNSEEN   ${g}`),
        ];
        return print(r, lines.join("\n"));
      }
      case "change": {
        const root = resolve(o.cwd ?? process.cwd());
        const r = changeRecord(relay, root, dbPath, need(sub, "task id"), { impact: new ImpactService(relay, root, dbPath).compute({}) });
        const mark = { done: "[x]", missing: "[ ]", failed: "[!]", stale: "[~]", "n/a": "[-]" } as const;
        print(r, [
          `${r.task.id} (${r.task.state}): ${r.task.objective}`,
          ...r.stages.map((s) => `${mark[s.state]} ${s.label.padEnd(38)} ${s.detail}`),
          ...r.blockers.map((b) => `BLOCKER  ${b}`),
          ...r.security.map((x) => `SECURITY ${x.detail}`),
          ...r.rollback.map((x) => `ROLLBACK ${x}`),
          r.safeToIntegrate ? "Safe to integrate: yes (still needs a person's approval)" : "Safe to integrate: no",
        ].join("\n"));
        if (!r.safeToIntegrate) process.exitCode = 1;
        return;
      }
      case "context": {
        const root = resolve(o.cwd ?? process.cwd());
        const graph = new ImpactService(relay, root, dbPath).graph;
        graph.refresh(listProjectFiles(root));
        const records = new Records(relay, root);
        const c = records.contextFor(need(sub, "task id"), graph);
        return print(c, records.contextText(sub!, graph, 20_000) + (c.obsolete.length ? `\nObsolete: ${c.obsolete.map((x) => `${x.id} (${x.status}${x.replacement ? ` -> ${x.replacement}` : ""})`).join(", ")}` : "") || "No decisions or contracts touch this task.");
      }
      case "decision": {
        const records = new Records(relay, resolve(o.cwd ?? process.cwd()));
        if (sub === "list") {
          const ds = records.listDecisions();
          return print(ds, ds.map((d) => `${d.id}  ${d.status.padEnd(11)} ${d.kind.padEnd(10)} ${d.title}${d.sourceStatus.some((x) => x.state === "changed" || x.state === "missing") ? "  (a source changed)" : ""}`).join("\n") || "No decision records.");
        }
        const to = ({ accept: "accepted", reject: "rejected", invalidate: "invalidated" } as const)[sub as "accept"];
        if (to) return print(records.decide(need(a1, "decision id"), to, human.id, o.reason), `${a1} ${to}`);
        break;
      }
      case "investigation": {
        const records = new Records(relay, resolve(o.cwd ?? process.cwd()));
        if (sub === "list") {
          const is = records.listInvestigations();
          return print(is, is.map((i) => `${i.id}  ${i.status.padEnd(9)} ${i.owner.padEnd(12)} @${i.revision}  ${i.title}`).join("\n") || "No investigations.");
        }
        if (sub === "show") {
          const r = records.getInvestigation(need(a1, "investigation id"));
          return print(r, [`${r.investigation.title} (${r.investigation.status}, opened @${r.investigation.revision})`, r.investigation.description, ...r.entries.map((e) => `- [${e.kind}${e.status ? `:${e.status}` : ""}${e.verified ? "" : ", unverified"}] ${e.author} @${e.revision}: ${e.body.split("\n")[0]}${e.sources.length ? ` (${e.sources.map((x) => `${x.type}:${x.ref}`).join(", ")})` : ""}`)].join("\n"));
        }
        break;
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

/**
 * Check Together through the running server: the same service the browser IDE and VS Code call, so the result (and
 * its explanation) is the one they'd show. Prints the server's report; never applies anything.
 */
async function integrateTogether(list: string): Promise<void> {
  const ids = [...new Set(list.split(",").map((t) => t.trim()).filter(Boolean))];
  if (ids.length < 2) throw new RelayError("usage", "Name at least two tasks to check together, comma-separated: relay integrate together T-a,T-b");
  const s = loadSession(sessionFile);
  if (!s) throw new RemoteError(null, "not signed in to a Relay server. Ask an owner for an invite link, then: relay remote join <invite-link>");
  const r = await call<Integration & { report: string }>(s.server, s.cookie, "POST", "/integrations/check", { tasks: ids, ...(o.verify?.length ? { verify: o.verify } : {}) });
  if (r.status === 401) throw new RemoteError(401, `your session on ${s.server} ended; sign in again with relay remote join <invite-link>`);
  if (r.status !== 200) throw new RemoteError(r.status, `${s.server} refused the check (HTTP ${r.status}): ${errorText(r.body, "no reason given")}`);
  const integ = r.body;
  if (o.json) console.log(JSON.stringify(integ, null, 2));
  else console.log(integ.report);
  process.exitCode = integ.status === "passed" ? 0 : 1;
}

/** GET from the server this checkout is signed in to, with the same errors as Check Together. */
async function remoteGet<T>(path: string): Promise<T> {
  const s = loadSession(sessionFile);
  if (!s) throw new RemoteError(null, "not signed in to a Relay server. Ask an owner for an invite link, then: relay remote join <invite-link>");
  const r = await call<T>(s.server, s.cookie, "GET", path);
  if (r.status === 401) throw new RemoteError(401, `your session on ${s.server} ended; sign in again with relay remote join <invite-link>`);
  if (r.status !== 200) throw new RemoteError(r.status, `${s.server} refused (HTTP ${r.status}): ${errorText(r.body, "no reason given")}`);
  return r.body;
}

async function radarCmd(): Promise<void> {
  const r = await remoteGet<Radar>("/radar");
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else if (!r.alerts.length) console.log("Conflict radar: nothing to warn about.");
  else
    console.log(
      [`Conflict radar: ${r.alerts.length} ${r.alerts.length === 1 ? "alert" : "alerts"}`, ""]
        .concat(r.alerts.flatMap((a) => [`${a.severity.toUpperCase()}  ${a.certainty === "known" ? "known    " : "suspected"}  ${a.title}`, `      ${a.detail}`, ...a.evidence.map((e) => `      - ${e.source}${e.at ? ` ${e.at}` : ""}: ${e.text}`), ""]))
        .concat(r.limits.map((l) => `Not seen: ${l}`))
        .join("\n"),
    );
  process.exitCode = r.alerts.some((a) => a.severity === "high") ? 1 : 0;
}

async function ownershipCmd(): Promise<void> {
  const r = await remoteGet<{ files: OwnedFile[] }>("/ownership");
  if (o.json) return console.log(JSON.stringify(r, null, 2));
  if (!r.files.length) return console.log("No changed files.");
  for (const f of r.files) {
    console.log(`${f.path}${f.contested ? "  (contested)" : ""}\n  owned by: ${f.scopeOwners.join(", ") || "no task"}`);
    for (const c of f.changes) console.log(`  changed by ${c.by}${c.task ? ` for ${c.task}` : ""} ${c.where === "agent-worktree" ? `in ${c.worktree}` : "in the shared project"}${c.at ? ` at ${c.at}` : ""}`);
  }
}

main().catch((err) => {
  const code = err instanceof RelayError ? err.code : "internal";
  console.error(`relay: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = code === "usage" ? 2 : err instanceof RemoteError ? COULD_NOT_COMPLETE : 1;
});
