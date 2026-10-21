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

**One capability is at R:** Google Calendar event creation through `googleCalendarEvent` (sign-in, place, duplicate refusal, check, undo, lost-answer reconciliation), run by the owner by hand on 2026-10-21 against a throwaway Google account from `apps/calendar-link` (see below). Nothing else has run against real Google, Notion, Supabase or Vercel, on Windows, or with real users. Nothing is at P.

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
| Composition: time + place (+ title) into an Event with per-field origin, missing fields, conflicts and visible assumptions; capsule gesture with completion; pointer and keyboard | `packages/core/src/compose.ts`, `packages/interaction` (capsule), `packages/extract-web` `classifyPiece`, `apps/harness/src/compose.html`; `docs/15-composition.md` | core 17, engine 12, extract-web 4, Chromium 7 (journey, missing title, conflict, Esc, keyboard, axe light and dark) | U, H | in-page calendar only; no real calendar; no Windows |
| Action lifecycle shared by placements; declared bridge capabilities; unknown outcomes recorded, never retried, reconciled once | `packages/core/src/lifecycle.ts`, `packages/bridges/src/{http,specs}.ts`, `packages/api-core/src/api.ts`, `supabase/migrations/20260108000000_action_lifecycle.sql` | core 4, bridges 11, api-core 20 placement tests incl. Postgres, SDK 25 | U, H, F | Google is a stand-in; the harness's in-page destinations do not use the lifecycle yet |
| Calendar event creation: stable id, duplicate detection, restore after delete, reconciliation; composed objects placed through the API | `googleCalendarEvent`, `/v1/place` with `object` | see `docs/12-api.md`; `apps/calendar-link` (13 tests, stand-in Google) | U, F, **R** | R covers the local link only, one throwaway account, `primary` calendar, run by hand (owner-reported 2026-10-21: place, place again → one event, check, undo, lost answer → check → place → still one → undo; all five as expected). Not R: `/v1/place`, the extension, other calendars, all-day events, attendees |
| Release states: registry, tenant cohorts, server-side gates on every API endpoint, per-deployment overrides that refuse typos, `/v1/capabilities` | `packages/release`, `packages/api-core/src/api.ts`, `supabase/migrations/20260109000000_release_cohorts.sql`; `docs/RELEASE_STATES.md` | release 4, api-core 8 (memory and Postgres) | U, H | enforced in the API and the agent gateway; control center not yet gated |
| Spaces: bounded agent configuration (tool list with constraints, call and money budgets, ≤30-day expiry, permanent stop, approval bound to parameters and Space); atomic reservation; control-center Stop | `packages/agent-runtime/src/space.ts`, gateway, `SqlSpaceStore`, `supabase/migrations/20260110000000_agent_spaces.sql`, `apps/agent-server` admin, `apps/web` Agents; `docs/16-spaces.md` | agent-runtime 15, agent-server 3 (official MCP client, Postgres wire), web 1 (Chromium) | U, H | spend is as declared by the call; no real provider; off by default (`SPACES_MODE`) |
| Bounded agent pilot: `agent-auth init` (local key, register public half), `agent-auth connect` stdio bridge (fresh proof per request), approvals via `_meta`, two local tools, activity, revoke; BYOK and gateway-bypass limits written down | `packages/agent-runtime/src/{bridge,cli}.ts`; `docs/17-agent-pilot.md` | official MCP client over stdio through the deployable server (proofs and Spaces required, Postgres wire): 6; bridge unit 5 | U, H | not run inside a real desktop agent product; no packaged CLI |
| API contract (OpenAPI 3.1) served per account; every response in the API, placement, release and SDK tests and on the built server checked against it; breaking-change gate against a committed v1 baseline; SDK safe on unknown statuses | `packages/api-core/src/{openapi,contract,compat}.ts`, `contract/v1.json`; `docs/18-api-compatibility.md` | api-core contract 5 plus every guarded test, SDK compat 3, built server 1 (12 requests) | U, H | no published SDK; request bodies validated by the server code, not by the schema |
| Performance and reliability budget: local latencies for resolve, placement and gateway overhead (memory and Postgres); limits; failure behaviour; gateway upstream timeout added | `bench/run.ts`, `docs/PERFORMANCE.md`, `agent-runtime/src/gateway.ts` | bench (manual), gateway timeout test | H | not hosted; no load test; not enforced in CI |
| Credential and permission boundary review (internal): every credential and boundary listed with its enforcement and test; 5 findings fixed (anonymous and non-member access to the runtime link, no upstream timeout, malformed Space input, string constraints); dependency audit | `docs/14-security-review.md`, `apps/web/lib/runtime.ts` | web 3 (built server, Postgres wire, Chromium), agent-runtime | U, H | **not external**; open risks listed (global operator token, no key rotation, env-held secrets, dev-tool advisories) |
| Recipes and policy packs: declarative Space templates; packs deny or ask only, scoped to their Space; applying never grants scopes; only reviewed content (hash) runs; narrowing only; catalog of 3 | `packages/agent-runtime/src/{recipe,recipes-cli}.ts`, `recipes/`, `supabase/migrations/20260111000000_space_rules.sql`, agent-server `/admin/recipes`; `docs/19-recipes.md` | agent-runtime 9, agent-server 4 (official MCP client, Postgres wire) | U, H | reviews are internal and unsigned; no UI; sharing between accounts disabled |
| Developer docs page `/docs` on the API app: every curl example is sent to the built server and must answer as documented and inside the contract; the SDK example on the page is run as written; the error table must cover every code the server and resolver can send | `apps/api/app/docs/page.tsx`, `apps/api/lib/{examples,sdk-example}.ts` | 12 (built server) | H | not hosted; SDK not published |
| Wedge landing page `/agents` (MCP-agent startups) and outreach copy: every claim cites files that must exist; commands match the CLI; overclaiming words refused on the page and in the copy; pilot link only when configured; axe clean light and dark | `apps/api/app/agents/page.tsx`, `apps/api/lib/claims.ts`, `docs/outreach/mcp-agent-startups.md` | 5 (built server) | H | not deployed; nothing sent to anyone; no design partner yet (**P** not reached) |
| Clay: pieces pressed into one object (clump) with recursive merge, refusal, removal and type recalculated by rules; explicit state machine (illegal events refused, no success without a receipt, unknown outcomes reconciled, undo only when reversible); goo-filter fusion with a reduced-motion path; harness page with simulated tabs for pointer, keyboard and touch; **real cross-tab carry in the MV3 extension** (state in the service worker's `storage.session`, each tab rebuilds what is in hand, effects run in the tab that owns the destination) | `packages/core/src/clump.ts`, `packages/interaction/src/clump-machine.ts`, `packages/overlay/src/clay.ts`, `apps/harness/src/clay.*`, `apps/extension/src/{background,clay-content}.ts`; `docs/20-clay.md` | core 11, machine 11, harness 13 (Chromium, incl. CDP touch, axe), extension 2 (real Chromium tabs) | U, H, F | stand-in calendar and drafts only; no drag continuity between real tabs (tray instead); extension keyboard is Escape only; no person has used it |
| Recast trigger and glass instrument: off by default (pages behave normally); Control twice (or a button) turns it on, reopens the composition or turns it off; a merge opens a small glass capsule around the composition; a 3D drum wheel (snap, tick, trackpad and touch) of the bridge registry (Calendar, Mail, Tasks, Documents, More), available only when the composition fits and a destination is connected; review, receipt and undo in the same module; Escape steps back; one module | `packages/interaction/src/{clump-machine,wheel}.ts`, `packages/overlay/src/glass.ts`, `packages/bridges/src/contracts.ts`, `apps/harness/src/clay.*`, `apps/extension/src/{background,clay-content,popup}.ts`; `docs/21-glass-module.md` | machine 14, Control-twice detector 6, glass contrast 7, bridges 4, clay page 21 (Chromium: mouse wheel, trackpad deltas, keyboard, touch, Control twice, reduced motion, reduced transparency, axe light/dark on each state), extension 3 (real tabs, Control twice, popup button, tab brought to front) | U, H, F | stand-ins only; Tasks and Documents never fit today (no document fragments); browser only, not desktop-wide; in the extension, Control twice only in tabs Recast is already in; the photo is an illustration (no reference photos in the repo) |
| Reliability of the clay interaction: deterministic Control trigger (boundaries, chords, lost keyups, blur); every effect result names its operation (stale answers ignored); Undo as a guarded step with honest failure; unknown outcomes remembered per destination so a retry goes to the check, never a second write; a destination tab closing mid-write becomes "unknown"; placed objects retire only after a confirmed receipt; **a merge confirmed with Combine settles** (fixed 2026-10-21: in the extension it stayed "merging" forever, because only the tab that dropped played the fusion and the confirmation step cleared that; now the tab where Combine is pressed plays it) | `packages/interaction/src/{double-tap,clump-machine}.ts`, `apps/extension/src/background.ts`, hosts; `docs/22-reliability.md` | unit (trigger 14, lifecycle 20), clay page 4 recovery tests (real Chromium, stand-in), extension 1 test with a **real worker stop**, a tab closed mid-write and a reload | U, H, F | no real provider; timings not checked on physical Mac/Windows keyboards; Gmail drafts have no provider idempotency key, so the forced check is the only duplicate guard there |
| Control center on Postgres with sign-in (local accounts, Supabase sessions) | `apps/web/{proxy.ts,lib/*}`, `packages/store/src/scoped.ts` | 8 browser tests over Postgres wire; 8 unit; isolation between two people | H, F | Supabase is a stand-in; JWKS (asymmetric) tokens unsupported |

| Extension → real Google Calendar **and Gmail drafts** (optional `gmail.compose`, separate tick; drafts only, never sent; a lost Gmail answer cannot be checked and says so) through the local program: optional `localhost` permission asked on Connect; pairing by a code the person allows on the program's page; Calendar in the wheel only while paired and signed in (no stand-in label); place, undo, lost answer → Check → receipt, never resent; the Google token never reaches the extension | `apps/extension/src/{background,popup}.ts`, `apps/calendar-link/src/extension-api.ts`; `docs/REAL_TEST_PLAN.md` B | extension link 4 (real Chromium, program over real HTTP, **Google stand-in**), calendar-link door 4; manifest audit narrowed to the one host | H, F | **R not yet run**: `docs/REAL_TEST_PLAN.md` B1–B12, C1–C6 |

| A whole page as one object, to the real Google Tasks, **and a page + a date as a task due that day** (`task-tasklist-entry`, `googleTasksEntry`, D29; the time of day is dropped and the review says so): **This page** in the extension's pill takes the page (og:title or `<title>`, same-site canonical link) as a Document; the module opens on it with Tasks in the wheel; Google Tasks is a third optional permission in the local program (`tasks` scope, default list); Undo deletes the task; a lost answer says it cannot be checked and asks the person to look (no key Recast chose) | `packages/core/src/clump.ts` (Document), `packages/interaction/src/clump-machine.ts` (openModule), `packages/overlay/src/glass.ts`, `apps/extension/src/{clay-content,background,popup}.ts`, `apps/calendar-link/src/{server,extension-api}.ts`; `docs/REAL_TEST_PLAN.md` E | core 8, interaction 5, bridges 2, calendar-link 4, extension 2 (real Chromium, program over real HTTP, **Google stand-in**) | U, H, F | **R not yet run** (`docs/REAL_TEST_PLAN.md` E1–E9); no files (PDF); a page combines only with a date (D29); Notion not connected |

| How much Recast asks (D24, D28): "Every time" (default) or "Only when it matters"; asked the first time the popup opens, changeable there; anything that notifies someone, can't be undone, needs a hold, is missing something, or was dropped blind still opens the review | `packages/interaction/src/clump-machine.ts` (`straightThrough`), `apps/extension/src/{background,popup}.ts` | interaction 6, extension 1 (real Chromium: first-run question, setting kept, straight placement with Undo, back to review); manifest audit allows exactly one `storage.local` key | U, H, F | not in the web control center; nobody has used it (**P**) |

## 2. Implemented but not fully verified
| Requirement | Implementation | What exists | Missing to verify |
|---|---|---|---|
| Destination bridges: Calendar attendee/location, Gmail draft, Sheets row, Tasks task, Notion page | `packages/bridges/src/specs.ts` | request builders, undo tokens, injection guards; F via a fake Google over HTTP (Gmail draft, Calendar attendee, Tasks task through `apps/calendar-link`) | **R**: needs OAuth apps (task #22). Calendar *event* creation reached R separately (see section 1) |
| `POST /v1/place` and undo | `packages/api-core/src/{api,place}.ts` | re-resolve, object-id check, consent, sealed credentials, host allowlist, atomic undo claim; release state `internal` | R (the bridge itself reached R through `apps/calendar-link`, not through this endpoint); no OAuth flow here (tokens stored as given, no refresh) |
| Browser extension | `apps/extension` | popup lists what the page holds; the clay layer carries objects across tabs; places on pages that declare destinations **and** in the real Google Calendar and Gmail drafts through `apps/calendar-link` (30 tests, 9 in real Chromium) | never loaded by a person; real-Google run pending (`docs/REAL_TEST_PLAN.md` B–D) |
| Windows interaction | `apps/spike-win` | probes for a global hook and UI Automation, not run | everything: needs a Windows machine (task #23) |
| Audit-chain claims | `packages/agent-runtime/src/audit.ts` | detects edit, delete, reorder and fork without the signing key | stated in `docs/DECISIONS.md` D7; not externally reviewed |
| Interim design system | `design/tokens.css`, overlay | computed contrast; axe clean | final identity pending Modulark/Modulus (`docs/design-direction.md`) |

## Latest full run (2026-10-21, after a page + a date → Google Tasks)
`pnpm gen` leaves no diff; `pnpm -r typecheck` passes; `pnpm -r test`: **20 packages, 873 tests, 0 failures, twice in a row** (core 114, interaction 118, bridges 40, overlay 11, extract-web 74, harness 52, extension 30, calendar-link 21, api-core 88, agent-runtime 102, …). Before: 862.
- **Fixed a test-environment race found by this run:** under a full parallel run, the extension's link test sometimes saw "UTC" instead of Asia/Kolkata (2 of 3 runs). Playwright's `timezoneId` reaches pages but not reliably the extension's service worker, which reads dates. The test browsers now also set `TZ`, which every browser process respects. The repository defines no lint script; typecheck is the static check.

## 3. In progress
| Requirement | Where | State |
|---|---|---|
| System map, decision log | `docs/SYSTEM_MAP.md`, `docs/DECISIONS.md` | written; kept current |

## 4. Not started, or blocked outside the repository
| Item | Blocked on |
|---|---|
| Release gates in the control center | people's accounts have no cohort yet |
| Hosted performance (cold starts, network database, providers), load and soak tests | a deployment (#21); local budget and measurements in `docs/PERFORMANCE.md` |
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
