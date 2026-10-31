# Product readiness after D61 (2026-10-31)

This report separates what is **implemented**, what is **tested automatically**, what was **tested against a real account**, and what is **not verified**. It invents no figures. Evidence levels are as in `docs/ENGINEERING_STATUS.md`: U unit, H harness (stand-in), F full app against a stand-in provider, R real provider, P person.

## 1. Baseline before D61
- Branch `claude/clever-heisenberg-s3taqj` at `6d563ee`, clean working tree, even with `origin`.
- Last full local run (`pnpm test`) green on `fa9caa0`; CI green on `fa9caa0`.
- Real-account evidence (R): **only Google Calendar event creation** (`REAL_TEST_PLAN` A, 2026-10-21). Everything else has run only against provider stand-ins.

## 2. Real-account testing in D61: none was possible
No Recast test account or connector credential exists in this environment. The session has GitHub, Google Cloud and AWS credentials, but they belong to the session's tooling and the owner's own accounts. Using them would write issues or events into real repositories and calendars without a test account set up for it, so they were **not** used. Nothing below claims R for any integration beyond Google Calendar creation. The exact requirements per integration are in §3 and `docs/REAL_TEST_PLAN.md`.

## 3. Per-integration reliability (from the code; level of evidence in the last column)
"Duplicate prevention" means what stops a second copy when the same operation is sent twice. "After an unknown outcome" means what Recast can do when the answer to a write was lost.

| Destination | Writes | Duplicate prevention | After an unknown outcome | Read-back (verify) | Undo | Needs for a real run | Evidence |
|---|---|---|---|---|---|---|---|
| Google Calendar | create event | provider key (event id derived from the operation) | **checked with Google** (reconcile), never resent | yes | delete | Google sign-in, Calendar scope (README Part 1) | **R** (create, 2026-10-21); verify, undo, unknown: F |
| Outlook Calendar | create event | lookup by an extended property holding the key, also sent as Graph transactionId | **checked with Microsoft** (reconcile) | yes | delete | Microsoft app + Calendars.ReadWrite (Part 12) | F |
| Gmail draft | create draft | none | the person is asked to look; never resent | yes | delete draft | Gmail compose scope | F |
| Google Tasks | create task | none | asked to look | yes | delete | Tasks scope | F |
| Google Docs | create document | none | asked to look | yes | archive (to Trash) | drive.file scope + Docs and Drive APIs | F |
| GitHub issue | create issue | none | asked to look | yes | **close** (GitHub cannot delete issues) | fine-grained token, Issues: write, one repo | F |
| Linear issue | create issue | none | asked to look | yes | delete | Linear API key, a team | F |
| Todoist | create task | none | asked to look | yes | delete | Todoist API token | F |
| Notion | create page in one database | none | asked to look | yes | archive | integration token + a shared database | F |
| Outlook mail draft | create draft | none | asked to look | yes | delete | Mail.ReadWrite | F |
| Microsoft To Do | create task | none | asked to look | yes | delete | Tasks.ReadWrite | F |
| Your webhook | send JSON | delivery id for the receiver to drop repeats | asked to look; never resent | no | none (said so; hold to confirm) | any https receiver | F |
| Google Maps / Apple Maps | nothing (opens a link) | not applicable | not applicable | no | nothing to undo (said so) | none | F; a person clicking it: **not run** |

**What "failed" means on a write (changed in D61):** only an answer that says nothing was done. A 4xx (including 408 and 429) and 503 are failures. A 500 or 502 to a create (POST), a 504 to any write, or a dropped connection, is **unknown**: it can come after the provider applied the change. A 500 to a DELETE, PUT or PATCH stays a failure: sending those twice changes nothing more. Before D61, a 500 or 502 was "failed", and D57's Try again could then have created a second copy at a destination without duplicate prevention.

**Expired or revoked access:** a 401 or 403 is a failure with the provider's answer in words (the program explains "sign in again" for missing scopes before sending). Token refresh is in `apps/calendar-link`. **Not verified against a real expired or revoked token** for any provider.

**Undo after the destination changed independently:** undo deletes or archives by the stored id. If the person already deleted it, the provider answers 404 and Recast says "Could not undo" with the answer, not "undone". A changed (not deleted) item is still deleted or archived by undo. That is the provider's object, and the receipt said what undo does. Not verified on a real account.

## 4. The action lifecycle: guarantees and where they are tested
| Guarantee | Where | Evidence |
|---|---|---|
| Nothing is written before an explicit approval (or the person's "only when it matters" setting for low-risk, reversible writes) | `packages/interaction` clump machine, consent check in core `commit` | U, H, F |
| A lost answer is unknown, never resent; placing again checks first | machine `outcomeUnknown`, `uncertain`; bridges | U, H, F |
| 500 and 502 to a create, and 504 to any write, are unknown (D61) | `packages/bridges/src/http.ts` | U (`webhook.test.ts`, status table) |
| A receipt says "done" only after the provider answered with the created item; "checked" only after a read-back | core `commit`, `verify` | U, H, F |
| Undo is offered only when the contract declares it and the receipt is reversible; "undone" only after the provider confirmed | machine, `undo` effect | U, H, F |
| Recipes: each step its own operation; a step waiting for another is not run when that one fails; Try again only for refused or never-sent steps, as the same operation | `recipe-run.ts` | U |
| Recipes: an undone step is not counted as done; unknown steps are said in the summary (D61) | `recipe-run.ts` | U |
| After a restart mid-write (desktop) or a stopped worker (extension): in flight is unknown, never sent is "not run" and can be tried again, an undo in flight is "could not undo" (D61) | `settleLostWrites` in interaction; desktop `recover`, extension `load` | U; desktop F only for the single-placement path from before D61 |
| Cancel during a write is refused with the reason; Recast stays on until the answer | machine `BUSY`, run `cancel` | U, H |

## 5. Capture, provenance and data integrity (checked in D61)
- Every pair of the eight piece kinds was pressed together. Each pair either gives an object that keeps every piece with its source and uses every piece's words, or is refused with the reason (64 cases, `packages/core/test/clump.test.ts`). **No silent drop found.**
- **Copy as data is now `recast.object/2`:** each field carries its origin (`extracted`, `inferred`, `default`, `user`), and each piece is `captured` or `typed`. `/1` flattened the values, so a typed value could not be told from a read one.
- Times are ISO strings in UTC (`capturedAt`); event times are local wall-clock with the time zone field beside them, as before.
- Removing a piece releases it as its own blob; discarding an object writes nothing and leaves no pending operation (`uncertain` cleared for it). Restoring from the library uses the same piece id, so it is never a second copy and never re-places anything.
- **"Clear all" scope**, now stated on screen: the library file only. Blobs still on the screen keep their text until discarded.

## 6. Security and privacy findings
- **Fixed (D61): every desktop window could ask the main process to write.** Placing, saving the inbox and adding library entries are now accepted only from the overlay, and removing entries only from the library. All pages are local and none loads remote content, so this was hardening, not an exploit.
- **Tokens:** the local program and the desktop app write tokens and secrets with mode 0600 in a 0700 folder (`writePrivate`). They are never sent to pages; the extension talks only to `localhost:8787`, and only after pairing.
- **Logs:** no captured text, token or receipt is logged. The only `console.log` lines are startup messages and the desktop launch check's status line.
- **Exported JSON (Copy as data):** contains what the person captured and the page addresses, which is the point of it; only on the person's click; nothing is sent.
- **Recipe sharing and import:** the definition is steps and destination names only. Imports are checked as strictly as stored files: no unknown fields, no unknown destinations, size-limited. Tests cover captured words, a planted field and an unknown host.
- **Links:** opened only for https, or the local program; Maps links are built only from the reviewed name and address, on fixed hosts.
- **Telemetry: none exists.** §7 says what to measure and how, without sending captured content.
- **Not audited here:** the Next.js `apps/web` and the API packages (outside this milestone's surfaces), and supply-chain review of dependencies.

## 7. Product metrics: definitions only, no values
None of these has a value yet: there is no real usage. Each is defined so it can be computed **on the person's own device** from events Recast already has (state machine `last` kinds and receipts), without captured text. It would be shown to the person, and shared only if they opt in.
| Metric | Definition | Source event |
|---|---|---|
| Task completion rate | placements and recipe runs that end "done" ÷ reviews opened | `previewing`/`planning` → `succeeded`/`ran` |
| User correction rate | reviews where the person answered or chose a field, or replaced a piece ÷ reviews | `answer`, `choose`, `replace` |
| Median time to complete | from the first capture into an object to its receipt | `capturedAt` → receipt `at` |
| Duplicate-action rate | placements the destination reported "already there" ÷ placements | `DuplicateError` outcome |
| Verification failure rate | read-backs that did not match ÷ read-backs | `verified` with `ok: false` |
| Recovery success rate | unknown outcomes resolved by a check ÷ unknown outcomes | `reconciled` after `outcomeUnknown` |
| Recipe completion rate | runs with every chosen step done ÷ runs started | run summary |
| Repeat usage | days in a week with at least one placement | receipts by day |

## 8. Test results for D61 (local, this container, 2026-10-31)
- `pnpm build`: passed. `pnpm typecheck` (every package): passed.
- **Lint and format: not run, none exists.** The repository has no ESLint, Prettier or Biome configuration.
- `pnpm test` (whole repository): **passed** (exit 0). It includes core 217, interaction 159, bridges 111, api-core 88, calendar-link 50, try-it page 70, extension 46, desktop 18 (Linux, Xvfb with real X11 input).
- The first full run failed one api-core test ("a failed undo returns the placement to 'succeeded'"). It was caused by the first version of the 500/502 rule, which also covered DELETE. The rule was narrowed to creates (POST), with a test for DELETE, and the next full run passed.
- CI: see the D61 commit's run (reported in the session's final message).

## 9. Known limitations and unverified behavior
- Real accounts: everything except Google Calendar creation (§2, §3).
- The desktop app on a real Mac: never confirmed by a person (`docs/macos-test-checklist.md`).
- The extension's worker-restart recovery (D61) is unit-tested through the shared function. Stopping the worker mid-write inside real Chromium has not been automated.
- Windows: the desktop app launches and reads the screen in CI; keys, focus and highlights are not tested on Windows.
- Unknown outcomes at destinations without a provider key rely on the person looking; Recast cannot check for them.
- Locally (not in CI), the extension's `link.test.ts` sometimes times out on the first run after a rebuild (open thread in HANDOFF).
