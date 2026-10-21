# Getting Recast into an outside person's hands

Audit, decision and test protocol, 21 October 2026. Evidence levels as in `docs/ENGINEERING_STATUS.md` (U unit, H local browser or server, F fake provider, R real provider, P people).

## 1. Audit (no code changed during it)

**Baseline.** Branch `claude/clever-heisenberg-s3taqj`, clean tree, head `4fa65a0`. `pnpm -r typecheck` passes; `pnpm -r test`: 20 packages, 877 tests, 0 failures. Try-it page tests (`pnpm --filter @recast/harness test`): 52 of 52 in real Chromium.

**What a person can open today**

| Entry point | How a person gets it | Real destinations | Who can use it unaided |
|---|---|---|---|
| Browser extension (`apps/extension`) | Clone the repo, `pnpm install`, build, Chrome developer mode, Load unpacked `apps/extension/dist` | Real Google Calendar, Gmail drafts and Tasks, only through the local program below; otherwise only pages that declare stand-in destinations (test fixtures) | Developers only |
| Local program (`apps/calendar-link`) | Node and the repo, **plus the person's own Google Cloud OAuth app** (about 10 minutes of console steps: consent screen, test users, credentials, APIs) | Real Google | Developers only |
| Try-it page (`apps/harness/dist/clay-artifact.html`) | A link, if published. Built by `pnpm --filter @recast/harness build`. **Not published anywhere reachable:** the docs mention "the published artifact" but no link is recorded and this account has none (at audit time; published after it, see section 3) | Stand-ins on simulated tabs, said so in every review ("Stand-in: … Nothing reaches the real Calendar") | Anyone with a desktop or phone browser |
| API, SDK, MCP server, agent server, control center | Run locally from the repo | Not deployed; no `vercel.json`; Supabase not provisioned | Developers only |

**The core journey on the try-it page** (the same interaction engine, glass module and clay layer as the extension; only the destinations differ)

| Step | State | Evidence |
|---|---|---|
| 1. Find a visible piece (a time, a name, a place) | Verified (H) | Highlighted once Recast is on; `apps/harness/test/clay.test.ts` |
| 2. Capture it as an object | Verified (H) | pick-up by drag, press and hold on touch, keyboard |
| 3. Capture a compatible piece | Verified (H) | across simulated tabs |
| 4. Combine into one object | Verified (H) | refusal with a reason when they do not combine; confirmation when it changes what the object is |
| 5. Preview | Verified (H) | the review writes nothing |
| 6. Resolve missing information and conflicts explicitly | Verified (H) | missing title, typed address, conflicting times shown, not chosen |
| 7. Execute at the destination | **Simulated** on the try-it page (stand-in calendar and drafts). Real Google Calendar: **R** only from the local program's own test button (owner, by hand, 21 Oct). From the extension: **F** (Google stand-in) | `docs/REAL_TEST_PLAN.md` A done; B, C, E not run |
| 8. Verify the result, truthful confirmation | Verified (H) on stand-ins: success only on a receipt; failure says why; lost answer is "unknown" and checked, never resent; Undo is guarded | clay page recovery tests; extension tests with a real worker stop |

**Tests.** Mostly behaviour, driven through real Chromium with pointer, touch and keyboard, plus unit tests of the pure rules. What they cannot show: whether a person understands what to do (nothing is at P), and real Google behaviour beyond the one owner run.

**Safety gaps still open** (from `docs/14-security-review.md` and the status file): the security review is internal only; Gmail drafts have no provider idempotency key (the forced check is the only duplicate guard); the extension's real-Google path has not run against real Google.

## 2. Decision

**Blocker:** no person outside the build can try Recast at all. Every entry point except the try-it page needs the repository, a build and developer mode, and every real destination also needs the tester's own Google Cloud OAuth app. The try-it page, which needs only a link, was built for exactly this but is not reachable.

**Milestone chosen:** a shareable try-it link plus a moderated test protocol, so 3 to 5 people can attempt the core journey unaided. This is the order the brief sets (launchability first). It needs no new architecture, no new dependency and no external account. It validates objectives 1, 2, 3 and 5: launch, comprehension, the journey end to end, feedback.

**What it does not validate:** objective 4, real external actions. On the try-it page every destination is a stand-in and says so. That is the next milestone (section 5).

## 3. Running it

- Build: `pnpm install && pnpm --filter @recast/harness build` produces `apps/harness/dist/clay-artifact.html` (one file, fonts from Google Fonts) and `apps/harness/dist/clay.html` (opens straight from disk, no network).
- Local demo: open `apps/harness/dist/clay.html` in Chrome, Edge, Safari or Firefox. No server needed.
- Shareable link: **https://claude.ai/artifact/AavuzTXJUyJenKkLfLCUHN** ("Recast try-it page", a claude.ai artifact in the owner's account, published 21 Oct 2026 from `apps/harness/dist/clay-artifact.html` at commit `4fa65a0`). It is private: nobody else can open it until the owner shares it from the page's Share menu. To refresh it after a change, rebuild and republish the same file to the same link (from another session, pass the link as the artifact `url`).

## 4. Test protocol for independent testers

**Who:** 3 to 5 people who have never seen Recast and are not on the team. One at a time, on their own computer (desktop or laptop first; phones are a second round).

**Setup (moderator, 2 minutes):** share the try-it link (section 3) with the tester from the page's Share menu, and check they can open it. Ask them to share their screen and think aloud. Say only this:
> "This page imitates a web browser with a few tabs open. Recast is a tool inside it. I'll give you a task; please say what you're thinking as you go. There are no wrong moves, and nothing you do here reaches any real account."

Do not explain Control twice, dragging, the wheel or the review. If they are stuck for 2 minutes on the same step, give the smallest possible hint and record it.

**Task 1 (the core journey):**
> "You want to have dinner with Maya at Dakshin on Friday at 7:30 PM. Using Recast, put that in the calendar."

Success: one event in the stand-in calendar, with Maya, Dakshin and Friday 7:30 PM, placed after the review.

**Task 2 (cancel and recover):**
> "Now take that dinner back out of the calendar."

Success: Undo used, or the tester explains how they would. Then: "Start another one, and stop before anything is added." Success: Escape, Cancel or Back from the review, with nothing added.

**Task 3 (optional, a refusal):**
> "Try to put Maya and the gift card together."

Success: the tester reads and understands why Recast refuses.

**After the tasks, ask (and record the answers in their words):**
1. In one sentence, what does Recast do?
2. At any point, did you think something had been added when it had not, or the other way round?
3. What was the most confusing moment?
4. Would you use this in your own browser? For what?

**Record per tester** (one row each; never fill a row for a session that did not happen):

| Field | Note |
|---|---|
| Date, tester code, device and browser | no names in the repo |
| Time to complete task 1 | from "go" to the event shown in the calendar |
| Completed unaided? Hints given (verbatim) and at which step | |
| Where they hesitated, and for how long | step numbers from section 1 |
| Errors (wrong drop, wrong destination, misread the review) | |
| Did they read the review before confirming? | |
| Did they understand Undo, Cancel and the stand-in note? | |
| Answers to the four questions | their words |
| Bugs seen | with a screenshot if possible |

**Stop and fix before the next tester** if two testers in a row cannot finish task 1 without a hint at the same step.

Results go in `docs/user-validation/` (one file per session) and a summary line in `docs/ENGINEERING_STATUS.md`. Until a session has happened, nothing here is at P.

## 5. Next milestone: real external actions for outside testers

The try-it page cannot show that the external action is right, because its destinations are stand-ins. Getting a tester to the real Google path needs:
- a prebuilt extension the tester can load (or an unlisted Chrome Web Store listing);
- the local program as one file the tester can run with Node;
- the owner's Google OAuth app shared with testers, which only the owner can do: add each tester's Google address under **Test users** (Google allows 100 while the app is in Testing), and give them the client ID and secret.

The owner's run of `docs/REAL_TEST_PLAN.md` B, C and E comes first, so testers do not find failures the owner could have.
