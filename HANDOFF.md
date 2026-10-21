# Handoff: read this first, update it last

Recast is worked on across several Claude sessions and accounts, and no session remembers the others. This file is the shared memory. **Every session reads it before starting and updates it before ending** (what was done, what is half-done, what's next), then commits and pushes it with the work.

The repository's own records stay authoritative for what they cover; this file points to them rather than repeating them:
- `docs/ENGINEERING_STATUS.md`: what is actually verified, and at which evidence level (U, H, F, R, P)
- `docs/DECISIONS.md`: decision log (D1 onward)
- `docs/REAL_TEST_PLAN.md`: tests only the owner can run by hand against real Google
- `docs/00-system-overview.md`: the whole system, start here for the code

## Working rules (from the owner)
- Develop on branch `claude/clever-heisenberg-s3taqj`; commit and push there. No pull request unless asked.
- Claim only what the repository proves. Guesses and proposals are labelled as such (see the deck below).
- Before calling a test failure real, check it against committed code (`git stash`, run the package, `git stash pop`).
- Full check: `pnpm install && pnpm gen && pnpm -r typecheck && pnpm -r test`. One package: `pnpm --filter <name> test`.

## Current state (2026-10-21)
- Last full run: **862 tests, 0 failures** (after the page → Tasks work) (see `docs/ENGINEERING_STATUS.md`, "Latest full run").
- **One capability at R (real provider):** Google Calendar event creation from `apps/calendar-link`, run by hand by the owner on a throwaway Google account. Nothing else has touched real Google, Notion, Supabase or Vercel. No users yet (nothing at P).
- **Newest (this session): a whole page → real Google Tasks.** "This page" in the extension's Recast pill takes the page (title and canonical link) as a Document; the module opens on it with Tasks in the wheel; Google Tasks is a third optional permission in `apps/calendar-link`; Undo deletes the task. Tested in real Chromium against a Google stand-in. The owner's real run is `docs/REAL_TEST_PLAN.md` section E (needs the Google Tasks API enabled in Google Cloud and a re-sign-in ticking Tasks).
- Earlier: local Google sign-in (`apps/calendar-link`); extension places in real Google Calendar and saves Gmail drafts through that local program (tested only against a Google stand-in); "How much Recast asks" setting (D24, D28).
- Nothing is deployed (API, agent server, control center, database).

## Open threads
1. **Uncommitted edits on another machine.** The owner was mid-edit in another session and saw 2 extension test failures there. On 2026-10-21 the committed code was re-run in a clean clone: `apps/extension` **28/28 pass**. So the failures come from those uncommitted edits. They exist only on that machine: commit and push them (or paste the diff) to have them looked at.
2. **Investor deck** ("Recast — Investor Deck", 13 slides, a claude.ai artifact). Made in a session under a different account; it does not show in this account's artifact list, so the link must come from the owner. Contents and status:
   - Story: problem, idea, how it works, why it's safe, three products (extension, API, Agent Runtime), why now, market, business model, where we are, roadmap. The Ask slide was **removed by the owner**; there is no team slide.
   - Look: dark, warm off-white, clay-orange accent; Space Grotesk and DM Sans. Every slide has speaker notes.
   - **Guesses to confirm before presenting:** cover name "Shishir Bhat, founder" (from the GitHub username); prices Pro $49/mo, Scale $399/mo, Agent Runtime $20 per agent per month (proposals, untested); "design-partner pilot with 5 AI companies" (a target, nothing signed).
   - Facts used: 850 tests passing; three products on one engine; one real Google Calendar placement with Undo and duplicate protection; resolve allowances Free 1,000, Pro 50,000, Scale 500,000 (built into the API). Notes say plainly there are no users and that Gmail drafts and the extension's real-Google path are not yet run against real Google.
   - Market figures (2025, conservative end of named sources): productivity software $75B, ~16%/yr (The Business Research Company); intelligent document processing $3.3B → $48.8B by 2034 (IMARC); agent security $1.25B → $13.5B by 2032 (MarketsandMarkets). Speaker notes add the spread: IDP estimates $1.4B–$10B by firm; Morgan Stanley puts agent identity at ~$33B.
   - Still missing: amount raised, use of funds, team slide. Needs the owner's figures and background.

## Next steps (in order)
1. Recover the uncommitted edits (thread 1) and fix whatever breaks the two extension tests.
2. Owner runs `docs/REAL_TEST_PLAN.md` B1–B12 (extension → real Calendar), C1–C6 (Gmail drafts), D (confirmation setting), E1–E9 (page → Google Tasks). Record results in `docs/ENGINEERING_STATUS.md`; passing B and C moves those rows to R and strengthens the deck.
3. Finish the deck: ask, use of funds, team; confirm the guesses above.
4. Deploy: API and docs page to Vercel, database to Supabase (both connectors are available in Claude sessions). Gives the `/agents` page and developer docs live links.
5. Design-partner outreach from `docs/outreach/mcp-agent-startups.md`.

## Build ideas queued (no owner input needed)
- "This page + a date" as a task with a due date (needs a page to combine with a time; today a page is refused in merges, with the reason).
- Files (PDF links) as documents, not only the page.
- Keyboard path in the extension beyond Escape (the clay page has it).

## Session log (newest first, keep each entry short)
- **2026-10-21, session_01Bdx3pBhgmXK4WtvwEoTnHb:** reconstructed context; re-ran `apps/extension` on committed code (28/28 pass); created this file and `CLAUDE.md`; built a whole page → real Google Tasks ("This page", Document clumps, Tasks permission, REAL_TEST_PLAN E); full run 862/0.
- **2026-10-21, earlier session (other account):** built the investor deck, filled market, prices, pilot and cover; owner removed the Ask slide.
- **2026-10-21, session_01DBSr5JyLYdTt34JZYgfya1:** Gmail drafts, extension → real Calendar via the local program, "How much Recast asks", full run 850/0, clay test timing fix.
