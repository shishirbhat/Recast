# Performance and reliability budget

Budgets are what we hold the product to. Measurements are what this repository shows today, on one machine, over loopback, with in-process Postgres (PGlite, WebAssembly, single-threaded). **No measurement here is from a hosted deployment, a real provider or a real network.** Hosted numbers will be higher: every database round trip and every provider call adds network time.

Reproduce: `pnpm --filter @recast/bench bench` (`bench/run.ts`, `BENCH_N` sets the sample size). Harness numbers come from `apps/harness` (Chromium).

## Latency
Measured 2026-10-19, Node 22.22, n = 300 (placement n = 200), milliseconds.

| Path | Budget (hosted) | Measured p50 | Measured p95 | Measured p99 | Notes |
|---|---|---|---|---|---|
| Grab → preview ghost painted (harness) | p95 < 150 | 7.4 | 11.5 | — | `docs/08-layer2-interaction.md`, Chromium |
| Release → receipt toast painted (in-page destination) | p95 < 1000 | 8.1 | 10.3 | — | same |
| Resolve, rules engine alone | p95 < 5 | 0.01 | 0.01 | 0.05 | no model stages configured |
| `POST /v1/resolve` over HTTP, memory stores | p95 < 100 | 1.57 | 2.09 | 4.89 | key lookup, limiter, quota, half with idempotency keys |
| `POST /v1/resolve` over HTTP, Postgres stores (PGlite) | p95 < 100 | 4.52 | 6.42 | 8.40 | key, `take_token`, usage, idempotency in the database |
| `POST /v1/place` (Gmail draft), Recast's own time | p95 < 150 *excluding the provider* | 1.30 | 2.28 | 4.43 | fake Google on loopback; the provider's own latency is extra |
| Gateway overhead per tool call, memory stores | p95 < 50 | 2.27 | 4.75 | — | token and proof verification, scope, Space, policy, two signed audit entries |
| Gateway overhead per tool call, Postgres stores (PGlite) | p95 < 50 | 10.87 | 15.57 | — | about 10 queries per call (agent, replay, scope, Space, reserve, consume, audit ×2); it scales with database round-trip time |

**What the numbers say:**
- The gateway's cost is dominated by its database writes: an audit before and after, and atomic budget reservations. These are deliberate (fail closed, no lost counts).
- With a hosted database at 1–2 ms per round trip, expect roughly 15–30 ms of overhead per tool call. That is inside budget, but it is the first thing to measure once hosted (task #21).

**Not measured yet:**
- cold starts (Vercel functions, Next.js);
- the control center's page loads on Postgres;
- throughput under concurrency beyond the atomicity tests;
- the extension on real pages;
- the model stages (no key, task #25);
- native Windows.

## Limits (configured)
| Limit | Value | Where |
|---|---|---|
| API body | 512 KB | `api-core/src/api.ts` |
| Batch size | 50 items | same |
| Resolve input | per `packages/resolve` (`input_too_large` → 413) | resolver |
| Destination call timeout | 10 s | `api-core/src/place.ts` `fetchTransport` |
| Gateway body | 256 KB | `agent-runtime/src/gateway.ts` |
| Gateway → upstream timeout | 30 s (`upstreamTimeoutMs`) | same; **added with this budget**: before, a hung tool held the request open |
| Agent token lifetime | ≤ 900 s (the stdio bridge uses 300 s) | `token.ts`, `bridge.ts` |
| Proof replay window | 120 s | `proof.ts` |
| Approval lifetime | 15 min, single use | `approvals.ts` |
| Space lifetime | ≤ 30 days | `space.ts`, database check |
| Rate limits and quotas | per tier | `api-core/src/tiers.ts` |

## Reliability: what happens when things fail
| Failure | Behaviour | Evidence |
|---|---|---|
| Provider times out or the connection drops **after a write was sent** | `outcome_unknown` (202). Never reported as success, never retried. `POST /v1/place/reconcile` asks the provider, read-only | api-core placement tests (fake Google that hangs after writing) |
| Provider refuses the connection before anything was sent | `failed` (502), safe to retry | api-core placement tests (refused connection) |
| Same placement sent twice (retry, double click) | stable event id: the second is `409 already_placed`; idempotency keys replay the first answer | api-core, SDK |
| Two undos at once | one runs; the other gets `409 undo_in_progress` | api-core |
| Upstream tool hangs (agent gateway) | 504 after 30 s, audited as failure with "outcome unknown"; the Space's money stays spent; the agent is told to check first | `agent-runtime/test/spaces.test.ts` |
| Upstream tool refuses (JSON-RPC error or 4xx) | the money comes back; the call still counts | same |
| Audit log cannot be written | the gateway refuses to act (503); nothing is forwarded | `agent-runtime/test/gateway.test.ts` |
| Two concurrent calls race for the last budget unit | exactly one wins (row lock, single statement) | Space, scope and rate-limit concurrency tests on PGlite |
| A second API instance | limits, quotas and idempotency are shared through Postgres | `api-core/test/shared-state.test.ts` |
| Model stage slow or failing | circuit breaker; rules-only answer marked `degraded` | `packages/resolve` (scripted stand-ins only) |
| Release state narrowed after placements exist | undo and reconcile still work; only `disabled` stops them | `api-core/test/release.test.ts` |

## Gaps (not done)
- No load test and no soak test. The numbers above are single-client latencies.
- No production telemetry (traces, error rates, SLOs). These need a deployment (task #21).
- PGlite is not hosted Postgres: one in-process connection, no network, no contention from other tenants.
- Budgets are not enforced in CI. Timing assertions on shared CI runners would be flaky. The bench is run by hand, and this table is updated when a capability changes.
