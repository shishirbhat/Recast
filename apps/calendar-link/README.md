# Connect Google Calendar (local, step by step)

This small program runs **on your own computer** at `http://localhost:8787`. It lets you sign in with a Google account so Recast can add events to that account's calendar, and remove the events it added. Nothing is hosted or deployed.

- **What it isn't:** the Recast Clay Desk artifact on claude.ai is a separate, static page running in claude.ai's sandbox. It cannot read your computer's files or this program's settings, and it does not use this sign-in. It keeps using its built-in stand-in calendar.
- **What this program does today:** the sign-in; a test event you can place, check and undo (Part 5); and a door for the Recast browser extension, so placing in Calendar from the glass module adds a real event (Part 6).

Use a **throwaway Google account**, not your personal one.

## Part 1: Create the Google OAuth app (about 10 minutes, once)
1. Sign in to <https://console.cloud.google.com/> with the throwaway account.
2. **Create a project:**
   1. Click the project picker at the top, then **New project**.
   2. Name it `Recast test` and click **Create**.
   3. Make sure it is selected in the picker.
3. **Turn on the Calendar API:**
   1. Search for **Google Calendar API** in the top search bar.
   2. Open it and click **Enable**.
4. **Set up the consent screen:**
   1. Go to **APIs & Services → OAuth consent screen**. Newer consoles call it **Google Auth Platform → Branding / Audience**.
   2. App name: `Recast test`. User support email and developer contact: the throwaway address.
   3. User type / Audience: **External**. Leave the publishing status as **Testing**.
   4. Under **Test users**, add the throwaway account's email. Only test users can sign in, and that's what we want.
   5. Scopes: you can skip this page. The program asks only for "See, edit, share, and permanently delete all the calendars you can access using Google Calendar → events". That is the scope `.../auth/calendar.events`.
5. **Create the credentials:**
   1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   2. Application type: **Web application**. Name: `Recast local`.
   3. **Authorized redirect URIs → Add URI**, exactly: `http://localhost:8787/oauth/callback`. No trailing slash, `http` not `https`, and `localhost` not `127.0.0.1`.
   4. Leave **Authorized JavaScript origins** empty.
   5. Click **Create**. Google shows a **Client ID** (ending in `.apps.googleusercontent.com`) and a **Client secret**. Keep that window open for Part 2.
   6. Don't paste these into a chat, an email, or any file except the one below.

## Part 2: Put the credentials on your computer
In a terminal, in your Recast folder:
```
git pull
pnpm install
pnpm --filter @recast/calendar-link run setup
```
It asks for the **Client ID**, then the **Client secret**. Paste each one and press Enter. The secret stays hidden while you paste it.

It saves them in `apps/calendar-link/.env`, which only you can read and git ignores.

## Part 3: Start the sign-in page
```
pnpm --filter @recast/calendar-link run start
```
- **If it worked,** you'll see: `Recast Google Calendar sign-in is running. Open http://localhost:8787/ in your browser.`
- **If something is wrong,** it says what. For example, "GOOGLE_CLIENT_ID is missing in .env".
- **Keep this window open while you use the page.** Press Ctrl+C there to stop it.

## Part 4: Authorize the throwaway account
1. Open **<http://localhost:8787/>** in the browser on the same computer. It says "Not connected yet".
2. Click **Sign in with Google**.
3. Choose the **throwaway** account.
4. Google warns "Google hasn't verified this app". That's expected for an app in Testing that only you use. Click **Continue**.
5. On the permission screen, **tick the box for calendar events** if there is one, then click **Continue**.
6. You land back on a page that says **Connected**.

The permission is saved in `apps/calendar-link/.secrets/google-token.json`. It's readable only by your user and ignored by git. Don't share it.

**To undo everything:** open <http://localhost:8787/> and click **Disconnect and remove the permission**. This revokes it at Google and deletes the file. You can also remove access at <https://myaccount.google.com/permissions>.

## Part 5: Place a test event (real Google Calendar)
After you're connected, the page shows **Try it with a test event**. Open <https://calendar.google.com/> for the throwaway account in another tab, and look at tomorrow.
1. **Place a test event.** "Recast test event" appears tomorrow 10:00–11:00.
2. **Place again.** The page says it's already there. Your calendar still shows **one** event.
3. **Check.** The page asks Google and says the event is there.
4. **Undo.** The event disappears. **Check** now says it's gone.
5. **Place with a lost answer.** The event really is added, but the page ignores Google's reply on purpose. It says it doesn't know whether it worked. Press **Check**: Google says it's there. Press **Place** once more: still one event. Then **Undo**.

Recast remembers the last test event in `apps/calendar-link/.secrets/test-event.json` (git-ignored), so Undo works after a restart.

## Part 6: Let the Recast extension use it
1. Follow `docs/REAL_TEST_PLAN.md`, section B. In short:
   1. Build and load the extension.
   2. Click **Connect the real Google Calendar** in its popup.
   3. On this page, click **Allow** next to the matching code.
2. **What the extension sees:** it never gets the Google permission. It sends the event you reviewed, and this program places it.
3. **Who can use it:** only extensions you allowed here. Web pages can't use it.
4. **What's stored:** the allowed extensions and the receipts (for Undo), in `.secrets/`.

## Part 7: Gmail drafts (optional)
1. The sign-in also offers Gmail. If you tick it, Recast can **create drafts and delete the drafts it made**. It never sends mail: you send a draft yourself from Gmail.
2. Turn on the **Gmail API** in Google Cloud first. Then sign in again and tick both boxes. The steps are in `docs/REAL_TEST_PLAN.md`, section C.
3. If you leave Gmail unticked, Calendar works as before.

## Part 8: Google Tasks (optional)
1. The sign-in also offers Google Tasks. If you tick it, Recast can **add a task to your default list and delete the tasks it added**. Google has no narrower permission than "see, edit, create and delete your tasks", so this is what Google's screen will say; Recast uses only add and delete-its-own.
2. Turn on the **Google Tasks API** in Google Cloud first. Then sign in again and tick the Tasks box. The steps are in `docs/REAL_TEST_PLAN.md`, section E.
3. In the extension, **This page** (in the Recast pill) takes the whole page as one object; Tasks adds it with the page title and its link.

## Part 9: Google Docs (optional)
1. The sign-in also offers Google Drive, with the narrowest permission Google has: **only the files Recast creates** (`drive.file`). If you tick it, Recast can create a Google Doc from a note and move that document to the trash on Undo. It cannot see or change any other file in your Drive.
2. Turn on two APIs in Google Cloud first: **Google Docs API** and **Google Drive API**. Then sign in again and tick the Drive box. The steps are in `docs/REAL_TEST_PLAN.md`, section F.
3. In the extension, select a sentence on a page and Alt-drag it; press a second one into it. Two passages make a note, and **Documents** creates the Google Doc, each passage followed by the page it came from.

## If something goes wrong
| You see | Fix |
|---|---|
| `Error 400: redirect_uri_mismatch` (on Google's page) | The redirect URI in Part 1, step 5 must be exactly `http://localhost:8787/oauth/callback` |
| `Access blocked: … has not completed the Google verification process` | Add the throwaway email under **Test users** (Part 1, step 4) |
| "The client ID or secret in your .env file does not match Google's" | Copy both values again from Credentials; check that there are no spaces or quotes |
| "That sign-in was not accepted" | Start again from <http://localhost:8787/>, and finish within 10 minutes in the same browser |
| `EADDRINUSE` when starting | Something else uses port 8787: set `PORT=8788` in `.env` **and** change the redirect URI in Google to `…:8788/oauth/callback` |
