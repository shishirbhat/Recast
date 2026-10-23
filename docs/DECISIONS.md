# Decision log

Consequential architecture and product decisions, so that separate workstreams don't implement incompatible assumptions. Newest at the bottom. Each entry lists what would justify changing it.

---

### D1. One pure core; every shell injects I/O
- **Decision:** `@recast/core` has no network, disk, clock or randomness of its own. Desktop, extension, API, MCP server and agent runtime all inject those.
- **Context:** the same object, trust and action semantics must hold on Windows, in the browser and on servers.
- **Alternatives:** separate logic per shell; a cloud-only engine.
- **Why:** one tested behaviour everywhere, local-first by construction, deterministic tests.
- **Consequences:** shells are thin adapters, and conformance fixtures let non-TypeScript shells prove parity.
- **Change if:** a shell needs semantics the core cannot express without I/O.

### D2. JSON Schema is the single object model
- **Decision:** `schema/` is the source of truth; TypeScript types and validators are generated. New capabilities (composition, recipes, Spaces) extend this model, never fork it.
- **Alternatives:** hand-written types per package.
- **Change if:** schema generation blocks a needed construct.

### D3. Risk comes from the effect, not from model confidence
- **Decision:** the trust model classifies an action by what it does (notifies someone, irreversible, sends). Embedding and LLM stages can lower confidence or add alternatives. They never raise confidence above 0.7, and they never lower a risk tier.
- **Why:** a confident model must not make a risky action easier.
- **Change if:** never silently. Changing this needs a security review.

### D4. Resolution is rules first, then optional embedding, then optional LLM
- **Decision:** deterministic rules answer first; later stages are optional, behind breakers, and report `degraded`.
- **Why:** cost, latency and honesty. The engine works with no provider configured.
- **Change if:** measured accuracy on unseen inputs shows rules are the bottleneck and a model measurably fixes it.

### D5. What runs where
- **Decision:**
  - **Local:** extraction, the interaction engine, the resolver and the MCP server in local mode.
  - **Remote:** the developer API, and placements through the API using stored destination credentials.
  - **Agent runtime:** a deployable server in front of MCP tool servers.
  - The desktop product must not need the cloud for every operation.
- **Change if:** a capability genuinely needs shared state the device cannot hold.

### D6. Postgres (Supabase) with row-level security; reuse tenants
- **Decision:** one schema. People-surface rows are owned per user; API and agent rows belong to `tenants` and `tenant_members`. Servers connect privileged, but the control center runs each request as the signed-in user (`withUser`) so RLS decides. There are no duplicate user tables.
- **Change if:** a hosted multi-region requirement forces a different store.

### D7. Audit: hash chain, signatures, raising triggers; erasure through a receipt
- **Decision:**
  - Every audit entry is hash-chained and Ed25519-signed.
  - The database refuses updates, deletes and truncates, and makes forks impossible (unique `prev_hash`).
  - Erasure goes through `erase_tenant()`, which writes an append-only receipt.
- **What this detects:** edits, deletions, reordering and forks, by anyone without the signing key. It also stops ordinary roles from deleting.
- **What it does not stop:** a superuser dropping triggers, or someone holding the signing key. Those are detected only against an exported copy and its head hash.
- **Change if:** an external transparency log or a KMS-held key becomes available.

### D8. Shared API state in Postgres, not Redis
- **Decision:** rate buckets and idempotency records live in Postgres (`take_token`, a claim-first idempotency row).
- **Why:** one fewer service, correct across instances, tested.
- **Change if:** measured database load from limiting becomes significant. `Limiter` is an interface, so Redis or Upstash can drop in.

### D9. MCP refusals are JSON-RPC errors over HTTP 200
- **Decision:** a denial is `-32003`; pending approval is `-32004` with an `approval_id`; both carry an `x-recast-decision` header.
- **Why:** the official MCP client hangs on a 202. This was found by testing with the real client.
- **Change if:** the MCP spec defines a standard for authorisation-pending.

### D10. Approvals bind to the exact request
- **Decision:** an approval is keyed by a hash of tool, action and arguments. It is redeemable once, and any change to the arguments needs a new approval. Approval status and execution status are separate records.

### D11. Release sequencing: build broadly, release narrowly
- **Decision:** the consumer interaction is the first market-facing release. The personal workspace comes next, then the API and SDK, then the governed Agent Runtime, then the ecosystem. Engineering continues in parallel, and each capability carries a release state (`internal | private | preview | public | disabled`). Server-side checks stay authoritative: a hidden button is not a security boundary.
- **Change if:** evidence from users or design partners shows a different surface pulls harder.

### D12. Destination credentials are sealed per tenant and destination
- **Decision:** AES-256-GCM with `recast-credential|tenant|destination` as associated data, so a sealed row only opens for the row it was written for. The key comes from an environment variable for now.
- **Change if:** a KMS is available. Envelope encryption would then replace the single key.

### D13. Control-center sign-in modes
- **Decision:** demo when there is no database; local accounts (scrypt, HMAC-signed cookie) for self-hosting; Supabase sessions (legacy HS256 secret, server-side password grant, refresh in the proxy) for the hosted product. A database without sign-in refuses to serve.
- **Change if:** a Supabase project uses asymmetric JWT keys. JWKS verification is then needed.

### D14. Interim UI tokens; the final identity follows Modulark/Modulus
- **Decision:** the current palette and type are interim (`docs/04-design-system.md`). The founders' direction is saved in `docs/design-direction.md`, and the final system will align with the Modulark and Modulus websites. Components keep reading tokens so the change is centralised.

### D15. Composition extends the core object model
- **Decision:** composing fragments (a time plus a place, for example) produces a candidate in the existing object envelope. Each field records its origin: `extracted` (from the source), `inferred` (from context), `default` (suggested by Recast) or `user` (typed by the person). A composed candidate is not an executable action; it must pass validation, required-field checks, destination compatibility and permissions first.
- **Alternatives:** a separate "draft" model.
- **Why:** one provenance story from capture to receipt.

### D16. One action lifecycle for consumer, API and agent execution
- **Decision:** `proposed → validated → awaiting_approval? → executing → succeeded | failed | outcome_unknown`, plus `cancelled`, `denied`, `expired` and `reversed`. Success is reported only after the provider confirms. A timeout after a write is `outcome_unknown` and is reconciled, never blindly retried. Undo is a declared capability of a bridge operation, not a universal promise.

### D17. Confidence of composed values reflects the reading, not the classifier's prior
- **Decision:** a value from a piece the person explicitly picked is read at 0.9 (verbatim text, or an explicit date or time). An inference is 0.6, below the trust model's 0.75, so it asks for a confirmation. Defaults are 0.9 and always listed as assumptions. Values the person typed are 1.0.
- **Context:** pieces carry the classifier's 0.6–0.7 "is this element a time" prior. Without this rule, every composed event needed a confirmation after the person had already seen the full preview, which is the redundant approval the brief forbids.
- **Alternatives:** lowering the trust threshold (rejected: affects every action); skipping consent for compositions (rejected: inferences and risky effects must still ask).
- **Change if:** people place wrong values because they skim the preview. Then raise the bar or highlight inferred fields more.

### D18. Release state is per tenant cohort, checked by the server, and new tenants start public
- **Decision:** capabilities live in one registry (`packages/release`). A tenant has a `cohort` (`internal | private | preview | public`), stored on `tenants`. The API checks the gate on every request after authentication and before quota. New tenants default to `public`, the narrowest access. Unreleased and disabled capabilities both answer `403 not_available`. Undo and reconcile are not narrowed by cohort, only by `disabled`. Deployment overrides (`RECAST_RELEASE`) refuse unknown names.
- **Alternatives:** feature flags in a hosted service (another vendor and secret); per-key flags (a tenant's keys would disagree); defaulting new tenants to `private` (opens unreleased surfaces to anyone an operator creates).
- **Why:** one server-side source of truth that cannot be bypassed by a UI, and that fails closed.
- **Change if:** cohorts need to vary per user within a tenant, or the registry needs to change without a deploy (then move it to the database with the same checks).

### D19. Spaces narrow; they never grant. Money is reserved before acting and kept when the outcome is unknown
- **Decision:** a Space is a per-agent bound on top of scopes and policy: an explicit tool list (no wildcards), call and money budgets, an expiry of at most 30 days, and approval rules that can only add `require_approval`. Budget is reserved atomically before forwarding. A tool's explicit refusal returns the money; an unknown outcome keeps it spent. Stop is permanent. Several matching Spaces without `x-recast-space` are refused instead of guessed.
- **Alternatives:** Spaces as a replacement for scopes (would mix the credential grant with the person's bound); post-hoc spend accounting (overspends under concurrency); refunding on any failure (could under-count real spend).
- **Why:** a person must be able to say "this agent, these actions, this much, until then", and trust it holds under retries and concurrency.
- **Change if:** providers return authoritative charges. Then settle against the receipt instead of the declared amount.

### D20. A hand-written contract, enforced by tests on every response and a committed v1 baseline
- **Decision:** OpenAPI 3.1 lives next to the handler (`openapi.ts`). Tests check every response they produce against it, including errors and the built server's. Response objects are closed for the server and open for clients. Breaking changes against `contract/v1.json` fail the build, and the snapshot tool refuses to record one.
- **Alternatives:** generating the spec from code (no schema library in the handler today); generating code from the spec (heavy for one handler); tests without a baseline (cannot tell an addition from a removal).
- **Why:** a developer integration breaks on a renamed field, not on a missing feature. The cheapest guard is to make every existing test a contract test.
- **Change if:** the API grows past one handler, or a typed schema library is adopted in the handler. Then generate the spec from it.

### D21. Recipes create Spaces; their packs only tighten; only reviewed content runs
- **Decision:** a recipe is YAML (tools, bounds, duration, and a pack of deny or require_approval rules). Applying one creates a Space for one agent and grants nothing: missing scopes are refused, not added. Pack rules live on that Space and apply only to its agent, checked at parse, at creation, by a database trigger and again at evaluation. A review pins the SHA-256 of the behavioural content, and the server applies only reviewed recipes. Sharing between accounts stays disabled.
- **Alternatives:** packs merged into the tenant policy (a pack could then affect every agent); recipes that also grant scopes (one click to broad authority); reviewing by version number (an edit without a version bump would slip through).
- **Why:** a template is only safe to reuse if it can never widen authority, and if what runs is exactly what someone looked at.
- **Change if:** recipes are shared between accounts. Then reviews must be signed by a publisher and verified on apply.

### D22. One clump state, owned by the extension's service worker; pages only perform their own writes
- **Decision:** composition is a first-class object (a clump) in the core, driven by a pure state machine whose state is plain JSON. In the extension that state lives in `chrome.storage.session`, behind a worker that applies one event at a time and sends the result to every tab where Recast was invoked. Destinations are declared by pages and their ids carry the tab, so a commit, undo or reconcile runs only in the page that owns the destination. Permissions stay `activeTab`, `scripting` and `storage`.
- **Alternatives:** state in each content script, synchronised by messages (two sources of truth; a closed tab could take the object with it); `storage.local` (survives the browser, so it is written to disk); host permissions with content scripts on every page (broad access the product does not need); a drag that continues across tabs (browsers do not deliver it).
- **Why:** an object the person made must not belong to the tab it came from, and a write must happen only where the person can see it happen.
- **Change if:** a native shell exists (state moves to it, and the extension becomes one of its surfaces), or objects need to outlive the browser session (then persistence with the person's consent, and an erase path).

### D23. Recast is off until invoked; one module, drawn from the state, opens when a merge settles
- **Decision:** capture mode (`armed`) is part of the clump state, so the machine itself refuses to pick anything up while Recast is off. One command (Control pressed twice, or a button; see D25) turns it on, reopens the composition, or turns it off; what it does is a pure function of the state (`commandEvents`). The action module is not a second state machine: it renders `moduleModel(state, REGISTRY)` and turns clicks and keys into the machine's own events. Its selector lists only the bridge registry, and an entry is available only when the composition fits the contract and a destination for it is connected.
- **Alternatives:** an always-on overlay (gets in the way of ordinary browsing and selection); a UI-only toggle (the extension's tabs could disagree, and a content script could still capture); a hard-coded destination list (it would offer what Recast cannot do); a full-screen review sheet (it took over the page).
- **Why:** the person decides when Recast acts, every tab agrees on it, and the module can only offer what a bridge really performs.
- **Change if:** a native shell exists (the same model is drawn in a desktop window and the command becomes global), or a destination needs settings before it can be offered (then the registry entry carries a "set up" step instead of "not connected").

### D24. How much Recast asks is the person's choice (agreed with the founder 2026-10-20; not built yet)
- **Decision:** on first sign-in, the production app asks how much confirmation the person wants, and they can change it later in Settings. The level sets how often Recast stops to ask ("Done?", "Move to calendar?").
  - **None:** the person picks where it goes, and it goes there. No further confirmation.
  - **High:** every step is confirmed, as in the clay-desk artifact today (review, then "Add to calendar", then "Done").
  - Levels in between are to be defined.
- **How it fits the trust model (for the build):** the level is an input to `checkConsent`/`assessRisk`, stored per person. The rest of the lifecycle does not change: receipts, unknown outcomes reconciled rather than resent, and undo where the destination allows it.
- **Open questions to settle before building:**
  - Does "None" also cover actions that reach other people or cannot be undone (sending an email, inviting attendees), or do those keep one confirmation?
  - What happens when something required is missing, such as a time or a recipient? Recast cannot place without it, so it must still ask for that.
- **Answers taken (2026-10-21, without asking again, per the founder's "keep working"):**
  - "None" does **not** cover actions that reach other people, cannot be undone, need a hold, or are driven by fragile UI automation. Those keep their review.
  - Anything missing is still asked for. Recast cannot place without it.
  - See D28 for what "None" does with readings Recast is unsure of.
- **Status:** built in the interaction engine (`confirm` on the state, `setConfirm`, `straightThrough` in `clump-machine.ts`) and the extension (asked the first time the popup opens, changeable there; kept in `chrome.storage.local` as one key). Two levels: "Every time" (high, the default) and "Only when it matters" (none). Not yet in the web control center: it has no link to the extension today.

### D25. The trigger is Control: twice to turn on, once to turn off (founder's call, 2026-10-20)
- **Decision:** one key everywhere: Control twice turns Recast on, and Control once turns it off again (Ctrl on Windows and Linux, Control, not ⌘, on a Mac). After a tap turns it off, the detector starts afresh, so a habitual double tap while on leaves it off. Detected by a pure function (`createDoubleTap`) that accepts only two quick, clean taps. Chords, Ctrl+click, holds and auto-repeat never count.
- **Alternatives:** a three-key chord (Alt+Shift+R; precise but "technical", and on a Mac it types "‰"); Fn twice (Wispr Flow's choice, but browsers cannot see Fn); ⌘ twice (collides with app shortcuts more often).
- **Consequences:**
  - In the browser extension, Control twice works only in tabs Recast is already in. Getting into a new tab needs the toolbar or the extension command, because listening on every site would need access to every site.
  - A native shell would make it global with a key hook: Windows low-level keyboard hook; macOS event tap with Input Monitoring permission (task #23).
  - The macOS Dictation option "Press Control key twice" conflicts for people who chose it.
- **Change if:** people trip it by accident in usability tests (#24). Then tighten the timing or make it configurable.

### D26. A placed object leaves the desk once its receipt is closed
- **Decision:** after a confirmed placement, the object stays while the receipt shows, because Undo needs it. When the receipt is left by any route other than Undo (Done, Escape, turning off, picking up something new), the object is removed from the desk and from the session's objects. An undone placement keeps its object, so it can go somewhere else.
- **Why:** the desk holds what still needs a place (founder's call). The record of what was done is the destination itself plus the action log's receipt, not a lingering object.
- **Change if:** people want to place the same composition in two destinations. Then offer "Keep it" on the receipt rather than keeping everything by default.

### D27. Every outcome names its operation; Undo is a guarded step; an unknown outcome is remembered per destination
- **Decision:**
  - Results of effects carry the operation id. The machine ignores answers for any other operation.
  - Undo moves to an `undoing` phase that only its own answer can leave, and `undoFailed` keeps the placement and says so.
  - Closing a "no answer" card records the doubt against the object and the destination's contract. Choosing that destination again goes to the check with the original operation, never to a fresh write.
  - A host that loses its destination mid-flight reports "unknown" (or, for an undo, "not confirmed") instead of leaving the state waiting.
  - A Control press during any of these is discarded, with the reason shown.
- **Alternatives:**
  - Booleans per host (they drifted: neither host caught a failed undo).
  - Retrying a lost write (duplicates where the provider has no idempotency key, like Gmail drafts).
  - Deferring Control until safe (a delayed "off" is more surprising than an immediate, explained refusal).
- **Why:** the brief's invariants ("a failed undo is never reported as done", "unknown is neither", "no duplicate on retry") hold only if they live in the one reducer both hosts share.
- **Change if:** a destination offers a reliable status lookup by client id for every write. Then a lost answer could be resolved automatically, instead of the person pressing Check.

### D28. Under "None", choosing in the module confirms a reading Recast is unsure of (2026-10-21)
- **Problem:** pieces read from a page are capped at 0.5–0.7 confidence on purpose. The trust model asks for a confirmation below 0.75. Taken literally, "None" would almost never skip the review.
- **Decision:** with confirmation "None", choosing the destination **in the glass module** counts as that confirmation, because the module has just shown every value. This applies only when doubt is the sole reason:
  - the relation's base risk is low;
  - there are no effect flags;
  - it is reversible;
  - it is not UI automation;
  - it is not below the 0.5 deliberate-choice line.
- **Not covered:** a blind drop onto a page still opens the review, because the person has not seen the values in the module.
- **Unchanged:** the core consent check (`checkConsent`) runs on that confirmation and again in `commit()`. Receipts, Undo and unknown-outcome handling are unchanged.

### D29. A page is a document; a page and a date are a task, placed whole on a task list (2026-10-21)
- **Decision:** a new piece kind, `page` (the page itself, from its title and same-site canonical link). On its own it is a `Document` (to Google Tasks as a reference, or Notion). Pressed together with a time it is a `Task` (title, link, due day). Anything else with a page is refused, with what would work.
- **Grammar:** one new relation, `task-tasklist-entry` (Task → TaskList; low risk; reversible; requires a title), and one new target kind, `TaskList`. It follows the Calendar pattern: one contract changes something inside an object (`googleTasks`: a document as a task), and another places a whole object on a list (`googleTasksEntry`).
- **Why not reuse `document-task-reference`:** a Document has no due date (its schema forbids extra properties), and a reference is not a task. Bending the Document schema would make every document carry a field that only means something on a task list.
- **Due dates:** Google Tasks keeps only the date. The time of day is dropped, and the review says so ("the time (5:00 PM) is not kept"). The date is read exactly like an event's start (relative days, the person's time zone), and conflicting dates are shown rather than chosen.
- **Turning a document into a task** changes where it can go, so pressing them together asks first (the existing "changes what it is" confirmation).
- **Change if:** a task list needs times, or people want a page combined with other pieces (a person → a task assigned to them).

### D30. Each destination declares its abilities; open-and-prefill destinations say "opened", never "added" (2026-10-21)
- **Decision:** a capability contract may list `abilities`: `open`, `create`, `read`, `update`, `search`, `delete`, `verify`, `undo`. Every contract in the bridge registry declares them, and a test checks them against what each bridge's operations declare about themselves (`OperationCapabilities`): `undo` exactly when some operation can be reversed, `verify` exactly when one can be read back, `create` or `update` by how it is reversed. When a destination declares its abilities without `undo`, no proposal for it offers Undo.
- **Open and prefill (`reliability: "deep-link"`):** the app opens with the details filled in, and the person finishes there. Such a contract may declare only `open`, and `checkContract` rejects one that claims to write, check or undo. Since nothing is written, "cannot be undone" does not raise its risk; flags such as `send` still do. The review's confirm button is a real link, so the browser opens the new tab from the person's own click. Done says "Opened Google Maps", with no Undo, and that Recast cannot see what happens there.
- **First one:** a place on its own → Google Maps or Apple Maps directions (new relation `location-map-directions`, Location → Map). It needs no account. The URL is built only from the reviewed name and address, on a fixed host; a test shows a place's text cannot change the host or add parameters. A single place can now be placed on its own: "Inside this object" offers "Choose where it goes".
- **Why:** the owner's direction (`docs/24-integration-universe.md`): broad coverage through open-and-prefill, without pretending those destinations confirm anything.
- **Change if:** a provider's link can carry a result back (a callback), in which case it could declare `verify`.

### D31. Passages make a note that keeps each source; a note goes to Google Docs (2026-10-22)
- **Decision:** a new object type, `Note` (`title`, `body`, `sources`). Two or more passages (selected text) pressed together are a note; until now they were refused. A single passage can also be placed as a note. The body is exactly what the review shows: each passage in quotation marks, then the title and address of the page it came from. `sources` lists the addresses, and every passage's evidence travels with the object.
- **Line breaks are kept in a note's body.** Resolving an object collapses whitespace in every string; for `Note.body` only, spaces are tidied within each line and the lines are kept, so the document reads as the review did. Other types are unchanged.
- **Grammar:** one relation, `note-docs-entry` (Note → Docs; low risk; reversible; needs a title and a body). Contract `googleDocs`: abilities `create` and `undo`.
- **Google Docs bridge:** `documents.create` (title), then `batchUpdate` with `insertText` (plain text only: a passage cannot add links or styles). If the text cannot be added, the empty document is trashed and the placement fails, so nothing half-made is left. A lost answer is unknown, never resent, and cannot be checked (Google chooses the id). Undo moves the document to the Drive trash, where the person can restore it. Permission: `drive.file`, the narrowest (only files Recast created).
- **Changes what merges:** a note plus a person becomes a message, and a note plus a time becomes an event. Both ask first, since that changes what the object is.
- **Change if:** people want a note to go to Notion or Apple Notes (add contracts on the same relation), or want formatting (headings, links), which would need a reviewed formatting model, not raw markup.

### D32. An error is a piece; an error with notes is an issue, opened in GitHub (2026-10-22)
- **Decision:** a new piece kind, `error` (selected text that reads as an error message: an exception, a failed step, a stack trace; `looksLikeError`). An error, with any notes (selected text), is an `Issue` (`title`, `body`, `sources`). Nothing else joins an error: a time or a person is refused, with what would work.
- **Body:** Markdown for the tracker, with everything captured quoted literally in fenced blocks longer than any backtick run inside. A copied `@name`, link or image shows as text: it cannot notify anyone or embed anything. "Seen on" names each page. Lines are tidied the same way a stored body is, so the review shows exactly what GitHub receives.
- **Grammar and contract:** relation `issue-tracker-entry` (Issue → Issues; low base risk; reversible). Contract `githubIssue` with `notifies-third-party` (watchers may be notified), so it is medium risk and asks for a confirm. Abilities `create` and `undo`.
- **Undo closes, not deletes:** GitHub lets only admins delete issues. Undo closes it as "not planned". It cannot take back a notification already sent; the review says it "notifies someone else" before the person confirms.
- **Connection:** GitHub is separate from Google. It uses a fine-grained token for one repository (Issues read and write), checked against that repository before it is saved, and kept in a 0600 file on the person's computer. Requests go to api.github.com only, and path segments are encoded so a repository name cannot change the target.
- **Where it shows:** the Tasks place in the wheel (tracked work). The try-it page has a Build tab with a stand-in issue list.
- **Change if:** Linear or Jira is added (same relation, new contracts), or people want labels or assignees (fields to review, and assignees notify).

### D33. Linear, on the same issue relation; a place with several choices asks which one (2026-10-22)
- **Decision:** contract `linearIssue` on `issue-tracker-entry` (create, delete, undo; confirm first, since it notifies). It uses Linear's GraphQL, with values sent only as variables, never in the query text. An `errors` array in a 200 answer is a failure. Undo deletes the issue (Linear keeps it in its trash). The connection is separate: a personal API key and a team key, and the team is looked up before anything is saved (0600 file).
- **Choosing between connected destinations:** a wheel place with more than one connected destination of the same kind (GitHub and Linear under Tasks) opens into a short list, "Tasks: which one?", the way "More" does. Recast no longer picks the first one silently.

### D34. Phase two: any selected text is a piece you can move (2026-10-22)
- **Decision:** with Recast on, selecting text anywhere on a page (try-it page and extension) shows a blob beside the selection. The blob is a piece like the highlighted ones from phase one: drag it to carry it and press it into an object, tap it to put it on the desk, or (try-it page) Tab to it and press Enter to lift it. The extension no longer needs Alt for selected text; Alt-press still works.
- **What a selection is:** `pieceOfSelection` in `packages/core`, from the text alone. An error message is an error; a lone email address is a person (with that email); a short date or time (60 characters or fewer, 8 words or fewer, and readable as a time) is a time; anything else is text. Places are not guessed from free text, since an address-shaped string is too often something else.
- **Where it does not appear:** while Recast is off (selecting is just selecting); in fields being typed in; while something is carried; and while the module is open, because the blob must never cover the module's buttons (a test found it blocking "Add to calendar" after a drag left a selection). Selections over 1,000 characters show no blob.
- **Provenance:** a selection keeps the page it came from (address and title), like any piece, with a "selection" evidence locator.
- **Change if:** people want places from free text (needs a geocoder and a way to confirm), or to drag the selected text itself rather than the blob (needs native drag and drop, which conflicts with selecting).

### D35. Recipes run several places from one composition; each step has its own outcome (2026-10-22)
- **Decision:** first-party recipes (`packages/core/src/recipes.ts`), versioned definitions with no captured data: "Plan and invite" (event + a draft to the people in it) and "Plan and prepare" (event + a task due that day). They show as quiet chips under "Choose where it goes" when they fit the object, disabled with the reason when they cannot run.
- **Review:** each step shows its destination (and whether it is a stand-in), the pieces it uses, and "Recast's wording" where the recipe words something (a task title, a draft). Steps can be left out. A step that lacks something (an email address, a connected task list) is shown blocked with the reason and left out. An unfinished event is finished in the same review, and the steps are worked out again.
- **Running:** one approval (confirm, or hold if any step needs it, checked per step). Steps go one at a time, in order, each through the normal commit with its own receipt. No pretend transaction: the result says "2 of 3 done", never a blanket success. A lost answer is "unknown", remembered for that object, and never resent. Undo is per step, only where the step can be reversed. Done retires the object only when every chosen step stands.
- **Capture stack:** the same piece (kind, words, page) captured again is the object already on the desk, not a copy, and an object refuses a piece it already holds.

### D36. A desktop app (Electron) for daily use, built on all three systems by CI (2026-10-22)
- **Decision:** `apps/desktop` is an Electron app with the capsule in its own small window (always on top, optional), a tray icon, and two global shortcuts: open or hide, and capture what you copied. The local program (`apps/calendar-link`) runs inside the app's main process, so Google, GitHub and Linear work without a terminal or the browser extension (`createLink(...).direct`, in-process, never over HTTP).
- **Capture on the desktop:** typed or dictated text (OS dictation into the box: Fn on a Mac, Win+H on Windows) and the clipboard. These are read with the same `pieceOfSelection`. Their provenance is said plainly: "Typed or dictated", or "Copied <time>". The app that was copied from is not knowable and is not claimed.
- **Fn is not a shortcut:** keyboard firmware keeps it (no app sees it on Windows or Linux, and macOS reserves Fn/Globe). Shortcuts are configurable; a taken one is reported, not silently dropped.
- **Security:** the pages have no Node (context isolation, sandbox, CSP); the preload exposes narrow calls, each checked again in the main process. Links open only `https:` (or the local sign-in page) in the default browser. Sign-in happens in the person's browser, never inside the app (Google refuses embedded browsers, and it is the safer pattern). The app never auto-updates or fetches anything by itself.
- **Inbox:** the desk survives a restart (a 0600 file on this computer). Anything in flight at quit is not assumed to have worked: a write becomes "unknown" (checked, never resent), and an undo is reported as not confirmed.
- **Packaging:** electron-builder from `dist/` only (Recast's own code is about 2 MB; the rest is the Electron runtime). The `desktop` GitHub Actions workflow builds `.dmg` and `.zip` per architecture (arm64, x64; a universal image was twice the size and arrived corrupted once) on macOS, verified with `hdiutil verify` and opened once as a launch check,, `.exe` (NSIS, x64 and arm64) on Windows, and `.rpm`, `.deb` and AppImage on Linux. Without the owner's certificates, macOS is ad-hoc signed (right-click → Open once) and Windows is unsigned (SmartScreen asks once).

### D37. The desktop app grabs what is selected in any app; the capsule floats as a pill (2026-10-22)
- **Why:** the owner: the first desktop build only took typed or pasted text, so it could not be tested on their own content. Recast's point is acting on what is on the screen, in any app.
- **Grab** (⌘⇧Space / Ctrl+Shift+Space, configurable): Linux (X11) reads the PRIMARY selection, which is exactly what is highlighted; nothing is copied. On macOS, with the Accessibility permission, Recast sends ⌘C to the front app through System Events and reads the result. Before that it puts a marker on the clipboard, so a copy that changes nothing means "nothing selected", and afterwards it restores the person's clipboard (every format).
- **Source:** the front app's name and window title (macOS System Events; Linux xprop); for Safari and Chromium-based browsers, the page's address and title (macOS Automation, asked once per browser). Only what the system reports is recorded; otherwise "another app".
- **The capsule:** a transparent, always-on-top, frameless window, a 420×64 pill while idle that opens to the 440×640 panel when there are objects, the module, typing or settings. It grows from its bottom-right corner. A grab shows it without taking focus from the app the person is in.
- **Not yet:** Windows grab (needs UI Automation or a simulated copy); Wayland-only desktops; dragging a selection straight out of another app (grab is a key press, not a drag); images.

### D38. The desktop app works on top of other apps; the Recast window is a library (2026-10-23)
- **Context:** the owner: no Recast window should open to use it ("I don't want a completely new UI to open up somewhere where you have to drag that blob over there"). Like a dictation app: a trigger in any app, the work done in place, and a separate app that keeps the history.
- **Decision:** a transparent, always-on-top overlay window covers the display the pointer is on and draws only blobs and the wheel; it takes the mouse only on them (macOS and Windows: ignore mouse events elsewhere, forwarding moves; Linux: a shaped window). The trigger is a double tap of a modifier, read by a system-wide keyboard hook (`uiohook-napi`, prebuilt for every system, never recompiled): Option on a Mac (Control twice is the Mac's Dictation), Ctrl on Windows and Linux, with the extension's tap rule (`createControlTrigger`): twice to turn on, once (or Esc) to turn off. While on, a finished selection (a drag, or a double or triple click) is grabbed. The wheel is placed beside its blob, not docked. The old floating panel is gone; the main window is the library (history.json), which never opens on a grab.
- **Consequences:** the Mac needs Accessibility before the hook starts (the library asks; the hook starts as soon as it is given). Windows now grabs selections too (Ctrl+C through the hook, clipboard restored). Tests press real keys and select with the real mouse (xdotool on Xvfb) in a real browser window and check that a click elsewhere reaches that page through the overlay. Not yet: Wayland, the source app name on Windows, typing a piece by hand (the old panel's box), multiple displays at once (the overlay covers the display the pointer is on when Recast turns on).

