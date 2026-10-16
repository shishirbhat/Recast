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
- `Idempotency-Key`: same key and body replays the first answer without counting again; same key with a different body is `422`; the same key while the first request is still running is `409` with `Retry-After: 1`; a request that failed frees its key for a retry. Keys are per tenant and last 24 hours.
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

## Running on Postgres
Set `DATABASE_URL` and `apps/api` keeps keys, monthly usage, corrections, rate-limit buckets and idempotency records in Postgres (the Supabase migrations), through the `pg` driver. Without it, keys come from `RECAST_API_KEYS` and counts stay in memory, for local use and tests.

Because limits and idempotency are in the database, every instance enforces the same numbers. The token bucket is one locked row per tenant (`take_token`), so concurrent requests cannot spend the same token; an idempotency key is claimed before the work runs (primary key on tenant and key), so of two simultaneous requests exactly one runs. Tested with two API instances on one database (`packages/api-core/test/shared-state.test.ts`). `select purge_api_state(<now ms>)` clears expired records and idle buckets; run it on a schedule. This costs one or two database round trips per request; a Redis/Upstash limiter can replace `SqlRateLimiter` behind the same `Limiter` interface when traffic needs it.

Keys are issued with a command, never by hand:
```
DATABASE_URL=postgres://... pnpm --filter @recast/api keys tenant create "Acme" --tier pro
DATABASE_URL=postgres://... pnpm --filter @recast/api keys key issue <tenant-id> --label prod   # printed once, only the hash is stored
pnpm --filter @recast/api keys key list <tenant-id>      # hash prefix, status, date, label
pnpm --filter @recast/api keys key revoke <key-or-hash>  # takes effect on the next request
pnpm --filter @recast/api keys tenant set <tenant-id> --tier scale --corrections-opt-in
```
Tested end to end (`apps/api/test/postgres.test.ts`): every migration in a Postgres wire server, the command run as a separate process, then the built Next.js server: an issued key resolves, usage is counted in the database, corrections are stored only for the opted-in tenant, a tier change applies on the next request, and a revoked key is refused at once. Pool settings: `DATABASE_POOL_MAX` (default 5), `DATABASE_IDLE_TIMEOUT_MS` (default 10000).

## `POST /v1/place` and `POST /v1/place/undo`
Resolving says what a piece of text is and where it could go. Placing does it: a Gmail draft, a calendar attendee or location, a sheet row, a task, a Notion page.

```json
POST /v1/place
{ "input": { "raw": "Meera Iyer, meera@x.com" },
  "target": { "destination": "google_calendar" },
  "destination_target": { "calendar_id": "primary", "event_id": "abc123" },
  "consent": { "kind": "confirm" },
  "object_id": "rc_..." }
→ 201 { "status": "placed", "receipt": { "id": "rc_r_...", "effect": "Add attendee", "reversible": true, ... }, "object": {...}, "data_moved": [...], "risk": "medium" }

POST /v1/place/undo  { "receipt_id": "rc_r_..." }  → 200 { "status": "undone", ... }
```
What happens, in order: the text is resolved again on the server; if `object_id` (from the resolve you showed the person) no longer matches, `409 object_changed` and nothing moves. The core plans the operation and checks consent: anything that notifies someone or is risky needs `confirm` or a `hold` of at least 600 ms, otherwise `403 consent_required` with the reasons. The tenant's destination token is unsealed and the bridge runs. Then the receipt is stored for undo. Undo is claimed atomically, so two concurrent undos run the bridge once; a failed undo can be retried.

Safety built in: bridges reach only the five destination hosts, over HTTPS, with no redirects and a 10 s timeout. Gmail always uses the token owner's own mailbox, so a caller cannot name another. Target fields are checked (no control characters). A destination that refuses the token is `502 destination_unauthorized` ("reconnect"), and the SDK does not retry it. Placements count one resolution each and honour `Idempotency-Key`, and a failed attempt frees the key.

Credentials: `RECAST_CREDENTIALS_KEY` (32 random bytes, base64; `recast-keys credentials-key generate`) seals each token with AES-256-GCM, bound to its tenant and destination, before it reaches the database. `printf %s "$TOKEN" | recast-keys credential set <tenant-id> gmail` stores one. Without the key, `/v1/place` answers `501`. SDK: `recast.place({...})`, `recast.placements.undo(id)`.

Tested against a stand-in Google over real HTTP (`packages/api-core/test/place.test.ts`, `packages/sdk/test/place.test.ts`, `apps/api/test/postgres.test.ts`). **Not run against real Google or Notion:** that needs OAuth apps (task #22). Tokens are stored as given. There is no refresh-token flow yet, so a Google access token works for about an hour.

## MCP server (`packages/mcp`)
Agents reach Recast as tools. `@recast/mcp` exposes two read-only tools: `resolve_object` (raw text in; typed object, provenance and routing out) and `list_destinations`. Nothing is placed in any app; acting on an answer stays a separate, consented step.

- **Local mode** (no key): the resolve engine runs inside the server process.
- **Remote mode** (`RECAST_API_KEY`, optional `RECAST_API_URL`): calls the hosted API, so the tenant's limits, quota and consent apply. API errors become tool errors the model can read ("Recast API 429 rate_limited ... Retry after 2 s."), never crashes.
- **Transports**: stdio for desktop agents (`pnpm --filter @recast/mcp start`), Streamable HTTP for hosted agents (`start:http`, `POST /mcp`, `GET /healthz`, 64 KB body cap).

Claude Desktop or any stdio client:
```json
{ "mcpServers": { "recast": { "command": "npx", "args": ["tsx", "/path/to/Recast/packages/mcp/src/stdio.ts"], "env": { "RECAST_API_KEY": "sk_live_..." } } } }
```
Tested with the official MCP client (`packages/mcp/test/mcp.test.ts`): in memory, over Streamable HTTP, over stdio with the real binary as a child process, and in remote mode through the real API core (same answers as local mode; bad key and outage become tool errors). Behind the Agent Runtime gateway, these tools get identity, scopes, policy and the signed audit like any other upstream.

## Not done, stated plainly
- **Embedding and model stages are untested against real providers.** The cascade logic is tested with scripted stand-ins; the quality and cost of real stages are unmeasured. The bundled local embedder compares character patterns, not meaning.
- **Nothing is deployed.** No Vercel project, no domain, no Upstash/Qdrant.
- Not built yet: `/v1/enrich`, `/v1/place`, `/v1/graph`, an MCP server wrapper, a key-issuing dashboard, billing.
- The ontology has no Org type; relative dates ("Friday") are refused rather than guessed.
- Next.js builds with `--webpack` because Turbopack cannot yet map the core's `./x.js` imports to TypeScript.
