# Engineering status

The single authoritative status. Update it whenever a capability changes level. **Claims here are only what the repository proves.**

## Baseline
| Item | Value |
|---|---|
| Branch | `claude/clever-heisenberg-s3taqj` (local equals `origin`, clean tree) |
| Baseline commit | `97419eb` |
| CI on baseline | GitHub Actions run 25: **success** (install, Chromium, `pnpm gen` with no diff, overlay build, typecheck, full tests) |
| Local, 2026-10-19 | `pnpm install --frozen-lockfile`; `pnpm gen` leaves no diff; `pnpm -r typecheck` passes |
| Local full test | first run: **1 failure**. `packages/conformance` browser test hit its 10 s hook timeout during Chromium's cold start under the parallel run (the same test passes alone in 9.6 s, then 1.8 s). Fixed by explicit test and hook timeouts in every test package. Second run: **18 packages, 550 tests, 0 failures** |
| Commands | `pnpm install && pnpm gen && pnpm -r typecheck && pnpm -r test`; per package: `pnpm --filter <name> test` |

Per-package counts on the baseline:

| Package | Tests | Package | Tests |
|---|---|---|---|
| core | 74 | api-core | 66 |
| interaction | 32 | store | 49 |
| extract-web | 69 | agent-runtime | 72 |
| bridges | 21 | agent-server | 10 |
| conformance | 6 | sdk | 24 |
| overlay | 4 | mcp | 9 |
| resolve | 32 | api | 12 |
| runtime-client | 7 | web | 29 |
| extension | 15 | harness | 19 |

The previously reported harness failures (two capitalisation assertions in Layer 2a) were fixed at the time and have passed in every run since. In the 2026-10-19 run, harness passed 19 of 19.

## Evidence levels (never merged)
| Level | Meaning |
|---|---|
| **U** | unit-tested |
| **H** | local harness: Chromium on local pages, or local HTTP and Postgres-wire integration |
| **F** | against a reference or fake provider (a stand-in Google, Supabase Auth or MCP server) |
| **R** | against a real external provider |
| **P** | with real people |

**No capability is at R or P.** Nothing has run against real Google, Notion, Supabase or Vercel, on Windows, or with real users.

---

## 1. Verified complete (implemented, tests pass, behaviour demonstrated at the stated level)
| Requirement | Implementation | Evidence | Level | Remaining limitation |
|---|---|---|---|---|
| Typed objects with per-field confidence and evidence; content ids; source never mutated | `schema/`, `packages/core/src/{resolve,canonical}.ts` | core tests, conformance in Node and Chromium under a strict CSP | U, H | — |
| Effect-based trust model; consent release / confirm / hold ≥600 ms | `packages/core/src/{trust,operate}.ts` | core tests; harness: 300 ms hold places nothing, 800 ms places | U, H | — |
| Single-object grab → approach → preview → place → undo; keyboard path; Esc everywhere | `packages/interaction`, `packages/overlay`, `apps/harness` | interaction 32; harness 19 (pointer, keyboard, reduced motion, axe light and dark) | U, H | **in-page stand-in destinations only**; one object per carry |
| Element classifier (point at a name, place or address) | `packages/extract-web/src/element.ts` | `corpus/element-eval.mjs`. Dev: Person 92% (11/12), Location 100% (10/10). Held-out (**after** dev fixes, not clean): Person 5/5, Location 8/9. Ordinary text offered at ≥0.5 confidence: 1% | H | small samples; the held-out run is not clean; Location.name page extraction 0/9 on held-out |
| Page extraction | `packages/extract-web` | `docs/07`: held-out frozen, 26/38 page objects (68%), 1 spurious; events 9/9, papers 11/12, people 1/5, places 2/9 | H | people and places weak |
| Resolve engine, rules stage | `packages/resolve` | 42 hand-labelled **dev** strings: 42 right, 0 false positives (regression guard, not a benchmark). Rules p50 0.06 ms | U | no held-out set; embedding and LLM stages tested only with scripted stand-ins |
| API: auth (hashed keys), limits, quota, idempotency, versioning, corrections opt-in | `packages/api-core`, `apps/api` | api-core 66; built server on Postgres wire (12) | U, H | not deployed |
| Shared limits and idempotency across instances | `api_shared_state.sql`, `SqlRateLimiter`, `SqlIdempotencyStore` | two API instances on one database; concurrency tests | H | one or two DB round trips per request (measured: not yet) |
| SDK | `packages/sdk` | 24 tests against the real API core over HTTP | H | not published; no independent developer has used it |
| MCP server: Recast as agent tools | `packages/mcp` | official MCP client in memory, over HTTP and over stdio (child process) | H | — |
| Agent gateway: identity, token, proof, scopes, default-deny policy, approvals bound to request, signed audit before forwarding, credential never forwarded | `packages/agent-runtime` | 72 tests incl. official MCP client to a real local MCP server | U, H, F | not externally reviewed; policy is not OPA/Cedar |
| Deployable runtime server on Postgres | `apps/agent-server` | 10 tests over Postgres wire with the official MCP client | H | Dockerfile never built; not deployed |
| Tenant isolation, append-only audit, erasure via receipt | `supabase/migrations/*`, `packages/store/test/*` | store 49 (RLS, triggers, erasure across 14 tables) on PGlite | U, H | PGlite, not a real Supabase project |
| Control center: sections, privacy export/delete, approvals | `apps/web` | 29 tests incl. axe on every section | H | demo data unless `DATABASE_URL` |
| Control center on Postgres with sign-in (local accounts, Supabase sessions) | `apps/web/{proxy.ts,lib/*}`, `packages/store/src/scoped.ts` | 8 browser tests over Postgres wire; 8 unit; isolation between two people | H, F | Supabase is a stand-in; JWKS (asymmetric) tokens unsupported |

## 2. Implemented but not fully verified
| Requirement | Implementation | What exists | Missing to verify |
|---|---|---|---|
| Destination bridges: Calendar attendee/location, Gmail draft, Sheets row, Tasks task, Notion page | `packages/bridges/src/specs.ts` | request builders, undo tokens, injection guards; F via a fake Google over HTTP (Gmail draft, Calendar attendee) | **R**: needs OAuth apps (task #22). No bridge creates a calendar *event* yet |
| `POST /v1/place` and undo | `packages/api-core/src/{api,place}.ts` | re-resolve, object-id check, consent, sealed credentials, host allowlist, atomic undo claim | R; no OAuth flow (tokens stored as given, no refresh); not under a release gate yet |
| Browser extension | `apps/extension` | extracts the page and lists objects in a popup (15 tests) | **does not include the overlay or placement**; never loaded in a real browser profile by a person |
| Windows interaction | `apps/spike-win` | probes for a global hook and UI Automation, not run | everything: needs a Windows machine (task #23) |
| Audit-chain claims | `packages/agent-runtime/src/audit.ts` | detects edit, delete, reorder and fork without the signing key | stated in `docs/DECISIONS.md` D7; not externally reviewed |
| Interim design system | `design/tokens.css`, overlay | computed contrast; axe clean | final identity pending Modulark/Modulus (`docs/design-direction.md`) |

## 3. In progress
| Requirement | Where | State |
|---|---|---|
| Composition: time + place (+ title) → Event candidate with missing fields, conflicts and per-field origin | `packages/core/src/compose.ts`; schema evidence `origin`, `source`, `original`; capture method `composition` | model and 16 unit tests done (U). The gesture, harness prototype and browser tests are next (P2) |
| System map, decision log | `docs/SYSTEM_MAP.md`, `docs/DECISIONS.md` | written; kept current |

## 4. Not started, or blocked outside the repository
| Item | Blocked on |
|---|---|
| Multi-fragment capture gesture in the interaction engine | P2, next |
| Formal action lifecycle (`proposed … outcome_unknown`) and bridge capability declarations | P3 |
| Calendar event creation with idempotency, duplicate detection and reconciliation | P3 (F); R needs Google OAuth (#22) |
| Release-state registry | in plan |
| Spaces (budgets including spending, expiry, stop), one-command agent onboarding, stdio bridge for desktop MCP clients | P4 |
| API contract tests and compatibility doc | P5 |
| Performance budget for real paths (gateway overhead, end to end) | in plan; only harness and rules latencies measured |
| Recipes and policy packs | P7 |
| Deployments (Supabase, Vercel, runtime host) | the founders' accounts (#21) |
| Real OAuth bridges | the founders' Google/Notion apps (#22) |
| Native Windows shell | a Windows machine (#23) |
| User testing | people (#24) |
| Model-provider stages | a key (#25) |
| Billing | an account (#26) |

## Distinctions to keep
- Browser simulation (harness) is not native Windows behaviour.
- A migration tested on PGlite is not a deployed database.
- An API route that runs locally is not a hosted API.
- A bridge tested against a fake Google is not a connected integration.
- A locally tested policy engine is not a reviewed security boundary.
- SDK tests by the founding team are not developer adoption.
