# 06. Layer 0 report (core, schema, conformance)

## Verdict
**Gate met as defined, with a caveat you should weigh:** the conformance suite passes on all three bindings that exist (Node on TypeScript source, Node on the built ESM bundle, Chromium on the IIFE bundle under a strict no-`unsafe-eval` CSP). But there is one implementation, so this proves packaging, serialization and extension-safety, not independent correctness. A second implementation (Rust port or a native engine) is what would make the gate a true cross-implementation test.

## What exists
| Area | State |
|---|---|
| Schemas | JSON Schema 2020-12 for all **nine** types, envelope, candidate, evidence, provenance, capability contract, relation grammar. Source of truth is `schema/`. |
| Generated code | TS types and **Ajv standalone validators** (precompiled, so no `eval`/`new Function`; needed for MV3). `pnpm gen`; CI fails if generated files are stale. |
| Grammar as data | All ten relations in `schema/grammar/relations.json`; identity keys in `identity.json`; contracts validated against the grammar (a destination may raise a relation's risk, never lower it). |
| Core | `perceive`, `resolve`, `propose`/`rankProposals`, `preview`, `plan`, `commit`, `undo`, `inspect*`, `serialize`/`deserialize`, trust model, append-only event log. Pure; shells inject clock, bridge and log. |
| Provenance and evidence | Every property must carry confidence and at least one evidence locator, or `resolve` refuses it. |
| Stable IDs | Content-derived from identity keys (same person via different pages gets the same id; a tampered id is rejected on load). |

## Polish level (as scoped)
- **Polished (perception + normalisation + identity + tests):** Person, Event, Location, ResearchPaper. Product also has a JSON-LD perceiver.
- **Schema + generic pipeline only:** Document, Image, Message, Task. They validate, get stable IDs, round-trip, and take part in proposals/commit/undo, but nothing perceives them yet.

## Test results (all run, none skipped)
- `packages/core`: **62 tests** (SHA-256 vs NIST vectors and Node crypto; perception; resolve/validation; identity; grammar and contract rejection; proposals and ranking; the trust matrix; consent enforcement; commit/undo/log; immutability).
- `packages/conformance`: **6 tests** running **22 fixture cases** per binding, each checked two ways: hand-written expectations, and byte-identical canonical output against golden transcripts. Also a bundle-hygiene test (no `eval`, `new Function`, `fetch`, storage, WebSocket) and a CSP control test proving the browser page really forbids eval (so the browser pass is meaningful).
- **Mutation check done by hand:** weakening the hold duration and removing `send` from the high-risk flags made 3 core tests and all three conformance bindings fail; reverted.
- Typecheck clean across all packages.

## Things I found and fixed on the way
- Ajv's default `compile()` uses `new Function`, which MV3 extension pages forbid. Switched to standalone code generation.
- My first CSP control test was vacuous: `page.evaluate` runs through the debugger and bypasses CSP. The probe now runs as a served page script.
- The grammar allows at most one relation per (source type, destination kind), so proposal *ranking* cannot be exercised through `propose` alone. Exposed `rankProposals` and tested it on real proposals. Ranking matters more once the grammar grows.

## Known gaps and honest limits
- **Goldens are regression nets.** They are generated from the TypeScript-source binding. Independent checks are the hand-written `expect` blocks and the core unit tests.
- **Not verified:** the CI workflow has not run on GitHub yet (it pushes with this commit). `npx playwright-core install chromium` in CI is untested. The browser binding was run on the sandbox's Chromium only, not Edge, Firefox or Safari.
- **Not built (by design, later layers):** DOM/accessibility/PDF perception, real bridges, persistence for the event log (in-memory only), bridge-assisted resolution.
- **Mockups vs grammar:** the design mockup shows both an Attendee and a Location chip on one destination for a Person token; with the real grammar a Person only offers Attendee. The mockup is illustrative and should be corrected before component work.
- **Security review:** no permissions or network exist in Layer 0, so there is nothing to threat-model yet. Layer 1 (extension) is where the review starts.

## Performance (informational, not a budget claim)
`perceive + resolve + propose` for one JSON-LD Person, Node 22, warm, 5000 runs: p50 0.046 ms, p95 0.090 ms, p99 0.289 ms. This excludes DOM traversal, message passing and cold start, which dominate the 100 ms capture budget in Layer 1. Bundle size: 258 KB unminified IIFE (most of it Ajv and the validators; minification and pruning not yet done).

## Decisions I'd like you to review
1. **Accept the single-implementation caveat**, or start a Rust port earlier (Layer 3 timing is otherwise fine).
2. **Grammar cardinality:** one relation per (source, destination kind) is simple, but real destinations (e.g. a person as both attendee and organizer) will need more rows. Cheap to add as data.
3. **Proceed to Layer 1** (Chrome/Edge extension, corpus of 100+ pages with ground truth). Corpus labelling is the slow part, so I'd like to agree the accuracy targets in `docs/05-plan.md` first.
