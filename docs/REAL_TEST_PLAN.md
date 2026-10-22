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

