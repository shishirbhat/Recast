# 13. Agent Runtime (first slice)

The second surface on the same spine: identity, permissions and audit for AI agents. Recast is the human surface; Agent Runtime is the machine surface. This slice is the gateway skeleton from the blueprint: an agent authenticates, is scoped, passes a policy, and every action is audited.

## What exists (`packages/agent-runtime`, 39 tests)
| Piece | What it does |
|---|---|
| `identity.ts` | Ed25519 agent identities (WebCrypto, no dependency). Agent id `agt_` + 12 hex. The registry stores only the public key |
| `token.ts` | Agent-signed EdDSA tokens. Checked in order: shape, algorithm (only EdDSA: `none` and HMAC downgrade are refused), known and unrevoked agent, signature, time window, audience, lifetime (max 15 min), token revocation |
| `scope.ts` | Grants per tool and action, with parameter constraints (`max`, `min`, `eq`, `in`), an expiry and a call budget spent atomically |
| `policy.ts` | YAML/JSON rules, default deny, deny beats require-approval beats allow. A condition on a fact the call does not have never matches, so missing data cannot unlock an allow |
| `audit.ts` | Hash-chained, Ed25519-signed, per tenant. `verifyChain` finds an edited entry, a removed one, a reordered pair, a forged signature, and (with the expected head) a cut-off tail. Credentials in parameters are redacted before logging |
| `exchange.ts` | The agent's token is traded for a one-tool credential. Vault mode hands the upstream its own stored secret; runtime-JWT mode mints a 60-second token with the agent as `act`. The agent never sees either |
| `approvals.ts` | A person approves one exact request, once. Approval is bound to a hash of the call, so "send to Meera" cannot be reused for "send to everyone" |
| `gateway.ts` | The MCP middleware: authenticate, parse JSON-RPC, scope, policy, approval, spend the call, **log the decision**, forward with the exchanged credential, **log the outcome** |
| `cli.ts` | `agent-auth create`, `scope`, `verify-audit` against a local directory. Private keys are written at mode 600 and nowhere else |

Database: `supabase/migrations/20260103000000_agent_runtime.sql` adds `agents`, `agent_scopes`, `agent_policies` and `agent_audit_log` on top of the existing `tenants` and `tenant_members`. 11 tests on real Postgres (PGlite).

## Behaviour that is tested
- A call is forwarded with the upstream credential and never with the agent's token. Upstream cookies do not come back.
- No scope, a failed constraint, a policy deny, the default deny, an exhausted budget, an expired scope: each answers 403 or 429, **reaches nothing upstream, and is logged**.
- `require_approval` answers 202 with an approval id and forwards nothing. After a person approves, the same request goes through once. A different request, another tenant, a rejected or expired approval, or a second use does not.
- If the audit log cannot be written, nothing is forwarded (fail closed). A tool with no stored credential is not forwarded without one.
- A new policy applies to the next call without a restart.
- Unsupported MCP methods (`resources/read`, batches) are refused and logged.
- Database: tenants cannot see each other's agents or logs; only owners create agents and scopes; an agent's key cannot be edited and a revoked agent stays revoked; the audit table refuses update, delete and truncate for every role; the chain cannot fork.

## Where I departed from the blueprint, on purpose
- **Audit immutability uses triggers that raise**, not `CREATE RULE ... DO INSTEAD NOTHING`. A silent rule hides a tampering attempt; a raised error shows it.
- **No second `users` or `entities` table.** The existing `tenants`/`tenant_members` and the control-center store already hold these. Copying them would fork the schema. The shared object graph comes back when agents need to read it.
- **Tenant isolation uses membership, not a `tenant_id` claim in the JWT**, to match the tables already built.
- **Policy is a small evaluator, not OPA or Cedar.** It covers the blueprint's example rules. If rules need joins or complex logic, switch to a real engine behind the same `evaluate` call.

## Limits, stated plainly
- **Not DPoP.** Tokens are bearer tokens signed by the agent's key and valid up to 15 minutes. A stolen token works until it expires, unless you revoke the agent or the token id. Per-request proof of possession is not built.
- **Not the RFC 8693 wire protocol.** The exchange is the same idea (trade an identity token for a narrower credential) as a function call inside the gateway, not a `/token` endpoint other systems can call.
- **No real MCP client has been run through it.** The tests use a real HTTP server standing in for an MCP server, and JSON-RPC `tools/call`. Claude, Cursor or another client has not been tried. Streaming (SSE) responses are relayed untouched and judged by status only.
- **`tools/list` is not filtered by scope yet**, so an authenticated agent can see tool names it cannot call.
- **Erasure vs. audit.** The audit table cannot be deleted from, and that blocks deleting a tenant that has audit history. A deliberate export-then-erase process is needed and not built. A Postgres superuser can still drop the triggers; the signatures and hash chain are what make that visible.
- **Nothing persistent is wired up.** The gateway runs on in-memory stores. The SQL schema is tested and the Postgres-backed stores are not written. No Fly.io or Railway deploy, no key management service (the runtime's signing key would live in one), no approval UI.
- **Approvals expire after 15 minutes and live in memory**, so a restart forgets them.
