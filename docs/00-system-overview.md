# 00. System overview: how Recast works, end to end

This is my understanding of the whole product: what it is, how the pieces fit, how a request moves through them, what the data looks like, and what is real today versus what still needs accounts, hardware or people. Every other doc goes deeper on one part; start here.

## 1. The product in plain words
Software is full of *things*: a person in an email, an event on a web page, an address, a product, a paper. Today moving a thing from one app into another means copying text and retyping it. Recast understands what the thing **is** (a Person with a name and email, an Event with a start time) and what it can **become** in the destination (an attendee, a calendar event, a task, a row), then does that safely, shows you exactly what will change, and lets you undo it.

The company sells that understanding in two directions:

| Surface | Who uses it | What they get |
|---|---|---|
| **Recast for people** (desktop overlay, browser extension, web control center) | End users | Grab a thing, drag it onto an app, preview, place, undo. Local-first. This is also the data flywheel (corrections, with consent). |
| **Recast API + SDK** (`/v1/resolve`, `/v1/place`, `@recast/sdk`, `@recast/mcp`) | Developers and AI products | Send raw text, get back a typed object plus where it can go. B2B revenue by tier. |
| **Agent Runtime** (gateway, server, control-center pages) | Companies running AI agents | Each agent gets an identity, narrow scopes, a policy, human approvals for risky calls and a tamper-evident signed audit log. Sits in front of MCP tool servers. |

All three run on one spine: **one schema, one pure core, one trust model**.

## 2. Architecture

```
                            ┌──────────────────────── schema/ (JSON Schema, source of truth) ───────────────────────┐
                            │  objects · relationship grammar · capability contracts · provenance/evidence/risk       │
                            └──────────────┬──────────────────────────────────────────────────────────────────────────┘
                                           │ generated types + validators (pnpm gen)
                                ┌──────────▼──────────┐
                                │  @recast/core (pure) │  perceive → resolve → propose → plan → commit / undo
                                │  trust model, risk,  │  no network, disk, clock or randomness of its own
                                │  canonical JSON      │
                                └───┬──────┬──────┬────┘
           ┌────────────────────────┘      │      └──────────────────────────────┐
  ┌────────▼─────────┐        ┌────────────▼───────────┐               ┌──────────▼───────────┐
  │ PEOPLE SURFACE   │        │ API SURFACE            │               │ AGENT SURFACE        │
  │ extract-web      │        │ @recast/resolve        │               │ @recast/agent-runtime│
  │ interaction (FSM)│        │  rules→embed→LLM       │               │  identity, tokens,   │
  │ overlay (React)  │        │ @recast/api-core       │               │  DPoP proofs, scopes,│
  │ apps/extension   │        │  auth, limits, quota,  │               │  policy, approvals,  │
  │ apps/harness     │        │  idempotency, versions │               │  signed audit chain, │
  │ apps/spike-win   │        │ apps/api (Next.js)     │               │  MCP gateway         │
  │ apps/web control │        │ @recast/sdk            │              │ apps/agent-server    │
  └────────┬─────────┘        └────────────┬───────────┘               └──────────┬───────────┘
           │                               │                                      │
           └───────────────┬───────────────┴────────────────┬─────────────────────┘
                  ┌────────▼─────────┐              ┌───────▼────────────────────────┐
                  │ @recast/bridges  │              │ Postgres (Supabase) + RLS      │
                  │ Calendar, Gmail, │              │ packages/store, *Sql* stores   │
                  │ Sheets, Tasks,   │              │ supabase/migrations/*.sql      │
                  │ Notion (HTTP)    │              │ tested on PGlite + real pg wire│
                  └──────────────────┘              └────────────────────────────────┘
```

### Every package and app
| Path | Role |
|---|---|
| `schema/` | JSON Schema for 9 object types, the relationship grammar, the capability-contract format. `pnpm gen` turns it into TypeScript types and validators. Nothing is hand-duplicated. |
| `packages/core` | The engine. `perceive` reads structured data into candidates; `resolve` turns a candidate into a typed object with per-field confidence and evidence; `propose` lists what the object can become in a destination (from its contract); `plan` builds the exact operation and risk; `commit` executes through an injected bridge and logs; `undo` reverses. Canonical JSON and content ids. |
| `packages/conformance` | Language-neutral golden fixtures and a reference bridge, so any future shell (Rust, Swift, Kotlin) can prove it behaves like the core. |
| `packages/extract-web` | Reads pages: JSON-LD, Open Graph, `citation_*`, DOM rules, plus the element classifier for "point at a name or address". Measured on a hand-labelled corpus. |
| `packages/interaction` | The GRAB → APPROACH → PREVIEW → PLACE state machine as a pure reducer with injected ports (hit tester, clock, bridges). Keyboard path, Esc everywhere, hold-to-confirm for risky placements. |
| `packages/overlay` | React + Tailwind + motion components: the token, landing chips, preview ghost, hold chip, toast with undo. Mountable in Shadow DOM. |
| `packages/bridges` | Destinations as data plus HTTP request builders: Google Calendar, Gmail draft, Google Sheets, Google Tasks, Notion. Each records what it needs to undo. |
| `packages/store` | `Repository` for the control center (memory and SQL), and test helpers that load every migration into PGlite. |
| `packages/resolve` | The `/v1/resolve` engine: rules stage, optional embedding tie-break, optional grounded LLM stage (capped at 0.7 confidence), circuit breaker, wire format. |
| `packages/api-core` | Framework-free HTTP core for the API: key auth (hashed), token-bucket limits, monthly quota, idempotency, versioning headers, corrections with consent. Memory and SQL stores. |
| `packages/sdk` | `@recast/sdk`: typed client with retries, `Retry-After`, cache, idempotency keys, typed errors, fluent builder. |
| `packages/agent-runtime` | Agent identities (Ed25519), short-lived tokens, DPoP-style per-request proofs, scopes with call budgets, policy (allow / deny / require approval), approvals bound to the exact request, hash-chained signed audit, MCP gateway, SQL stores, CLI. |
| `packages/mcp` | `@recast/mcp`: Recast as MCP tools (`resolve_object`, `list_destinations`) over stdio or Streamable HTTP, local engine or hosted API. |
| `packages/runtime-client` | How the control center talks to the runtime server (HTTP or demo). |
| `apps/extension` | Browser extension (MV3) that runs the extractors on real pages. |
| `apps/harness` | Browser test bench: fixture destinations plus the overlay plus the engine, so every interaction flow runs in Chromium. |
| `apps/spike-win` | Windows feasibility kit (global hook, overlay window, UI Automation). Needs a Windows machine; not built here. |
| `apps/web` | Next.js control center: objects, relationships, integrations, permissions, agents, approvals, audit chain, history, privacy. |
| `apps/api` | Next.js app that serves `/v1/*` through `api-core`. |
| `apps/agent-server` | Deployable Node server: the MCP gateway at `/mcp` plus an admin API, on Postgres. |
| `supabase/migrations` | The whole database: user objects, API tenants/keys/usage/corrections, agents/scopes/policies/audit/approvals/revocations/replay cache, all behind row-level security. |

## 3. Workflows, step by step

### A. A person drags a thing (grab to place)
1. **Grab.** The user holds the lift key (desktop) or uses the extension. The classifier outlines things under the pointer; `extract-web` turns the chosen one into a candidate with evidence (which element, which text).
2. **Resolve.** `core.resolve` makes a typed object (say Person: name, email) with a confidence per field. The source is never changed.
3. **Approach.** As the token nears a destination window, the shell asks which destination it is and loads its capability contract. `core.propose` lists allowed relations from the grammar, for example Person → Event = *attendee*; ones missing required fields are shown disabled with a reason.
4. **Preview.** Hovering a chip runs `core.plan`: the exact change, the data that will move, and a risk tier from the trust model. A ghost shows the result before anything happens.
5. **Place.** Low risk places on release. Medium risk needs a deliberate choice. High risk needs a 600 ms hold. Below 0.5 confidence the user must pick explicitly.
6. **Commit.** `core.commit` runs the bridge (e.g. a Calendar PATCH), writes the event log and returns a receipt with what undo needs.
7. **Undo.** A toast offers undo for about 6 s; `core.undo` replays the captured previous state through the same bridge.

### B. A developer calls the API
1. `POST /v1/resolve` with `Authorization: Bearer rk_...`, an optional `Idempotency-Key` and `{ raw, source?, target: { type, destination } }`.
2. `api-core` hashes the key and finds the tenant and tier. It checks the token bucket (429 with `Retry-After`) and the monthly quota (402), and validates the body (size cap, field rules).
3. If the idempotency key was seen in 24 h with the same body, the stored response is returned; with a different body, 422.
4. The resolver runs **rules** first. If rules are unsure and an embedder is configured, embeddings only break ties. If still unsure and an LLM is configured, the LLM may answer, but only with values grounded in the input text and never above 0.7 confidence. If a stage fails or its breaker is open, the answer is marked `degraded` and rules carry on.
5. The answer is one of `resolved` (object, field provenance, destinations it can go to), `ambiguous` (alternatives) or `unresolved` (why). Usage is recorded; headers carry the schema version and any deprecation dates.
6. Optional: `POST /v1/corrections` stores a fix only if the tenant opted in (the database refuses otherwise).
7. The SDK wraps all of this, with retries that reuse the same idempotency key.
8. **Place.** `POST /v1/place` runs steps A.4 to A.6 on the server. It resolves again and refuses if the object changed since the person previewed it. It plans, checks consent, unseals the tenant's destination token and runs the bridge, then returns a receipt; `POST /v1/place/undo` reverses it.

### C. An AI agent calls a tool through the Agent Runtime
1. **Setup (admin).** Create an agent: Ed25519 key pair, the private key stays with the agent, the public key is registered as `agt_...`. Grant scopes (tool, action, constraints, expiry, max calls). Activate a policy.
2. **Token.** The runtime issues a short-lived EdDSA token (≤15 min) bound to the agent's key.
3. **Call.** The agent sends an MCP `tools/call` to `/mcp` with the token and a DPoP-style proof (method, URL, time, a one-time id, a hash of the token), signed by the agent's key.
4. **Checks, in order:** signature, expiry, audience, revocation; proof signature, freshness and replay; a live scope with calls left; policy, where deny beats approval and approval beats allow (default deny).
5. **Audit first.** The decision is appended to the audit chain *before* anything is forwarded. If the audit write fails, the call is refused (fail closed).
6. **Forward.** On allow, the runtime swaps in the upstream credential from its vault (the agent never sees it), strips the agent's Authorization and any cookies, and forwards to the real MCP server.
7. **Outcome.** The result (success or failure) is audited too and returned. `tools/list` only shows tools the agent currently has scopes for.

### D. Approval
1. A call that the policy marks `require_approval` gets a JSON-RPC error `-32004` with an `approval_id`, recorded as pending.
2. A person approves or rejects it in the control center's Approvals page (the server's `/admin/approvals/:id/decide`).
3. The approval is bound to a hash of that exact request; the agent retries the same call and it passes once. Any change to the arguments needs a new approval.

### E. Proving the audit log is untouched
Each entry holds the previous entry's hash and is signed by the runtime key. `verifyChain` (CLI `agent-auth verify-audit`, the control center's Audit chain page) recomputes every hash and signature and reports the first break. The database itself refuses updates, deletes and truncates on the audit table, and a unique `prev_hash` per tenant stops two writers forking the chain.

## 4. Data model (Postgres)
- **People surface** (`init`): `objects`, `relationships`, `integrations`, `grants`, `audit_events`; each row has an owner, RLS limits each user to their own rows, `delete_my_data()` erases a user and logs it.
- **API** (`api`): `tenants` (tier, corrections opt-in), `tenant_members`, `api_keys` (hash only, revocable), `api_usage` (per month, via `record_usage`), `api_corrections` (trigger refuses unless opted in). `is_member(tenant, owner_only)` drives RLS.
- **Agent Runtime** (`agent_runtime`, `runtime_persistence`): `agents` (identity fields immutable, public key must be an Ed25519 public JWK), `agent_scopes` (calls never above max, consumed atomically by `consume_scope`), `agent_policies` (one active per tenant, `activate_policy`), `agent_audit_log` (append-only, whole signed entry stored), `agent_approvals`, `agent_revoked_tokens`, `agent_dpop_seen`.
- **Shared API state and erasure** (`api_shared_state`, `tenant_erasure`): `api_rate_buckets` and `api_idempotency` so every API instance enforces the same limits; `erase_tenant()` and `tenant_erasures`, the single audited path that may remove a tenant's audit history (export first).

## 5. Trust model (shared by all three surfaces)
- Risk comes from the **effect**, not from how confident a model is: adding an attendee who gets an email is riskier than setting a location. Model stages can lower confidence or add alternatives, never lower a risk tier.
- Nothing is mutated without a plan the user (or policy) has seen; everything reversible records how to undo.
- Local-first: the people surface works without an account. Data only leaves the device with sync on; corrections only with opt-in.
- Agents get least privilege by default: no scope, no call; no policy rule, deny.

## 6. Real today versus not yet
**Real and tested** (CI green on every push): the schema and generated types, the core, extractors measured on a labelled corpus, the interaction engine and overlay in Chromium with accessibility scans, bridges as request builders, the full API with SDK over real HTTP, the agent runtime with the official MCP client over real HTTP and Postgres stores over the real Postgres wire protocol, the control center in a real browser, and every migration's RLS rules.

**Needs your accounts, hardware or people** (tracked as tasks #21–#27): a Supabase project and Vercel/host deploy; Google and Notion OAuth apps for live placements; the Windows shell and the spike run on a Windows PC; the ten-person usability test; an embedding/LLM provider key; billing; mobile.

The task list in the side panel tracks the rest of the buildable work (#12–#20) and is ticked off as each piece passes its tests and CI.
