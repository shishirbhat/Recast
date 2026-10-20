# 11. Destination bridges (as data, no live calls)

`packages/bridges` describes five destinations and how to place into them: Google Calendar (attendee, location), Gmail (a **draft**, never a send), Google Sheets (append a row), Google Tasks, and Notion. Each one is a capability contract that passes the real schema and grammar checks, plus request builders and undo for its API.

## How it is tested
Every bridge runs through the real core pipeline (propose, plan, commit, undo). Only the network is faked: a recording transport answers like each API's reference docs say. 21 tests.

## Safety properties tested
- Calendar: the existing attendees are re-sent with the new one (the API replaces the whole list), with `sendUpdates=none` so Recast never emails an invitee by itself. Undo restores exactly the previous attendees or location. Adding someone already there is a no-op.
- Gmail: a recipient containing a line break is refused, so a web page cannot add a hidden Bcc header. Drafts only; undo deletes the draft.
- Sheets: values are written `RAW`, so a product named `=IMPORTXML(...)` lands as text, never a formula. A response without the written range is an error.
- IDs from the page or window are URL-encoded, so they cannot change which resource a request targets.
- A failing destination (for example a 403) fails the placement and is logged as failed, not done.
- Nothing in the package calls `fetch`. The caller passes a transport, which is where the user's token lives.

## Not verified
- **Nothing here has talked to a real service.** Request shapes come from my reading of each API's docs. A wrong URL, scope or field name would only show up against the live API.
- No authentication (OAuth) flow exists. Tokens, scopes and refresh belong to the shell that supplies the transport.
- Targets (which event, which sheet, which database) are passed in by the caller; the Windows shell has to work out which window the user is pointing at.
- Sheets undo clears the range that was written; if rows were inserted above it in the meantime, that range may no longer be the same row.
