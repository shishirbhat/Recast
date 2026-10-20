# Credential and permission boundary review

**Reviewer:** the engineering agent that built the code, on 2026-10-19 at the commit after `d5e3bb4`. **This is not an independent or external review.** It is a structured internal pass: a list of every credential and permission boundary, the code that enforces each, the test that shows it, and what this pass found and fixed. An external review is still needed before any public release (`docs/RELEASE_STATES.md`).

## 1. Credentials: where each one lives and who can use it
| Credential | Created by | Stored | Who can read it | Sent to | Lifetime and revocation | Evidence |
|---|---|---|---|---|---|---|
| API key `sk_live_…` | `recast-keys key issue` | **hash only** (`api_keys.key_hash`) | nobody after issue; shown once | the Recast API (Authorization) | revoke takes effect on the next request | `apps/api/test/postgres.test.ts`, `api-core/test/sql.test.ts` |
| `RECAST_API_KEYS` (dev, no database) | operator | environment, plain | the API process | — | process restart | local and tests only; refused alongside `DATABASE_URL` in practice |
| Destination OAuth tokens (Google, Notion) | tenant (stored as given; no OAuth flow yet) | `api_credentials`, AES-256-GCM, AAD bound to tenant and destination | the placement path only; no endpoint returns them | only allowlisted provider hosts; no redirects; 10 s timeout | overwrite or delete the row; no refresh flow yet | `api-core/test/place.test.ts` (sealed, row moved to another tenant fails) |
| `RECAST_CREDENTIALS_KEY` | operator | environment | the API process | — | **no rotation yet** (open, §4) | D12 |
| Agent private key (Ed25519) | `agent-auth init` / `create` on the agent's machine | `~/.agent-auth/keys/<name>.json`, mode 600 | that machine's user | **never sent**; only signatures leave | revoke the agent at the gateway | `agent-runtime/test/cli.test.ts`, `apps/agent-server/test/pilot.test.ts` |
| Agent token | signed per connection by the agent's key | not stored | — | the gateway only; **never forwarded upstream** | ≤ 900 s (bridge: 300 s); `jti` revocation list | `agent-runtime/test/gateway.test.ts` |
| Proof (DPoP-style) | per request | replay cache | — | the gateway | 120 s window, single use | `proof.test.ts` |
| Runtime audit signing key | operator | environment (`RUNTIME_SIGNING_KEY`) | the runtime process | — | whoever holds it can write a valid chain (D7) | `verifyChain` tests |
| Runtime admin token | operator | environment (`ADMIN_TOKEN`, ≥ 24 chars) | the runtime process; the control center server (`RUNTIME_ADMIN_TOKEN`) | the runtime's `/admin/*` only | rotate by redeploy; **acts for every tenant** (§4) | constant-time compare, `server.test.ts` |
| Upstream tool credentials (vault) | tenant (BYOK) | environment JSON (`RECAST_VAULT`) behind `CredentialVault` | the gateway | the configured upstream only, per call | redeploy; secrets manager later | gateway tests: upstream sees only the vault credential |
| Session cookie (local accounts) | sign-in | browser; HMAC-signed | — | the control center | 8 h; `httpOnly`, `SameSite=Lax`, `Secure` in production | `apps/web/test/session.test.ts` |
| Passwords (local accounts) | operator | scrypt hashes in `RECAST_LOCAL_USERS` | — | — | 5 failures lock the email for a while | `postgres.test.ts` |
| Supabase session | Supabase Auth | browser cookies | — | the control center | HS256 only (no `none`, no key confusion); `aud` and `role` checked; refreshed in the proxy | `session.test.ts`, stand-in Supabase tests |
| Model provider keys | — | **none held by Recast** | — | — | agents bring their own; the gateway is not in the model path | `docs/17-agent-pilot.md` |

No platform master key is distributed. Credentials are never written to the audit log (`redact` covers token, secret, password, authorization, key and credential fields). No endpoint returns a stored credential.

## 2. Permission boundaries: who decides, and where it is enforced
| Boundary | Enforced by | Default | Evidence |
|---|---|---|---|
| A person's own data (objects, grants, history) | Postgres RLS, `owner = auth.uid()`; the control center runs each request as the person (`withUser`) | deny | `packages/store` RLS tests; two people on one database (`apps/web/test/postgres.test.ts`) |
| Tenant data (keys, usage, placements, agents, Spaces, audit) | RLS (`is_member`) for people; explicit tenant filters in service-role stores | deny | store and agent-runtime SQL tests |
| API key → tenant | key hash lookup; revoked keys refused | 401 | api-core |
| Release state → capability | server check per request (API, gateway) from `tenants.cohort`; **not an authorisation boundary on its own** | new tenants `public` | `release.test.ts`, `spaces.test.ts` |
| Consent for a placement | core `checkConsent`: confirm or a ≥ 600 ms hold for anything that notifies or is risky | refuse | core, api-core |
| Agent → tool call | token + proof → scope (calls, expiry, constraints) → Space (tools, budget, expiry, stop) → policy (deny beats approval beats allow) → audit before acting | deny | gateway tests, pilot |
| Approval → one exact request | hash of tenant, agent, tool, action, parameters (and Space); single use; 15 min | pending | gateway, pilot |
| Control center → Agent Runtime (operator token) | **sign-in required and membership of the runtime tenant** (fixed in this review) | refuse | `apps/web/test/postgres.test.ts` |
| Outbound calls from placements | host allowlist, `redirect: "error"`, timeout | refuse | api-core |

## 3. Findings in this review
| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| R1 | A control center configured with `RUNTIME_*` but **without sign-in** served the runtime with its operator token to anonymous visitors: they could approve agent actions, stop Spaces and read the audit | **high** | a live runtime link requires a non-demo session and a database, or the page refuses to serve | "without sign-in, a runtime link is refused outright…" |
| R2 | With sign-in, **any signed-in person** could act on the runtime tenant; nothing tied people to that tenant | **high** (multi-user) | membership of `RUNTIME_TENANT_ID` is checked under the person's own identity (`is_member` through RLS) for every page and action | member can stop a Space under their name; non-member refused and nothing reaches the runtime |
| R3 | The gateway forwarded to upstream tools **without a timeout**: a hung tool held requests open indefinitely | medium (availability) | 30 s timeout; unknown outcome audited; budget kept | `agent-runtime/test/spaces.test.ts` |
| R4 | Malformed Space input (`tools: [null]`) caused a 500 instead of a 400 | low | validated as objects first | `spaces.test.ts` |
| R5 | `max`/`min` constraints on **strings** always refused (fail-closed bug found by the pilot) | low (usability) | they now bound the string's length, as for lists | `bridge.test.ts` |
| R7 | The SDK and the MCP server's remote mode defaulted to `https://api.recast.dev`, a domain this project does not control: a developer who left out `baseUrl` would have sent their API key to whoever owns it | **high** (before any release) | no default: the SDK requires `baseUrl`, and MCP remote mode refuses to start without `RECAST_API_URL`; the API's landing page uses the `api.recast.example` placeholder | `packages/sdk/test/mechanics.test.ts`, `packages/mcp/test/mcp.test.ts` |
| R6 | Dependency audit: production dependencies clean (`pnpm audit --prod`: none). **Dev tooling:** vitest/@vitest/mocker (moderate), tinypool (2 critical, prototype pollution in worker options), braces (high, via the overlay's build tooling) | dev-only | not fixed here: vitest 4 is a major upgrade across all packages; to do as its own change | — |

Found and fixed earlier, recorded for completeness:
- The MCP client hung on a 202 (D9).
- The proxy repository answered `then`.
- `tools/list` leaked tools outside an agent's scopes.
- Audit erasure conflicted with append-only storage (D7, erasure receipts).

## 4. Open risks (accepted for now, with what would close them)
- **Global operator token.** The runtime admin token acts for every tenant, and `/admin/agents/revoke` is not tenant-scoped. To close: per-tenant operator credentials, or the control center talking to the runtime as the signed-in person.
- **Single credentials key, no rotation.** To close: envelope encryption with a KMS (D12).
- **Environment-held secrets** (vault, signing key, admin token). To close: a secrets manager behind the existing interfaces once hosted (#21).
- **Audit signing key holder can rewrite history.** Detection depends on an exported head hash (D7). To close: external anchoring.
- **No OAuth flow** for destinations: tokens are stored as given, with no refresh or scope checks. Needs the OAuth apps (#22).
- **Gateway bypass:** an agent holding credentials directly is outside every check here (`docs/17-agent-pilot.md`).
- **Not externally reviewed,** no penetration test, no fuzzing. These are required before `public`.
- **Dev dependency advisories** (R6).

## 5. Rules this review holds the code to
- A credential has exactly one place it is stored and one kind of holder. None is returned by an endpoint or written to a log.
- Every check that matters runs on a server and fails closed. A UI hiding something is never the control.
- An operator credential is only ever used on behalf of someone the server has identified and authorised.
- Anything that acts on a person's behalf is audited **before** it acts, and refuses if it cannot audit.
