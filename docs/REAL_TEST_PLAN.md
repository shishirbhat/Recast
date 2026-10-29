# Real test plan (run by a person, at the end of the build)

Everything below is already tested against **stand-ins** (fake Google, fixture pages). This is the checklist for running it once against the **real** services. Work top to bottom. Note the first step where what you see differs from "You should see", and report that step's number.

Status levels: nothing here counts as **R** (real provider) until it has been run from this list. Results go in `docs/ENGINEERING_STATUS.md`.

## A. Google Calendar sign-in and test event (`apps/calendar-link`). **Done: R, 2026-10-21**
See `apps/calendar-link/README.md`, Parts 1–5. All five test-event steps were reported working.

## B. The extension places in the real Google Calendar
**Checks:** extension ↔ local program pairing, the glass module's Calendar choice, placement, Undo, and a lost answer.

**Setup, once:**
1. Pull and install:
   ```
   git pull recast claude/clever-heisenberg-s3taqj
   pnpm install
   ```
2. Build the extension: `pnpm --filter @recast/extension run build`
3. Load it in Chrome:
   1. Open `chrome://extensions`.
   2. Turn on **Developer mode** (top right).
   3. Click **Load unpacked** and choose the `apps/extension/dist` folder.
   4. Pin Recast with the puzzle-piece icon.
4. Start the program: `pnpm --filter @recast/calendar-link run start`. It must say "Connected" at http://localhost:8787/.

| # | Do | You should see | Checks |
|---|---|---|---|
| B1 | Click the Recast icon. Under **Google Calendar**, click **Connect the real Google Calendar** | Chrome asks to let Recast read and change data on `localhost`. Allow it. The popup then shows a 4-digit code | permission scoped to localhost only |
| B2 | Open http://localhost:8787/ | "An extension asks to place events…" with the **same** code | pairing request |
| B3 | Click **Allow**, then **I allowed it** in the popup | Popup: "Connected. Placing in Calendar adds a real event, with Undo." | pairing |
| B4 | Open a page that shows a time and a place, e.g. a restaurant booking page. Press Alt+Shift+R. Alt-drag the time onto the place | The glass module opens with the composition | composition |
| B5 | **Choose where it goes** → Calendar | The option reads "Google Calendar", with **no** "stand-in" label | the real destination is offered |
| B6 | **Open**, answer the title if asked, then **Add to calendar** | "Added to Google Calendar". The event appears in Google Calendar at that time | real write |
| B7 | **Undo** | The event disappears from Google Calendar | real undo |
| B8 | Place the same thing again, then press **Done** | One event in Google Calendar | — |
| B9 | Place the **same** composition once more | "Already in your Google Calendar, so it was not added a second time". Still one event | duplicate protection |
| B10 | Stop the program (Ctrl+C), place something new | "…did not answer". The module offers **Check** | unknown outcome |
| B11 | Start the program again, then press **Check** | Google is asked. The module says whether it was added, never adding it twice | reconcile |
| B12 | At http://localhost:8787/, click **Remove** under Allowed | Calendar goes back to "not connected" the next time the popup opens | unpairing |

## C. Gmail drafts (needs the Gmail permission)
**Checks:** the optional Gmail permission, a real draft created and deleted, nothing ever sent.

**Setup, once:**
1. In Google Cloud (same project), turn on the Gmail API: search **Gmail API**, then click **Enable**.
2. Under **Data access / Scopes** you can leave the scopes alone. The program asks for `gmail.compose` itself. Google lists it as a restricted scope. That's fine for an app in **Testing** used only by its test users, so no verification is needed.
3. At http://localhost:8787/, click **Sign in with Google** again. On Google's screen, **tick both boxes**: calendar events and Gmail.

| # | Do | You should see | Checks |
|---|---|---|---|
| C1 | Open http://localhost:8787/ | "Permission: … Create and delete Gmail drafts (never sends mail)." | permission recorded |
| C2 | Open the Recast popup | "Mail saves a real Gmail draft (never sent)." | extension sees it |
| C3 | On a page with a person's name and a sentence: select the sentence, Alt-drag it onto the name | The module shows "Message …" | message composition |
| C4 | **Choose where it goes** → Mail → **Open**. If asked, type the address, then click **Save as draft** | "Saved"/receipt. In Gmail → **Drafts**, a draft to that address with that sentence. **Sent** has nothing new | real draft, not sent |
| C5 | **Undo** | The draft disappears from Gmail Drafts | real undo |
| C6 | Sign in again with only the calendar box ticked | The popup says Gmail drafts are not allowed. Mail shows as unavailable | permission is optional |

## D. How much Recast asks (no provider needed)
**Checks:** the first-run question, the setting, and that it still asks when it matters.

| # | Do | You should see | Checks |
|---|---|---|---|
| D1 | Open the Recast popup for the first time after installing | "How much should Recast ask?", highlighted, with "Choose once; you can change it here any time." | asked once |
| D2 | Choose **Only when it matters**, then close and reopen the popup | The choice is kept and the highlight is gone | stored |
| D3 | Compose an event, then **Choose where it goes** → Calendar → **Open** | Placed straight away, with Undo. No review | none |
| D4 | Compose a message with no email address on the page → Mail | The review opens and asks for the address | missing info still asked |
| D5 | Switch back to **Every time** and repeat D3 | The review opens first | high |
| D6 | Quit and restart Chrome, then open the popup | Your last choice is still selected | survives restarts |

## E. A whole page to Google Tasks (needs the Tasks permission)
**Checks:** the optional Tasks permission, taking a page whole, a real task created and deleted.

**Setup, once:**
1. In Google Cloud (same project), turn on the Tasks API: search **Google Tasks API**, then click **Enable**.
2. The program asks for the `tasks` scope itself (Google has no narrower one). It is not a restricted scope; an app in **Testing** works for its test users.
3. At http://localhost:8787/, click **Sign in with Google** again. On Google's screen, **tick the Tasks box** (calendar events stays ticked).

| # | Do | You should see | Checks |
|---|---|---|---|
| E1 | Open http://localhost:8787/ | "Permission: … Add tasks to your default Google Tasks list, and remove the ones Recast added." | permission recorded |
| E2 | Open the Recast popup | "Tasks adds a page to Google Tasks." | extension sees it |
| E3 | On any article page, turn Recast on (Control twice, or the popup button). In the pill, click **This page** | The module opens on one object named after the page | page taken whole |
| E4 | **Choose where it goes** | The wheel rests on **Tasks**. Calendar and Mail are unavailable, with "… takes events; this is a document" and similar | fit rules |
| E5 | **Open** | The review shows the page title and its link, with no "stand-in" note | review |
| E6 | Click **Add a task** | "Placed". In Google Tasks (calendar.google.com side panel, or tasks.google.com), the default list has a task with the page title, and the link in its details | real task |
| E7 | **Undo** | The task disappears from Google Tasks | real undo |
| E8 | Take the same page again → Tasks → stop the program (Ctrl+C) before clicking **Add a task**, then click it | "…did not answer". **Check** says Google Tasks can't be asked about one task and tells you to look. Nothing is added twice | honest unknown |
| E8b | On a page with a date on it (e.g. "Friday 23 October, 5:00 PM"): **This page**, then Alt-drag the date onto the object in the module | "Combine them?" (it turns the document into a task). Click **Combine** | page + date |
| E8c | **Choose where it goes** → Tasks → **Open** | The review shows Title, Link, **Due** with the day, and "the time (5:00 PM) is not kept" | due date |
| E8d | **Add a task**, then look in Google Tasks | The task is due on that day. Then **Undo**: it disappears | real due date |
| E9 | Sign in again without the Tasks box | The popup says Google Tasks is not allowed. Tasks shows as unavailable | permission is optional |

## F. Passages to a Google Doc (needs the Google Drive permission)
**Checks:** the optional Drive permission (only files Recast creates), passages pressed into a note, a real document created with each passage's source, and Undo moving it to the trash.

**Setup, once:**
1. In Google Cloud (same project), enable **Google Docs API** and **Google Drive API** (search each name, then **Enable**).
2. On the OAuth consent screen, the program asks for `drive.file` itself. It is not a restricted scope; an app in **Testing** works for its test users.
3. At http://localhost:8787/, click **Sign in with Google** again. On Google's screen, **tick the Google Drive box** ("only the specific files you use with this app"); keep the others ticked.

| # | Do | You should see | Checks |
|---|---|---|---|
| F1 | Open http://localhost:8787/ | "Permission: … Create Google Docs, and move the ones Recast created to the trash (it sees no other files)." | permission recorded |
| F2 | Open the Recast popup | "Documents creates a Google Doc from a note." | extension sees it |
| F3 | On an article, turn Recast on. Select a sentence, Alt-press it and let go on empty space | One object on the desk, named after the sentence | a passage |
| F4 | On another page, select a sentence and Alt-drag it onto that object | One object: a note, "2 passages · from 2 pages" | passages combine |
| F5 | **Choose where it goes** | The wheel rests on **Documents** (Google Docs). Calendar and Mail are unavailable, with their reasons | fit rules |
| F6 | **Open** | The review shows **Text**: each passage in quotes, then the page title and address it came from. Title is missing, with a suggestion (the first page's title). No "stand-in" note | review, provenance |
| F7 | Accept the suggested title (or type one), then **Create a document** | "Added to Google Docs". In Google Drive, a new document with that title; inside, the passages and their sources, line by line | real document |
| F8 | **Undo** | The document moves to the Drive trash (you can restore it from there) | real undo |
| F9 | Make another note → Documents → stop the program before clicking **Create a document**, then click it | "…did not answer". **Check** says Google Docs can't be asked about one document and tells you to look in Drive. Nothing is created twice | honest unknown |
| F10 | Sign in again without the Drive box | The popup says Google Docs is not allowed. Documents is unavailable for a note | permission is optional |

## G. A place to Google Maps (no account, no permission)
**Checks:** open and prefill: the review is a link, the real Google Maps opens with directions, and Recast says "opened", never "added".

| # | Do | You should see | Checks |
|---|---|---|---|
| G1 | On a restaurant or venue page with an address, turn Recast on. Alt-press the name and let go on empty space | One object on the desk: the place | a place on its own |
| G2 | Click the object, then **Choose where it goes** in "Inside this object" | The module opens; the wheel rests on **More** | placeable alone |
| G3 | **Open**, then pick **Google Maps** | The review shows Title/Where, and "Opens Google Maps in a new tab with this filled in. Recast saves nothing; you finish there." | honest review |
| G4 | Click **Open directions in Google Maps** | A new tab: Google Maps with directions to that place. The module says "Opened Google Maps", with no Undo | real handoff |
| G5 | Try the same on the try-it page (Dakshin) | The same, opening the real Google Maps | try-it page |

## H. An error to a GitHub issue (needs a GitHub token for one repository)
**Checks:** the separate GitHub connection, an error captured from a page, a real issue opened with everything quoted, and Undo closing it.

**Setup, once:** follow `apps/calendar-link/README.md` Part 10 (a fine-grained token for one test repository, Issues read and write; connect it on http://localhost:8787/).

| # | Do | You should see | Checks |
|---|---|---|---|
| H1 | Open http://localhost:8787/ | "Connected to owner/name." under GitHub issues | connection |
| H2 | Open the Recast popup | "An error opens an issue in GitHub owner/name." | extension sees it |
| H3 | On a page with an error (a failed CI log, or any page where you paste `TypeError: x is undefined`), turn Recast on, select the error line, Alt-press it and let go on empty space | One object: the error | error piece |
| H4 | Optional: select a sentence of notes and Alt-drag it onto the error | One object: an issue, "2 pieces" | notes join |
| H5 | **Choose where it goes** → Tasks (GitHub) → **Open** | The review shows the body: the error and notes in quoted blocks, then "Seen on" with the page. Title missing, with the error's first line suggested | review |
| H6 | Accept the title, then **Confirm: Open an issue** | "Added to GitHub owner/name". On github.com, a new issue with that title and body; text like `@name` in the notes shows as plain text and notifies nobody | real issue |
| H7 | **Undo** | The issue is closed as "not planned" (it is not deleted: GitHub does not allow that without admin rights) | real undo |
| H8 | Disconnect GitHub on the local page | GitHub is no longer offered in Tasks | optional |

## I. An error to a Linear issue (needs a Linear API key)
**Setup, once:** `apps/calendar-link/README.md` Part 11.

| # | Do | You should see | Checks |
|---|---|---|---|
| I1 | Open http://localhost:8787/ | "Connected to the … team" under Linear issues | connection |
| I2 | Capture an error as in H3, then **Choose where it goes** | Tasks reads "Linear" (or "GitHub or Linear" if both are connected) | offered |
| I3 | **Open** (if both: pick **Linear** in "Tasks: which one?") | The review, as in H5 | choice |
| I4 | **Confirm: Create an issue** | In Linear, a new issue on that team, with the quoted body | real issue |
| I5 | **Undo** | The issue is deleted (in Linear's trash) | real undo |

## J. Phase two: select any text (no account)
| # | Do | You should see | Checks |
|---|---|---|---|
| J1 | On any article, turn Recast on. Select a sentence with the mouse | A blob beside the selection: a quote mark, the start of the text, "Text" | blob appears |
| J2 | Drag the blob onto empty page space | It is on your desk | carry and put down |
| J3 | Select another sentence (any tab) and drag its blob onto that object | One note of both, each with its page | combine |
| J4 | Select a date like "Friday 23 October, 7:30 PM" | The blob says "Time" | reading |
| J5 | Select an email address | The blob says "Person" | reading |
| J6 | Turn Recast off and select text | No blob: selecting is just selecting | off means off |
| J7 | Type in a search box and select what you typed | No blob | fields left alone |

## K. The desktop app (macOS first, then Windows and Linux)
| # | Do | You should see | Checks |
|---|---|---|---|
| K1 | Install from the desktop workflow's artifact; open it (Mac: right-click → Open the first time) | A small Recast window, dark if your system is dark, and a capsule icon in the menu bar or tray | installs, no white flash |
| K2 | Copy "Friday 7:30 PM" in any app, then press ⌘⌥Space (Ctrl+Alt+Space) | Recast comes forward with a "Friday 7:30 PM" time object | clipboard capture |
| K3 | Click the box, press Fn twice (Mac) or Win+H, say "Dinner with Maya" | The words appear; Enter adds an object | voice via the OS |
| K4 | Drag one onto the other → Choose where it goes → Google Calendar → Add | A real event (after Connections and sign-in); Undo removes it | real Google |
| K5 | Run "Plan and prepare" on another event | Both steps done, each listed; the task in Google Tasks | recipe on real accounts |
| K6 | Quit from the tray and open again | The objects you left are still there | inbox |
| K7 | Settings: switch Dark / Light / Match the system | The whole window changes, with no white panels in dark | themes |


## L. Verify and Confirm on the real path (Google Calendar; no new setup beyond section B)
**Checks:** after a placement, Recast reads the event back from your Google Calendar and says so; the link opens the event; failures are stated, never shown as success. (The read-back runs once, right after placing.)

| # | Do | You should see | Checks |
|---|---|---|---|
| L1 | Place an event in Google Calendar from the extension (as in B4–B6), or from the desktop app | "Added to Google Calendar", then within a second or two "Read back from Google Calendar: 5 of 5 fields match. Open in Google Calendar" | real read-back |
| L2 | Click **Open in Google Calendar** | The event opens in Google Calendar in a new tab | link to the created item |
| L3 | Place the same composition again | "It is already in your Google Calendar, so it was not added a second time"; still one event | no duplicate |
| L4 | In Google Account → Security → Third-party access, remove Recast's access; then place something | "Google no longer accepts this sign-in (expired or revoked). Sign in again on the Recast page" — and nothing claims it was added | auth failure stated |
| L5 | Sign in again ticking only Tasks (untick Calendar), then place an event | A refusal naming the missing Google Calendar permission | permission failure stated |
| L6 | Turn Wi-Fi off, place an event, turn Wi-Fi on | "did not answer… it may or may not have been made", then **Check** asks Google; never a second write | uncertain outcome |
| L7 | With Gmail, Tasks, Docs, GitHub or Linear connected (sections C, E, F, H, I), place one item in each | Each receipt adds "Read back from <app>: N of N fields match" and, except Gmail, "Open in <app>" (Gmail links to the Drafts folder) | read-back beyond Calendar |

## M. Outlook Calendar (needs a Microsoft app: apps/calendar-link README, Part 12)
**Checks:** Microsoft sign-in on this computer, a real Outlook event placed, read back with its link, refused twice, checked after a lost answer, undone.

| # | Do | You should see | Checks |
|---|---|---|---|
| M1 | Put `MICROSOFT_CLIENT_ID` in `.env`, restart, open http://localhost:8787/ and click **Sign in with Microsoft** | Microsoft's sign-in, a consent screen naming "Read and write your calendars", then "Connected to Outlook Calendar." | sign-in, one permission |
| M2 | Open the Recast popup (or reload the desktop app) | Outlook Calendar is offered; with Google Calendar also connected, Calendar asks "which one?" | destination offered |
| M3 | Compose an event, choose Calendar → Outlook Calendar, **Add to calendar** | "Added to Outlook Calendar", then "Read back from Outlook Calendar: 5 of 5 fields match. Open in Outlook Calendar"; the event is in Outlook at the right time | real write + read-back |
| M4 | Click **Open in Outlook Calendar** | The event opens in Outlook on the web | link |
| M5 | Place the same composition again | "It is already in your Outlook Calendar, so it was not added a second time" | no duplicate |
| M6 | **Undo** | The event disappears from Outlook | undo |
| M7 | At the bottom of http://localhost:8787/, **Disconnect Outlook** | Outlook is no longer offered | disconnect |
| M8 | Add `Mail.ReadWrite` and `Tasks.ReadWrite` to the app registration; on the Recast page tick **Outlook mail drafts** and **Microsoft To Do**, then **Sign in with Microsoft** | Microsoft's consent lists reading and writing your mail and your tasks; the page then says "Allowed: calendar events, mail drafts (never sent), To Do tasks" | optional permissions |
| M9 | Press a person (with an email address) into a sentence; Mail → Outlook drafts → **Save as draft** | "Read back from Outlook: 2 of 2 fields match. Open in Outlook"; the draft is in Outlook's Drafts, not sent | real draft + read-back |
| M10 | **This page** on an article; Tasks → Microsoft To Do → **Add a task** | The task is in To Do's default list with the page link in its note; read back 2 of 2 | real To Do task |
| M11 | **Undo** on each | The draft and the task disappear | undo |

## N. Todoist (needs a Todoist account: apps/calendar-link README, Part 13)
**Checks:** the token is checked before saving; a real Todoist task placed, read back with its link, undone; a refused token is stated.

| # | Do | You should see | Checks |
|---|---|---|---|
| N1 | At http://localhost:8787/, paste a wrong value under **Todoist** and **Connect** | "That does not look like a Todoist API token…"; nothing saved | input checked |
| N2 | Paste the real token and **Connect Todoist** | "Connected to Todoist." | token checked with Todoist |
| N3 | In the extension, **This page** on any article, Choose where it goes → Tasks (→ Todoist if Google Tasks is also connected) → **Add a task** | "Added to Todoist", then "Read back from Todoist: 2 of 2 fields match. Open in Todoist"; the task is in your Inbox with the page link in its description | real write + read-back |
| N4 | Click **Open in Todoist** | The task opens in Todoist | link |
| N5 | **Undo** | The task disappears from Todoist | undo |
| N6 | The page plus a date (as in E8b), placed in Todoist | The task is due on that day | due date |
| N7 | In Todoist, reset the API token (Settings → Integrations → Developer), then place something | "Todoist no longer accepts the saved key. Connect it again on the Recast page"; nothing claims it was added | auth failure stated |

## O. Notion (needs a Notion workspace: apps/calendar-link README, Part 14)
**Checks:** the database and token are checked before saving; a real page is added, read back with its link, and archived; a database not shared with the integration is explained.

| # | Do | You should see | Checks |
|---|---|---|---|
| O1 | Paste the token and a link to a database you did **not** share with the integration | "Notion cannot see that database with this token… ••• → Connections, add your integration…"; nothing saved | permission explained |
| O2 | Share the database with the integration and connect again | "Connected to <database name>." | database found |
| O3 | In the extension, **This page** on an article → Documents → **Add a page** | "Read back from Notion · <name>: 2 of 2 fields match. Open in Notion · <name>"; the page is in the database with the article's title and link | real write + read-back |
| O4 | **Open in Notion** | The new page opens in Notion | link |
| O5 | **Undo** | The page is archived (moved to Notion's trash) | undo |
| O6 | Connect a database that has no URL column, and place a page | The link is in the page's text; the read-back compares the title | no link column |

