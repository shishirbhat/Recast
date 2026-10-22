# Integration universe: direction and how it maps onto Recast

Owner's direction, 21 October 2026. **Nothing here is a claim of support.** Everything below is a possible destination unless `docs/ENGINEERING_STATUS.md` says otherwise.

## The idea in one line

Recast should let anything a person meets on screen (a date, a place, a person, a sentence that is really a task, an error, a quote) be captured, combined with other pieces, and put to work in another app. Aim for 10 to 15 excellent connectors with real actions, then a long tail of open-and-prefill, share-sheet and community destinations. Do not ship 100 logos that only open another app.

## It fits the model Recast already has

The owner proposed a universal object and action model. Most of it already exists; the gaps are listed below.

| Owner's term | In the repository today | Gap |
|---|---|---|
| Captured objects (`DateTime`, `Person`, `Place`, `URL`, `TextExcerpt`, `Task`, `Event`, `CodeReference`, `FileReference`) | Fragment kinds `person, place, time, text, title, thing, page` (`packages/core/src/compose.ts`); object types `Person, Document, Event, Location, Image, Message, Task, Product, ResearchPaper` (`schema/common/envelope.schema.json`) | No `CodeReference` (error, file and line, commit) and no `FileReference`. **Done (D31):** passages pressed together are a `Note` that keeps each passage's page |
| Each destination declares the actions it supports | Capability contracts (`packages/bridges/src/contracts.ts`, `schema/contracts/capability.schema.json`), checked against the grammar (`schema/grammar/relations.json`). A contract may raise risk, never lower it | **Done (D30):** contracts declare `abilities` (open, create, read, update, search, delete, verify, undo), checked against each bridge's operations |
| Level 1: open and prefill | `reliability: "deep-link"` exists in the schema | **Done (D30):** Google Maps and Apple Maps directions from a place. The review is a real link; done says "Opened", with no Undo |
| Level 2: native action | `reliability: "official-api"`: Google Calendar (R), Gmail drafts and Google Tasks (F, through `apps/calendar-link`) | Per-provider OAuth; only Google so far |
| Level 3: deep integration | Reconcile (check after an unknown outcome), Undo with receipts, duplicate guard | Search existing objects, resolve identities, detect conflicts at the destination |
| Provenance preserved | Every property carries evidence, source URL and title (`provenance`, `fields[*].evidence`) | It reaches the destination only through `dataMoved`. A source link per passage in a note is not built yet |
| One capture, several destinations, all previewed first | One placement at a time (`packages/interaction` state machine) | A multi-destination plan: several operations, one review, each with its own receipt and Undo |

## Workflows to design for (owner's list)

1. Any date or time → a real event (built for Google Calendar).
2. Any sentence → a tracked task with due date and source link (page → Google Tasks built; a sentence as a task is not).
3. Any error → a bug report for GitHub, GitLab, Jira or Linear, with sources kept.
4. Any context → a ready-to-send message (Gmail drafts built; Slack and others not).
5. Any research → a sourced note, with each quote keeping its URL (built: passages → a note → Google Docs, D31).
6. One capture → several coordinated destinations, all shown before any runs.

## Order proposed by the owner (not a plan of record yet)

1. Google Calendar, Gmail, Google Drive and Docs
2. Microsoft 365 (Outlook mail and calendar, OneDrive, To Do, Teams) through Microsoft Graph
3. Notion and Todoist
4. Slack, Linear and GitHub
5. Google Maps and Apple Maps handoff
6. Zoom, Google Meet and Teams links
7. Generic webhook, Shortcuts and custom URL actions

The full catalogue (calendars, tasks, mail, chat, contacts, notes, documents, tables, project tools, developer tools, files, design, research, maps, meetings, CRM and support, publishing, education, media, automation) is in the owner's message of 21 October 2026. It is a list of destinations to evaluate, not of commitments.

## Rules every connector keeps

- It declares what it can do (read, create, update, search, delete, verify, undo) and the product shows only that. A destination that cannot undo never shows Undo. One that cannot verify says "opened" or "sent", never "added".
- It previews before writing, never changes things silently, and reports an unknown outcome as unknown.
- Mock-provider evidence (F) and real-provider evidence (R) are recorded separately, as for Google today.
