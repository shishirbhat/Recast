#!/usr/bin/env -S npx tsx
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { verifyChain, type AuditEntry } from "./audit";
import { createAgentIdentity, type AgentRecord } from "./identity";
import type { ScopeGrant } from "./scope";

/** Local file store for `agent-auth`. Private keys live under keys/ with mode 0600 and are never written anywhere else. */
export interface CliEnv { dir: string; out: (s: string) => void; now?: () => Date }
const read = <T>(f: string, fallback: T): T => (existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback);
const write = (f: string, v: unknown, mode = 0o644) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2), { mode }); chmodSync(f, mode); };

export function parseTtl(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s); if (!m) throw new Error(`--ttl must look like 15m, 2h, 30s or 7d, got '${s}'`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s"];
}

export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const [cmd, ...rest] = argv; const now = env.now ?? (() => new Date());
  try {
    if (cmd === "create") {
      const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, org: { type: "string" }, tenant: { type: "string" } } });
      if (!values.name || !values.org) throw new Error("usage: agent-auth create --name <name> --org <org> [--tenant <id>]");
      const id = await createAgentIdentity(values.name, values.org, now);
      const keyFile = path.join(env.dir, "keys", `${values.name}.json`);
      if (existsSync(keyFile)) throw new Error(`a key for '${values.name}' already exists at ${keyFile}; refusing to overwrite it`);
      write(keyFile, { agentId: id.agentId, privateJwk: id.privateJwk, publicJwk: id.publicJwk }, 0o600);
      const agents = read<AgentRecord[]>(path.join(env.dir, "agents.json"), []);
      agents.push({ agentId: id.agentId, tenantId: values.tenant ?? values.org, name: id.name, publicJwk: id.publicJwk }); write(path.join(env.dir, "agents.json"), agents);
      env.out(`Agent ID:   ${id.agentId}\nPublic key: ed25519:${id.publicJwk.x}\nPrivate key saved to ${keyFile} (mode 600). It is not stored anywhere else.`); return 0;
    }
    if (cmd === "scope") {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { tool: { type: "string" }, action: { type: "string" }, ttl: { type: "string", default: "15m" }, "max-calls": { type: "string", default: "50" } } });
      const agentId = positionals[0]; if (!agentId || !values.tool || !values.action) throw new Error("usage: agent-auth scope <agentId> --tool <tool> --action <action> [--ttl 15m] [--max-calls 50]");
      const agent = read<AgentRecord[]>(path.join(env.dir, "agents.json"), []).find((a) => a.agentId === agentId); if (!agent) throw new Error(`no agent ${agentId} in ${env.dir}`);
      const ttl = parseTtl(values.ttl!); const maxCalls = Number(values["max-calls"]); if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new Error("--max-calls must be a positive whole number");
      const grants = read<ScopeGrant[]>(path.join(env.dir, "scopes.json"), []); const at = now();
      const g: ScopeGrant = { id: `scp_${grants.length + 1}`, agentId, tenantId: agent.tenantId, tool: values.tool, action: values.action, issuedAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttl * 1000).toISOString(), maxCalls, calls: 0 };
      grants.push(g); write(path.join(env.dir, "scopes.json"), grants);
      env.out(`Granted ${g.id}: ${agentId} may call ${g.tool}.${g.action} up to ${g.maxCalls} times until ${g.expiresAt}`); return 0;
    }
    if (cmd === "verify-audit") {
      const [file, keysFile] = rest; if (!file || !keysFile) throw new Error("usage: agent-auth verify-audit <entries.json> <public-keys.json>");
      const r = await verifyChain(JSON.parse(readFileSync(file, "utf8")) as AuditEntry[], JSON.parse(readFileSync(keysFile, "utf8")));
      env.out(r.ok ? `OK: ${r.entries} entries, chain and signatures verify` : `BROKEN at entry ${r.brokenAt}: ${r.reason}`); return r.ok ? 0 : 1;
    }
    env.out("agent-auth create | scope | verify-audit"); return cmd ? 2 : 0;
  } catch (e) { env.out(`error: ${e instanceof Error ? e.message : String(e)}`); return 1; }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  runCli(process.argv.slice(2), { dir: process.env.AGENT_AUTH_DIR ?? path.join(homedir(), ".agent-auth"), out: (s) => console.log(s) }).then((c) => process.exit(c));
}
