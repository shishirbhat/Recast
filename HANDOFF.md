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

## Current state (2026-10-26)
- **Owner's thesis (26 Oct): Recast is the context layer**, not a shortcut. Selection-first, context-preserving, between apps: I choose what matters, I see what will happen, I know what actually happened. Three innovations:
  - universal context objects;
  - context reconciliation;
  - a compounding personal workflow system (saved workflows, never data held hostage).

  Proof built (D40): try-it page tabs **Invite, Chat, Plan** → one event. The conflicting times show their sources, the person's choice is kept with what it overruled, every value names its source, and after placing the calendar is **read back** field by field. A "someone edits it" switch shows a caught mismatch. Stand-in calendar on that page; Google Calendar's read-back exists in the bridge (tested against a stand-in only).
- **Next (owner's engineering brief, 26 Oct):** Capture → Compose → Preview → Approve → Execute → Verify → Confirm. Highest-value gap found: the *real* path (extension → `apps/calendar-link` → Google) never runs Verify and gives no link to the created event.
- Fixed: "Friday 23 October" was silently read as the next Friday once the 23rd had passed (dates with a day and month but no year were not read). Extension tests had gone red for this reason alone once the real date passed 23 Oct.
- Last full run (2026-10-23, after desktop highlights): **975 tests, 0 failures**. `pnpm test` now runs the three browser-driven suites (harness, extension, desktop) one after another and the rest in parallel: on 4 CPUs they starved each other and timing-sensitive interaction tests failed for that reason alone.
- **Newest (owner's integration direction, `docs/24-integration-universe.md`):**
  - Every destination declares its **abilities** (open, create, read, update, search, delete, verify, undo), checked against what its bridge does (D30).
  - **Open and prefill**: a place → **Google Maps** (or Apple Maps) directions. Needs no account; the review is a real link; done says "Opened", no Undo. On the try-it page and in the extension.
  - **Passages → a Note → Google Docs** (D31): select sentences on pages, press them together; each keeps its page. A new optional `drive.file` permission in `apps/calendar-link` (only files Recast creates). Try-it page has a stand-in Docs tab.
  - Fixed: in the extension, letting go over empty page space pressed the object into a date on the page.
  - **An error → a GitHub issue** (D32): select an error message, optionally press notes into it; Tasks opens an issue (confirm first; everything quoted literally; Undo closes it). GitHub is its own connection in `apps/calendar-link` (fine-grained token for one repository). Try-it page has a Build tab with stand-in issues.
  - **Recipes** (D35) and capture-stack dedupe.
  - **Linear** issues (D33); a wheel place with two connected choices asks "which one?".
  - **Phase two started (owner's request): any selected text becomes a movable blob** (D34), on the try-it page and in the extension. Next for phase two: places from free text (needs confirmation), touch selection on real phones, and a person's name from free text.
  - Try-it page fixes: phone tab strip, tab panels' accessibility (axe clean).
  - Google Maps on the hosted try-it page: owner reported it did not work; fixed (tab opened from code, refusal reported with the address to copy). **Owner to re-check.**
- **Newest: outside-person readiness** (`docs/23-user-validation.md`). Audit found no outsider could try Recast (everything needs the repo, a build and developer mode; real Google also needs the tester's own OAuth app). The try-it page is now published: **https://claude.ai/artifact/AavuzTXJUyJenKkLfLCUHN** (private until the owner shares it). Stand-in Calendar and Mail, said so on every review. A moderated protocol for 3 to 5 testers is in section 4 of that doc. **No tester session has happened yet** (nothing at P).
- **One capability at R (real provider):** Google Calendar event creation from `apps/calendar-link`, run by hand by the owner on a throwaway Google account. Nothing else has touched real Google, Notion, Supabase or Vercel. No users yet (nothing at P).
- **Earlier this session: a whole page → real Google Tasks.** "This page" in the extension's Recast pill takes the page (title and canonical link) as a Document; the module opens on it with Tasks in the wheel; Google Tasks is a third optional permission in `apps/calendar-link`; Undo deletes the task. Tested in real Chromium against a Google stand-in. The owner's real run is `docs/REAL_TEST_PLAN.md` section E (needs the Google Tasks API enabled in Google Cloud and a re-sign-in ticking Tasks).
- **Also: a page + a date is a task due that day** (D29): new grammar relation `task-tasklist-entry` (Task → TaskList) and contract `googleTasksEntry`; Combine asks first; the time of day is dropped and the review says so. REAL_TEST_PLAN E8b–E8d.
- **Bug fixed on the way:** in the extension, a merge that needs confirmation (Combine) never settled and stayed "merging" forever. Now fixed and covered by the page + date test.
- Earlier: local Google sign-in (`apps/calendar-link`); extension places in real Google Calendar and saves Gmail drafts through that local program (tested only against a Google stand-in); "How much Recast asks" setting (D24, D28).
- Nothing is deployed (API, agent server, control center, database).

## Desktop app (`apps/desktop`): where it stands (the owner's current focus)
**What it is now** (D36 → D37 → D38 → D39; the floating panel of D37 is gone):
- **Overlay over any app:** double tap **Option** (Mac; Control twice is the Mac's Dictation) / **Ctrl** (Windows, Linux) → a transparent, always-on-top window covers the display under the pointer. Nothing opens; the app underneath keeps the keyboard and gets every click except on Recast's own shapes (macOS/Windows: ignore mouse + forward; Linux: shaped window).
- **Highlights (D39):** on turning on, the screen is captured and read by OCR on the machine (tesseract.js, bundled English model, nothing sent or kept) → spots: times/dates, emails, error lines, links (`src/spots.ts`, unit-tested). Click a highlight → blob beside it; drag → blob in hand. Rescan after scroll/click.
- **Selections:** while on, any selection (drag, double/triple click; waits ~320 ms for clicking to stop) → blob where you let go. Mac/Windows read it by pressing copy through the hook and restoring the clipboard; Linux reads PRIMARY.
- **Blobs → wheel:** drag one onto another to press together; click one → the wheel opens beside it; review; place (Calendar, Tasks, Gmail drafts, Docs, GitHub, Linear, Maps). Esc or one tap = off. Status pill bottom centre.
- **Library = the Recast app window:** every grab (history.json) with source and "→ where it went"; opens only from Applications/Dock/tray, never on a grab. Settings, Connections, permission cards (Accessibility, Screen Recording) live there.
- **Files:** `src/main.ts` (windows, overlay, trigger, scans, IPC), `src/hook.ts` (uiohook-napi keyboard/mouse hook, tap rule from `@recast/interaction`), `src/grab.ts` (selection + source app), `src/screen.ts` (capture + OCR, time-limited), `src/spots.ts`, `src/overlay.*`, `src/library.*`, `src/preload.ts`, `scripts/install-mac.sh`.

**Install on the owner's Mac (MacBook Neo, Apple silicon, macOS 26.5.1):** download artifact **Recast-for-Mac-Apple-silicon** from the latest successful `desktop` workflow run (Actions → desktop → Artifacts; needs GitHub sign-in), then in Terminal: `curl -fsSL https://raw.githubusercontent.com/shishirbhat/Recast/claude/clever-heisenberg-s3taqj/apps/desktop/scripts/install-mac.sh | bash` (finds the download in ~/Downloads, quits old copies, installs, clears quarantine, re-signs old hardened copies, opens). Do **not** send installers through chat: files of ~115 MB arrived truncated twice ("disk image is corrupted", zip error 94).

**Lessons that cost time (don't repeat):**
- Ad-hoc signing + hardened runtime = crash at launch on real Macs ("different Team IDs"); GitHub's mac runner tolerates it. `hardenedRuntime: false` unless a Developer ID; CI fails an ad-hoc build carrying it.
- Gatekeeper rejects browser-downloaded unsigned apps → the install script. The real fix is the owner's Apple Developer ID + notarisation (not done; owner's decision, $99/yr).
- ⌘⌥Space is Finder's; the open-library shortcut on Mac is ⌃⌥Space.
- Packaging: `npmRebuild: false` (uiohook prebuilt), `asarUnpack: node_modules/**` (OCR worker can't read the archive).
- Linux tests need a window manager + compositor (openbox, xcompmgr) or "always on top"/transparency are meaningless and click-through tests pass for the wrong reason. `scripts/test.mjs` starts them; CI installs them. `xdotool` drives real keys/mouse.
- A public GitHub Release (sign-in-free downloads) was blocked by the permission system as a public surface: needs the owner's explicit go-ahead.

**Status of evidence:** Linux: real keys, real mouse, highlights, click-through, Calendar via stand-in, all tested (desktop 14/14). Packaged Linux/Windows launch checks run OCR from the installed app; packaged Mac install check runs the install script on a quarantined download with an old copy running, then opens via Launch Services. **Never yet confirmed on the owner's Mac:** Option twice, Accessibility/Screen Recording prompts, highlights, click-through. Last owner report was the hardened-runtime crash (fixed after); no report since the D38/D39 builds.

**Desktop next steps:** (1) owner tries the latest build on the Mac and reports (crash report if any; what Terminal printed); (2) fix what that shows; (3) places and names as highlights; (4) source app name on Windows; (5) multiple displays; (6) Wayland; (7) signing with the owner's Developer ID when available; (8) a public release page if the owner approves.

## Published pages (claude.ai artifacts, owner's account, private until shared)
- **Recast try-it page:** https://claude.ai/artifact/AavuzTXJUyJenKkLfLCUHN. Source: `apps/harness/dist/clay-artifact.html` (`pnpm --filter @recast/harness build`). Republish to the same link after any change to the harness, overlay, interaction or core.
- **Recast Engineering Status** (claude.ai artifact, owner's account): https://claude.ai/artifact/D1J6XJs7ieV4a9crCUX4jc. Built from this repository's own figures. Update it by republishing from a session that has its source, or rebuild from `docs/ENGINEERING_STATUS.md`.

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
00. **Desktop app on the owner's Mac** (see "Desktop app" above): the owner's current priority; respond to their report first.
0a. **Owner's real-Google runs:** `docs/REAL_TEST_PLAN.md` B, C, E, plus new **F** (Google Docs: enable Docs API and Drive API, sign in again ticking Drive), **G** (Google Maps: no setup) and **H** (GitHub: a fine-grained token for one test repository) and **I** (Linear: an API key).
0. **Run the tester protocol** (`docs/23-user-validation.md` section 4): owner shares the try-it link with 3 to 5 outsiders, one moderated session each; results in `docs/user-validation/`. Then the next milestone (section 5): a real-Google tester kit.
1. Recover the uncommitted edits (thread 1) and fix whatever breaks the two extension tests.
2. Owner runs `docs/REAL_TEST_PLAN.md` B1–B12 (extension → real Calendar), C1–C6 (Gmail drafts), D (confirmation setting), E1–E9 (page → Google Tasks). Record results in `docs/ENGINEERING_STATUS.md`; passing B and C moves those rows to R and strengthens the deck.
3. Finish the deck: ask, use of funds, team; confirm the guesses above.
4. Deploy: API and docs page to Vercel, database to Supabase (both connectors are available in Claude sessions). Gives the `/agents` page and developer docs live links.
5. Design-partner outreach from `docs/outreach/mcp-agent-startups.md`.

## Product direction (owner, 21 Oct)
- Recast should grow well beyond Calendar and Mail: anything on screen, put to work in any app. Aim for 10 to 15 excellent connectors first, not 100 logos. See `docs/24-integration-universe.md`: it maps the owner's proposal onto the existing contracts and grammar and lists the gaps (declared abilities per connector, deep-link bridges, code and file references, multi-destination plans). The owner's order starts with Google Drive and Docs, then Microsoft 365, Notion and Todoist, Slack, Linear and GitHub, Maps handoff, meeting links, webhooks.

## Build ideas queued (no owner input needed)
- Next in the owner's order, buildable against provider stand-ins (real runs need the owner's accounts): Todoist tasks; Microsoft 365 through Graph (Outlook calendar and mail, To Do); a generic webhook or custom URL destination with declared abilities; one capture → several destinations previewed together.
- Show a destination's declared abilities in the wheel (for example "can undo", "opens only").
- Files (PDF links) as documents, not only the page.
- Keyboard path in the extension beyond Escape (the clay page has it).
- (Done) The extension now reads the time zone fresh: a session started in another zone follows the current one (`setTimezone`; a reviewed operation keeps its zone).

## Session log (newest first, keep each entry short)
- **2026-10-26, session_01DBSr5JyLYdTt34JZYgfya1:** owner's context-layer thesis → D40: conflict sources, resolutions, `provenanceOf`, read-back verification (core `verify`, `Bridge.verify`, Calendar `verify`, machine `verify` effect + `verified`), glass shows sources/choices/read-back, try-it Invite/Chat/Plan tabs + drift switch; fixed day-month dates. Full run 988 passed, 0 failed, 5 skipped (no xdotool here). Electron binary must be fetched after install (`node node_modules/electron/install.js` in apps/desktop).
- **2026-10-23 (cont.):** CI was red on test races, fixed at the cause: an extension test clicked "Choose where it goes" by label and, under load, hit the previous screen's button with the same words (now clicks `[data-act=openWheel]`); a try-it test read the hint once (now waits); the desktop test waits for the browser window to settle and confirms its selection. Browser suites run sequentially in `pnpm test`. Full run 975/0.
- **2026-10-23 (cont.):** owner: highlight likely pieces when Recast is on, as on the try-it page (D39). Screen capture + OCR (tesseract.js, bundled English model) → spots (time, email, error, link) highlighted in place; click or drag one into a blob. Status pill at bottom centre. Found on the way: on Xvfb with no window manager the overlay sat under the browser, so the earlier click-through test passed for the wrong reason; tests now run openbox + xcompmgr. Packaged OCR needed `asarUnpack: node_modules/**` (its worker could not open archived dependencies) and time limits. Desktop 14/14 twice; packaged Linux launch check reads the screen (`ocr: ok`). CI: Electron binary now fetched explicitly (ci was red because it was missing).
- **2026-10-23 (cont.):** owner's redesign (D38): Recast works on top of any app. Double tap Option (Mac) / Ctrl (Win, Linux) → overlay over the current display; selections become blobs where they were made; click a blob → wheel beside it; place there. The Recast window is now a library of every grab (history.json). Keyboard hook: `uiohook-napi` (prebuilt, `npmRebuild: false`). Desktop tests 8/8 with real keys and mouse (xdotool) in a real browser window, including a click passing through the overlay. Owner's Mac (macOS 26) still to confirm: Accessibility, Option twice, click-through.
- **2026-10-23 (cont.):** owner's crash report (MacBook Neo, macOS 26.5.1) gave the real cause: ad-hoc signing + hardened runtime → dyld refuses Electron Framework ("different Team IDs"), killed at launch. GitHub's macOS runner tolerates it, so CI launch checks passed. Now: hardenedRuntime off unless signing with a Developer ID; CI fails an ad-hoc build that carries it; install-mac.sh re-signs old copies. Owner given `codesign --force --deep --sign - /Applications/Recast.app` as an immediate fix.
- **2026-10-23:** owner: Linux and Windows work, the Mac app "doesn't even open". CI had only run the binary from a terminal, skipping the person's path. Likely causes: Gatekeeper refuses a browser-downloaded app without a Developer ID; an old invisible copy still running takes over each new launch; ⌘⌥Space is Finder's. Added `apps/desktop/scripts/install-mac.sh` (from ~/Downloads: verify, quit old copies, install, clear quarantine, open), a CI install check (old copy running, quarantined download, opened via Launch Services), and ⌃⌥Space as the Mac open shortcut. A public GitHub Release for sign-in-free downloads was not created (needs the owner's go-ahead). Real fix for Gatekeeper: the owner's Apple Developer ID + notarisation.
- **2026-10-22 (cont.):** large files sent through chat arrived truncated (zip error 94), so Mac downloads are single-file GitHub artifacts (Recast-for-Mac-Apple-silicon / -Intel). Owner asked for a Windows .exe: fixed the Windows build (Tailwind's .bin shim cannot be spawned there; run its script with Node), x64-only NSIS, and a Windows launch check.
- **2026-10-22 (cont.):** owner: "disk image is corrupted". The 219 MB universal .dmg here was intact (its UDIF CRC32 matches), so it broke in transfer. Mac builds are now per architecture (arm64, x64), each as .dmg and .zip; CI runs `hdiutil verify` on every image and prints SHA-256s.
- **2026-10-22 (cont.):** owner: on the Mac "nothing opens". CI launch check (new, `--recast-smoke`, runs the app from the .dmg on a macOS runner) showed the app does start and sign correctly; what it showed was only a 420×64 see-through pill in a corner, with no Dock icon. Now: a Dock icon, and opening Recast shows the panel in front (the pill only for grabs). CI checks the panel is on screen on macOS and Linux. Owner to confirm on their Mac.
- **2026-10-22 (cont.):** owner said the first desktop app was just the try-it page in a wrapper; built system-wide grab (D37): select in any app + shortcut → object with its source; floating pill capsule; Mac Accessibility path (untested on a Mac). Desktop 8/8; Linux rpm/deb/AppImage rebuilt; `.dmg` from the `desktop` workflow.
- **2026-10-22 (cont.):** Electron desktop app (D36) with 6 end-to-end tests on a virtual screen, Linux packages built and launched, CI workflow for .dmg/.exe; plain-language risk lines in the review; 967/0.
- **2026-10-22 (cont.):** owner's mission brief: recipes / multi-destination runs with per-step outcomes (D35), capture-stack dedupe; tested on the try-it page and through the real local program (Google stand-in); 960/0. Next: Electron desktop app.
- **2026-10-22 (cont.):** Linear (D33); phase two: selection blobs (D34); try-it page phone tabs and axe fixes; 944/0.
- **2026-10-22 (cont.):** error → GitHub issue (D32): error piece, Issue object, GitHub bridge, local GitHub connection, extension and try-it page; 922/0.
- **2026-10-22 (cont.):** owner said Google Maps did not work on the try-it page; fixed (open the tab from code, report a refused tab with the address to copy; land on Maps in More); 911/0; republished.
- **2026-10-22, session_01Bdx3pBhgmXK4WtvwEoTnHb (cont.):** owner's integration direction: declared abilities (D30), Google/Apple Maps open-and-prefill, passages → Note → Google Docs (D31), extension drop-on-empty-page fix; full run 910/0; try-it page republished (Maps live, Docs stand-in).
- **2026-10-21, session_01Bdx3pBhgmXK4WtvwEoTnHb (later):** time-zone fix (`setTimezone`), full run 877/0; audit for outside users (no code changed during it); published the try-it page as a private artifact; wrote `docs/23-user-validation.md` (audit, journey table, run steps, tester protocol, next milestone).
- **2026-10-21, session_01Bdx3pBhgmXK4WtvwEoTnHb:** reconstructed context; re-ran `apps/extension` on committed code (28/28 pass); created this file and `CLAUDE.md`; built a whole page → real Google Tasks ("This page", Document clumps, Tasks permission, REAL_TEST_PLAN E); full run 862/0. Then a page + a date → a task due that day (D29, new relation and contract); fixed the extension's stuck "Combine" merge; fixed a time-zone race in the extension tests; full run 873/0 twice.
- **2026-10-21, earlier session (other account):** built the investor deck, filled market, prices, pilot and cover; owner removed the Ask slide.
- **2026-10-21, session_01DBSr5JyLYdTt34JZYgfya1:** Gmail drafts, extension → real Calendar via the local program, "How much Recast asks", full run 850/0, clay test timing fix.
