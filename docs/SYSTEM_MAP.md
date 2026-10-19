# System map (the code as it is)

Commit at time of writing: see `docs/ENGINEERING_STATUS.md`. Verification levels used below:

- **U:** unit-tested
- **H:** local browser harness or local HTTP/Postgres-wire integration
- **F:** tested against a reference or fake provider
- **R:** real external provider
- **P:** real people

Nothing in this repository has reached **R** or **P** yet.

```
                         schema/ (JSON Schema)  ──generate──▶  packages/core (pure)
                                                                    ▲   ▲   ▲   ▲
        ┌──────────────── consumer ───────────────┐                 │   │   │   │
        │ apps/extension ─▶ packages/extract-web ─┼─ candidates ────┘   │   │   │
        │ apps/harness ─▶ packages/interaction ───┼─ propose/plan/commit┘   │   │
        │              ─▶ packages/overlay        │                         │   │
        │ apps/spike-win (Windows probes only)    │                         │   │
        └─────────────────────────────────────────┘                         │   │
        ┌──────────────── API / SDK ──────────────┐                         │   │
        │ packages/sdk ─HTTP─▶ apps/api ─▶ packages/api-core ─▶ packages/resolve │
        │ packages/mcp (stdio/HTTP) ─▶ packages/resolve (local) or apps/api      │
        │ api-core place ─▶ packages/bridges ─HTTPS─▶ Google/Notion (fake only)  │
        └─────────────────────────────────────────┘                             │
        ┌──────────────── agents ─────────────────┐                             │
        │ MCP client ─▶ apps/agent-server (/mcp) ─▶ packages/agent-runtime gateway┘
        │                          └─▶ upstream MCP tool server (local test servers only)
        └─────────────────────────────────────────┘
        ┌──────────────── people's workspace ─────┐
        │ apps/web (Next.js) ─▶ packages/store ─▶ Postgres (RLS)                 │
        │                    ─▶ packages/runtime-client ─HTTP─▶ apps/agent-server │
        └─────────────────────────────────────────┘
```

## 1. Consumer path
Screen element → extraction → evidence and object → composition of pieces (capsule) → resolution → destination proposal → risk and consent → confirmation → destination execution → receipt → reversal.

| Step | Component | Interface | Where | Verified | Notes |
|---|---|---|---|---|---|
| Point at an element | `packages/extract-web/src/element.ts` (`classifyElement`) | DOM element → candidates | local, in page | U, H (labelled corpus) | browser DOM only; no native capture |
| Page extraction | `packages/extract-web/src/{extract,dom,signals}.ts` | Document → candidates with evidence | local | U, H | JSON-LD, OG, `citation_*`, DOM rules |
| Browser extension | `apps/extension/src/{page,popup}.ts` | popup lists what the page holds | local | U | **Does not include the overlay or placement.** Extraction and display only |
| Resolve to object | `packages/core/src/resolve.ts` | candidate → `SemanticObject` (content id, per-field confidence and evidence) | local | U | |
| Pick pieces | `packages/extract-web/src/element.ts` (`classifyPiece`) | element → time, place or title `Fragment` | local | U, H | |
| Compose fragments | `packages/core/src/compose.ts` (`compose`, `readTime`) | fragments + context → values with origins, missing, conflicts, assumptions, candidate | local, pure | U, H | |
| Capsule gesture | `packages/interaction` (capsule, `completing` phase) | collect, park, approach, complete, place | local, pure | U, H | |
| Interaction state machine | `packages/interaction/src/{machine,view}.ts` | `reduce(state, event) → {state, effects}`; `selectView` | local, pure | U (32) | single object per carry today |
| Overlay | `packages/overlay/src/{components,store,motion}.tsx` | `mountOverlay({onUndo}).update(view)` | local, shadow DOM | H | |
| Propose, plan, risk | `packages/core/src/{propose,trust,operate}.ts` | `propose(obj, contract)`, `plan`, `assessRisk`, `checkConsent` | local | U | consent: release, confirm or hold ≥600 ms |
| Commit and undo | `packages/core/src/operate.ts` | `commit(op, consent, {bridge, log})`, `undo` | local | U, H | log is in memory in the harness |
| Destinations in the harness | `apps/harness/src/main.ts` | in-page fake event editor, compose box and task list | local | H | not real apps |
| Real destinations | `packages/bridges/src/specs.ts` | request builders for Calendar, Gmail draft, Sheets, Tasks and Notion | — | U, F | never called against real Google or Notion |
| Windows shell | `apps/spike-win/` | measurement probes (`main.cjs`, `uia-probe.ps1`) | — | none | not run on Windows; no native shell exists |

**End to end today:** grab, carry, preview, place and undo work only in the harness, against in-page stand-ins (**H**). No path reaches a real app.

## 2. API and SDK path
**Resolution** (read-only): developer app → `packages/sdk` (`Recast.resolve`) → HTTP → `apps/api` (`app/v1/[...path]/route.ts`) → `packages/api-core` (`createApi().handle`) → key auth (hash lookup) → release gate (`packages/release`, tenant cohort) → `Limiter` → monthly quota → `IdempotencyStore` claim → `packages/resolve` (rules → optional embedder → optional LLM) → `toWire` → usage recorded.

**Execution** (writes to a third party, separate): `POST /v1/place` → re-resolve via `resolver.prepare` (or a complete `object`, checked by `deserialize`) → object-id check → `plan` → `checkConsent` → `CredentialStore` (AES-GCM sealed) → `HttpBridge` + `fetchTransport` (host allowlist, no redirects, 10 s timeout) → receipt in `PlacementStore`. `POST /v1/place/undo` claims the receipt atomically, then runs the bridge's undo. Placements record the lifecycle; a write with no answer is stored as `outcome_unknown` and settled by `POST /v1/place/reconcile` (read-only).

| Component | Location | Local / remote | Verified |
|---|---|---|---|
| Resolve engine | `packages/resolve/src` | local library; also inside the API | U (42 labelled dev strings, not held-out), latency bench |
| API core | `packages/api-core/src/{api,stores,sql,limiter,place,admin}.ts` | server | U, H (Postgres wire, two instances on one DB), F (fake Google) |
| API app | `apps/api` | Next.js server | H (built server, Postgres wire) |
| SDK | `packages/sdk/src` | client library | H (real API over HTTP) |
| MCP server | `packages/mcp/src` | local process (stdio or HTTP) | H (official MCP client: memory, HTTP, stdio) |
| Key command | `apps/api/scripts/recast-keys.ts` → `api-core/admin.ts` | operator CLI | H |

## 3. Agent path
Agent's MCP client → `apps/agent-server` `/mcp` → `packages/agent-runtime/src/gateway.ts`:
- verify the agent token (`token.ts`), the DPoP-style proof (`proof.ts`), revocation and replay;
- check a live scope with calls left (`scope.ts`, `SqlScopeStore.consume_scope`);
- evaluate the policy, where deny beats approval beats allow, default deny (`policy.ts`);
- for approval, the store is bound to a request hash (`approvals.ts`);
- **audit the decision before forwarding** (`audit.ts`, `SqlAuditStore`), failing closed;
- exchange credentials: a vault credential for the upstream; the agent's Authorization is never forwarded (`exchange.ts`);
- forward to the upstream MCP server;
- audit the outcome.

Admin: `apps/agent-server/src/server.ts` `/admin/*` (constant-time admin token) for agents, scopes, policy, approvals, revocation and audit. Control center: `packages/runtime-client` → admin API.

Verified: U (crypto, gateway, policy, CLI), H (official MCP client through the gateway to a real local MCP server; deployable server over the Postgres wire protocol). **Not built:** Spaces (budgets including spending, expiry per Space, stop control), a stdio bridge for desktop MCP clients, onboarding. Tasks P4.

## 4. Persistence: what lives where
| Data | Store | Isolation enforced by | Notes |
|---|---|---|---|
| People's objects, relationships, integrations, grants, history | Postgres `objects`, `relationships`, `integrations`, `grants`, `audit_events` (`init.sql`) | RLS, `owner = auth.uid()`; server runs each request with `withUser` | Demo mode: in-memory, lost on restart |
| Harness interaction log | memory | — | test bench only |
| API tenants (with release `cohort`), keys, usage, corrections | `tenants`, `tenant_members`, `api_keys` (hash only), `api_usage`, `api_corrections` (`api.sql`) | service role plus RLS for members; corrections require opt-in (trigger) | without `DATABASE_URL`: memory |
| Rate limits, idempotency | `api_rate_buckets`, `api_idempotency` (`api_shared_state.sql`) | service role only (RLS, no policies) | shared across instances |
| Destination credentials | `api_credentials`, sealed (`placements.sql`) | AES-GCM bound to tenant and destination; no user policies | key from `RECAST_CREDENTIALS_KEY` |
| Placement receipts | `api_placements` | members may read their tenant's rows | |
| Agents, scopes, policies, approvals, revocations, proof replay | `agents`, `agent_scopes`, `agent_policies`, `agent_approvals`, `agent_revoked_tokens`, `agent_dpop_seen` | tenant RLS; scopes consumed atomically | |
| Agent audit | `agent_audit_log` (signed entry stored whole) | append-only triggers, unique `prev_hash` | erasure only via `erase_tenant` with a receipt (`tenant_erasures`) |

Where checks happen:
- **Tenant isolation:** Postgres RLS, plus explicit tenant filters in service-role stores.
- **Credentials:** sealed at rest; never returned by any endpoint; never forwarded to agents.
- **Idempotency:** `api_idempotency` (API).
- **Release states:** the API, from `tenants.cohort` (`docs/RELEASE_STATES.md`); not an authorisation boundary on its own.
- **Usage and limits:** `record_usage`, `take_token`.
- **Agent call budgets:** `consume_scope`.
- **Audit:** the gateway, before and after forwarding.

## 5. Contracts between layers
| Contract | Defined in | Consumers |
|---|---|---|
| Object envelope, evidence, confidence | `schema/common/*.schema.json` → `packages/core/src/generated` | everything |
| Capability contract (destination) | `schema/contracts/capability.schema.json` | core, bridges, resolve, interaction |
| Wire resolve shape (snake_case) | `packages/resolve/src/wire.ts` | API, SDK, MCP |
| Agent token, proof and audit entry | `packages/agent-runtime/src/{token,proof,audit}.ts` | gateway, server, CLI, control center |
| Action lifecycle and operation capabilities | `packages/core/src/lifecycle.ts` (`ActionStatus`, `TRANSITIONS`, `OperationCapabilities`, `OutcomeUnknownError`) | core, bridges, api-core placements; agent runtime to adopt (P4) |
