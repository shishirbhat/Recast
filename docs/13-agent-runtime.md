# 13. Agent Runtime (first slice)

The second surface on the same spine: identity, permissions and audit for AI agents. Recast is the human surface; Agent Runtime is the machine surface. This slice is the gateway skeleton from the blueprint: an agent authenticates, is scoped, passes a policy, and every action is audited.

## What exists (`packages/agent-runtime`, 71 tests)
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
- No scope, a failed constraint, a policy deny, the default deny, an exhausted budget, an expired scope: each is refused with JSON-RPC error `-32003`, **reaches nothing upstream, and is logged**.
- `require_approval` answers with a JSON-RPC error `-32004` (HTTP 200) carrying an approval id, and forwards nothing. After a person approves, the same request goes through once. A different request, another tenant, a rejected or expired approval, or a second use does not.
- If the audit log cannot be written, nothing is forwarded (fail closed). A tool with no stored credential is not forwarded without one.
- A new policy applies to the next call without a restart.
- Unsupported MCP methods (`resources/read`, batches) are refused and logged.
- Database: tenants cannot see each other's agents or logs; only owners create agents and scopes; an agent's key cannot be edited and a revoked agent stays revoked; the audit table refuses update, delete and truncate for every role; the chain cannot fork.

## Where I departed from the blueprint, on purpose
- **Audit immutability uses triggers that raise**, not `CREATE RULE ... DO INSTEAD NOTHING`. A silent rule hides a tampering attempt; a raised error shows it.
- **No second `users` or `entities` table.** The existing `tenants`/`tenant_members` and the control-center store already hold these. Copying them would fork the schema. The shared object graph comes back when agents need to read it.
- **Tenant isolation uses membership, not a `tenant_id` claim in the JWT**, to match the tables already built.
- **Policy is a small evaluator, not OPA or Cedar.** It covers the blueprint's example rules. If rules need joins or complex logic, switch to a real engine behind the same `evaluate` call.

## Added after the first slice
- **A real MCP client was run through it.** The official `@modelcontextprotocol/sdk` client talks over Streamable HTTP to the gateway, which talks to a real MCP server built with the same SDK. Tested: initialise, `tools/list` (now filtered to tools the agent holds a live scope for), an allowed call, a refused call (a typed MCP error, never reaching the server), the approval flow, and a signed audit chain covering all of it.
- **Two things that test found and fixed.** (1) The gateway answered "approval needed" with HTTP 202. In MCP, 202 means "accepted, no reply", so a real client waits forever. Refusals and approval-pending now travel as JSON-RPC errors over HTTP 200 (`-32003` denied, `-32004` approval needed, with the approval id in `data`), plus an `x-recast-decision` header for observers. (2) Real servers want a credential even to initialise and list tools; the gateway now uses the credential stored for tool `*` for those methods.
- **Per-request proof of possession (DPoP style).** `proof: "required"` refuses a bearer token on its own. Every request carries a proof signed by the agent's key, bound to the method, the URL and a hash of the access token, valid for 60 seconds and usable once. A stolen token is useless without the key; a captured proof is useless for another request or a second time. The real MCP client works with it through a custom `fetch` that signs each request. The default is `optional` (checked if sent); use `required` in production.
- **Postgres-backed stores, tested on real Postgres:** agents, scopes (atomic budgets), the audit log (the signed body is stored whole so verification re-hashes exactly what was signed), approvals (exactly one of several concurrent redeemers wins), revoked token ids, the active policy, and the proof replay cache. The whole gateway also runs end to end on them. API keys, usage and corrections have SQL stores too (`packages/api-core`), including the database refusing corrections for a tenant that has not opted in.

## Limits, stated plainly
- **Not the RFC 8693 wire protocol.** The exchange is the same idea (trade an identity token for a narrower credential) as a function call inside the gateway, not a `/token` endpoint other systems can call.
- **Only one real MCP server was tried**, one built with the official SDK. Other clients (Claude Desktop, Cursor) and servers are untested. Streaming (SSE) responses are relayed untouched and judged by status only, except that `tools/list` handles a JSON or single-event SSE answer. JSON-RPC batches are refused. `resources/*` and `prompts/*` are refused, not proxied.
- **The default proof mode is `optional`.** Until `required` is set, a bearer token alone works for up to 15 minutes.
- **Erasure vs. audit.** The audit table cannot be deleted from, and that blocks deleting a tenant that has audit history. A deliberate export-then-erase process is needed and not built. A Postgres superuser can still drop the triggers; the signatures and hash chain are what make that visible.
- **Not deployed.** The SQL stores are tested against PGlite (real Postgres semantics in-process). They have not run on Supabase, and the SQL assumes one connection per store (no transaction helper). No Fly.io or Railway deploy, no key management service (the runtime's signing key would live in one), no approval UI: approvals are decided by calling the store.
- **Policy is a small evaluator, not OPA or Cedar.**
