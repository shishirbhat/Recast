# 12. The Recast API layer (resolve, SDK, API server)

Direction set by the founders: the consumer app is the data flywheel; the B2B product is an API that turns raw text into typed, routed objects. This is the first working slice. Market sizes, pricing and revenue figures are the founders' own research and are not checked here.

## What exists
| Piece | Where | What it does |
|---|---|---|
| Resolve engine | `packages/resolve` | Raw text in, typed object out (Person, Event, Location, Product, Paper, Document), with per-field provenance and a route to a destination |
| API core | `packages/api-core` | Auth, rate limits, monthly quota, idempotency, versioning, batch, corrections. Plain Web `Request`/`Response`, so it runs on Vercel, Node or anywhere |
| API server | `apps/api` | Next.js route handlers (`/v1/...`) over the API core, plus a landing page |
| SDK | `packages/sdk` | `@recast/sdk`: typed client, retries, cache, circuit breaker, fluent builder. No dependencies |
| Schema | `supabase/migrations/20260102000000_api.sql` | Tenants, hashed keys, usage, opt-in corrections, with row-level security |

## `POST /v1/resolve`
```json
{ "input": { "raw": "Meera Iyer, meera@x.com", "source_url": "https://example.com/team" },
  "target": { "type": "Person", "destination": "google_calendar" },
  "options": { "confidence_threshold": 0.5, "include_provenance": true } }
```
Answer is one of three shapes, selected by `status`:
- `resolved`: `object` (id, type, fields, confidence, trust, provenance), `routing` (action, bridge, reliability, whether it needs confirmation) or `null` with `route_error`, `alternatives`, `meta.stage`, `degraded`.
- `ambiguous`: `alternatives[]` and a reason. Used when two readings tie, or the best is under the confidence threshold.
- `unresolved`: a reason and sometimes a suggestion ("relative dates like 'Friday' need a full date").

Other endpoints: `POST /v1/resolve/batch` (1 to 50 items, per-item errors), `GET /v1/bridges`, `POST /v1/corrections` (opt-in only), `GET /v1/health`.

Destinations: `google_calendar`, `gmail` (draft only), `google_sheets`, `google_tasks`, `notion`. They use the same contracts and trust rules as the desktop product.

## How a resolve works
1. **Rules** (always on): deterministic patterns for emails, phones, dates (ISO and written), postal addresses, prices, DOI/arXiv, links. Each field carries a confidence and a pointer into the text.
2. **Embedding** (optional, off by default): may only break a tie between two readings the rules found. It cannot invent fields.
3. **Model** (optional, off by default): used only when the rules find nothing usable. Every string it returns must appear in the input or it is dropped, and its confidence is capped at 0.7 so the result always asks before placing.
4. Any optional stage that fails or times out is skipped and the answer says `degraded: true`. A circuit breaker stops calling a stage that keeps failing.
5. Risk is decided by the same effect-based trust model as the desktop app. A guess (confidence under 0.75) is at least "medium": it asks once.

## Limits (configuration in `packages/api-core/src/tiers.ts`)
| Tier | Requests/sec | Burst | Resolutions/month |
|---|---:|---:|---:|
| Free | 10 | 20 | 1,000 |
| Pro | 100 | 200 | 50,000 |
| Scale | 500 | 1,000 | 500,000 |

- Rate limit exceeded: `429` with `Retry-After`. Quota used up: `402` with usage headers. Only `resolved` answers use quota; unresolved, ambiguous and rejected calls are free.
- `Idempotency-Key`: same key and body replays the first answer without counting again; same key with a different body is `422`. Keys are per tenant and last 24 hours.
- Versioning: `/v1/` in the path; optional `X-Recast-Version`. Deprecated versions get `Deprecation` and `Sunset` headers. Every response carries `Recast-Schema-Version`.
- Body limit 512 KB, input text limit 4,000 characters, `Cache-Control: no-store`, errors never include internals.

## Privacy rules built in
- API keys are stored only as SHA-256 hashes.
- Corrections (the learning flywheel) are stored **only** for tenants that opted in. This is enforced in the database by a trigger, even for the service role, and tested.
- Nothing is sent to an embedding or model provider unless one is configured. None is today.

## Measured (this sandbox)
- Rules stage: p50 0.06 ms, p95 0.17 ms, p99 0.40 ms over 2,100 resolves; 100% of the labelled set stays in the rules stage; zero model calls.
- Labelled set: 42 hand-labelled strings, 42 right, 0 false positives. **This is a development set, not a held-out one.** I tuned two rules and corrected one label (marked in the file) after seeing results. Treat it as a regression guard. A real number needs unseen inputs, ideally real traffic.
- 190+ new tests: engine 31, API core 21, SDK 21 (including against the real API over HTTP), API server end to end 4, database 8 (+ the existing 20).

## Not done, stated plainly
- **Embedding and model stages are untested against real providers.** The cascade logic is tested with scripted stand-ins; the quality and cost of real stages are unmeasured. The bundled local embedder compares character patterns, not meaning.
- **No Supabase-backed key or usage store.** `apps/api` takes keys from the `RECAST_API_KEYS` environment variable; with none set every call is `401`. The SQL schema is written and tested, the adapter is not.
- **Nothing is deployed.** No Vercel project, no domain, no Upstash/Qdrant. Rate limits and idempotency are per server instance (in memory), so they need a shared store before running more than one instance.
- Not built yet: `/v1/enrich`, `/v1/place`, `/v1/graph`, an MCP server wrapper, a key-issuing dashboard, billing.
- The ontology has no Org type; relative dates ("Friday") are refused rather than guessed.
- Next.js builds with `--webpack` because Turbopack cannot yet map the core's `./x.js` imports to TypeScript.
