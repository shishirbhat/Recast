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
