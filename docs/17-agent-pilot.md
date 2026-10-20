# Bounded agent pilot: connecting a desktop agent through Recast

What a design partner does to put one AI agent behind the Recast gateway, and what that does and does not guarantee.

## Steps
1. **Create the agent's key and register it** (on the machine that runs the agent):
   ```
   RECAST_ADMIN_TOKEN=… agent-auth init --name pilot --org acme --tenant <tenant id> --gateway https://runtime.example/mcp --register
   ```
   - The Ed25519 private key is written to `~/.agent-auth/keys/pilot.json` with mode 600. Only the public half is sent.
   - The profile (`profiles/pilot.json`) holds the agent id, gateway and tenant. It holds no secrets.
   - The admin token is read from the environment for that one call and never saved.
   - Without `--register`, the command prints the JSON to hand to an operator instead.
   - A plain-`http` gateway is refused unless it is `localhost`.
2. **An operator grants scopes and creates a Space** (`docs/16-spaces.md`) through the admin API: which actions, how many calls, how much money, until when, and which actions ask a person first.
3. **Point the MCP client at the bridge.** `init` prints the snippet. For a desktop client's MCP configuration:
   ```json
   { "mcpServers": { "recast-pilot": { "command": "agent-auth", "args": ["connect", "--name", "pilot"] } } }
   ```
   `agent-auth connect` speaks MCP over stdio to the client and HTTPS to the gateway. For every request it signs:
   - a 5-minute token, reused until about 30 s before it expires;
   - a fresh proof bound to the method, the URL and that token.

   It also adds `--space` when given. Its stdout carries only protocol messages; diagnostics go to stderr.
4. **Approvals.** When a call needs a person, the client gets a JSON-RPC error `-32004` whose `data.approval_id` names the request. After a person approves it (control center → Approvals, or the admin API), the agent repeats the same call with `_meta: {"recast/approval_id": "<id>"}`. It works once, only for the same arguments, and only in the same Space. `_meta.recast/space` selects a Space the same way.
5. **Activity.** Every decision is signed into the tenant's audit chain with the Space and cost. You can see it in the control center (Audit chain, Agents) or at `GET /admin/audit`. Stopping the Space or revoking the agent takes effect on the next call.

## Evidence
`apps/agent-server/test/pilot.test.ts` runs the whole sequence:
- `init --register`;
- an operator's scopes and Space;
- the official MCP SDK client launching `agent-auth connect` as a child process over stdio;
- the deployable runtime on the Postgres wire protocol, with proofs **required** and Spaces **required**;
- two local tools that write files (`notes.append`, `calendar.add_event`).

It proves:
- the client lists only the Space's tools;
- an unscoped-in-Space delete is refused and the file is untouched;
- the calendar waits for a person, an approval works once and only for the same arguments;
- the audit chain verifies with the expected sequence;
- revoking the agent stops the bridge's next call.

The tools only ever saw the vault's credential. Bridge edge cases are in `packages/agent-runtime/test/bridge.test.ts`. Level: **H** (local processes, the official client and server SDKs). No real agent product or person has used it (**P** not reached).

## Bring your own keys (BYOK)
- **Model keys stay with the agent.** Recast never needs, sees or proxies the agent's LLM provider key. The gateway sits between the agent and its tools, not between the agent and its model.
- **Tool credentials are the tenant's own.** The runtime's vault holds credentials the tenant supplies for its tools (`RECAST_VAULT` today; a secrets manager behind the same `CredentialVault` interface later). They are exchanged per call and never returned to the agent.
- **No platform master key is distributed.** Each agent has its own keypair. The admin token is an operator secret and is never written by the CLI.

## What the gateway cannot stop (gateway bypass)
The guarantees above hold **only for calls that go through the gateway**.
- **Credentials held directly.** If the agent, or the machine it runs on, holds a tool's credential itself (an API key in its environment, a logged-in browser, an OAuth token in a config file), it can call that tool directly, and nothing here sees or limits it. Keep tool credentials in the runtime's vault only, and rotate any the agent has seen.
- **Other MCP servers.** A desktop client can list other MCP servers next to `recast-pilot`. Those are not bounded. The partner's configuration decides this, not Recast.
- **Local side effects.** Tools that run on the same machine as the agent (shell, file system) are outside the gateway unless they are themselves behind it.
- **The agent's key is the agent.** Anyone with `keys/<name>.json` can act as that agent within its Spaces. Revoke the agent (`/admin/agents/revoke`) if the machine is compromised. Proofs stop a stolen *token* from being reused, not a stolen *key*.
- **Upstream honesty.** The gateway trusts the tool server's answer. A tool that reports success without acting, or acts without reporting, is outside its view.

## Not done
- No packaged binary. `agent-auth` runs with `npx tsx` from this repository. A signed, installable CLI needs a release process.
- No OS keychain integration. The key file is mode-600 JSON.
- Not run inside a real desktop agent product (Claude Desktop, Cursor and others). The stdio protocol is the same one the official SDK speaks, which the test uses, but no product-specific quirks have been checked.
