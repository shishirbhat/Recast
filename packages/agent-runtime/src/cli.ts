#!/usr/bin/env -S npx tsx
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { verifyChain, type AuditEntry } from "./audit";
import { checkGatewayUrl, runStdioBridge } from "./bridge";
import { createAgentIdentity, type AgentRecord } from "./identity";
import type { ScopeGrant } from "./scope";

/** Local file store for `agent-auth`. Private keys live under keys/ with mode 0600 and are never written anywhere else. */
export interface CliEnv {
  dir: string; out: (s: string) => void; now?: () => Date;
  /** Diagnostics. For `connect`, stdout is the protocol, so everything human goes here. */
  err?: (s: string) => void;
  env?: Record<string, string | undefined>; fetch?: typeof fetch; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream;
}
/** What `init` saves next to the key: where this agent connects. No secrets. */
export interface Profile { agentId: string; name: string; tenant: string; gateway: string; audience: string; space?: string }
const PROFILE_NAME = /^[\w.-]{1,64}$/;
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
    if (cmd === "init") {
      const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, org: { type: "string" }, tenant: { type: "string" }, gateway: { type: "string" }, audience: { type: "string", default: "recast-gateway" }, space: { type: "string" }, register: { type: "boolean", default: false } } });
      if (!values.name || !values.org || !values.tenant || !values.gateway) throw new Error("usage: agent-auth init --name <name> --org <org> --tenant <tenant id> --gateway <https://…/mcp> [--audience recast-gateway] [--space <id>] [--register]");
      if (!PROFILE_NAME.test(values.name)) throw new Error("--name must be letters, digits, dots, dashes or underscores");
      const gateway = checkGatewayUrl(values.gateway).toString();
      const keyFile = path.join(env.dir, "keys", `${values.name}.json`);
      let key: { agentId: string; privateJwk: JsonWebKey; publicJwk: JsonWebKey };
      if (existsSync(keyFile)) key = read(keyFile, null as never);
      else { const id = await createAgentIdentity(values.name, values.org, now); key = { agentId: id.agentId, privateJwk: id.privateJwk, publicJwk: id.publicJwk }; write(keyFile, key, 0o600); }
      const profile: Profile = { agentId: key.agentId, name: values.name, tenant: values.tenant, gateway, audience: values.audience!, ...(values.space ? { space: values.space } : {}) };
      write(path.join(env.dir, "profiles", `${values.name}.json`), profile);
      const publicKey = { kty: key.publicJwk.kty, crv: key.publicJwk.crv, x: key.publicJwk.x };
      if (values.register) {
        // The operator's admin token is read from the environment for this one call. It is never written to disk.
        const admin = (env.env ?? process.env).RECAST_ADMIN_TOKEN; if (!admin) throw new Error("--register needs RECAST_ADMIN_TOKEN in the environment");
        const r = await (env.fetch ?? fetch)(new URL("/admin/agents", gateway), { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ tenant: values.tenant, agentId: key.agentId, name: values.name, publicKey }) });
        if (!r.ok) throw new Error(`registration refused (${r.status}): ${((await r.json().catch(() => ({}))) as any)?.error?.message ?? "no reason given"}`);
        env.out(`Registered ${key.agentId} with ${new URL(gateway).origin}.`);
      } else env.out(`Ask your Recast admin to register this agent:\n${JSON.stringify({ tenant: values.tenant, agentId: key.agentId, name: values.name, publicKey })}`);
      env.out(`Profile saved. Add this to your MCP client's configuration:\n${JSON.stringify({ mcpServers: { [`recast-${values.name}`]: { command: "agent-auth", args: ["connect", "--name", values.name] } } }, null, 2)}`);
      return 0;
    }
    if (cmd === "connect") {
      const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, space: { type: "string" } } });
      if (!values.name || !PROFILE_NAME.test(values.name)) throw new Error("usage: agent-auth connect --name <name> [--space <id>]");
      const profile = read<Profile | null>(path.join(env.dir, "profiles", `${values.name}.json`), null); if (!profile) throw new Error(`no profile '${values.name}'; run agent-auth init first`);
      const key = read<{ agentId: string; privateJwk: JsonWebKey } | null>(path.join(env.dir, "keys", `${values.name}.json`), null); if (!key || key.agentId !== profile.agentId) throw new Error(`the key for '${values.name}' is missing or does not match its profile`);
      const err = env.err ?? ((s: string) => process.stderr.write(s + "\n")); const space = values.space ?? profile.space;
      err(`agent-auth: ${profile.agentId} connected to ${new URL(profile.gateway).origin}${space ? ` (Space ${space})` : ""}`);
      await runStdioBridge({ gatewayUrl: profile.gateway, audience: profile.audience, agentId: profile.agentId, privateJwk: key.privateJwk, ...(space ? { space } : {}), ...(env.fetch ? { fetch: env.fetch } : {}), log: (s) => err(`agent-auth: ${s}`) }, env.stdin ?? process.stdin, env.stdout ?? process.stdout);
      return 0;
    }
    if (cmd === "verify-audit") {
      const [file, keysFile] = rest; if (!file || !keysFile) throw new Error("usage: agent-auth verify-audit <entries.json> <public-keys.json>");
      const r = await verifyChain(JSON.parse(readFileSync(file, "utf8")) as AuditEntry[], JSON.parse(readFileSync(keysFile, "utf8")));
      env.out(r.ok ? `OK: ${r.entries} entries, chain and signatures verify` : `BROKEN at entry ${r.brokenAt}: ${r.reason}`); return r.ok ? 0 : 1;
    }
    env.out("agent-auth init | connect | create | scope | verify-audit"); return cmd ? 2 : 0;
  } catch (e) { (cmd === "connect" ? (env.err ?? ((s: string) => process.stderr.write(s + "\n"))) : env.out)(`error: ${e instanceof Error ? e.message : String(e)}`); return 1; }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  runCli(process.argv.slice(2), { dir: process.env.AGENT_AUTH_DIR ?? path.join(homedir(), ".agent-auth"), out: (s) => console.log(s), err: (s) => process.stderr.write(s + "\n") }).then((c) => process.exit(c));
}
