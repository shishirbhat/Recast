# Recast mission (the owner's engineering brief, pasted 22 Oct 2026)

Kept verbatim so every session measures against the same text. `docs/mission-status.md` maps each part to what the repository actually does.

> You are working on Recast, a desktop-oriented interaction product with a specific ambition:
> Turn information people see on their screens into useful, structured actions—without making them manually copy, paste, reformat, and reconnect context across applications.
> Recast's initial interaction is a tactile capsule: users capture fragments such as times, places, people, links, and text, combine them, preview an action, and place the result in a destination.
> The existing project has Calendar and Mail demonstrations. Treat those as the starting point, not the complete product.
> Your assignment is to inspect the real repository, determine which capabilities exist today, and implement the highest-value expansion. Do not merely create mockups, static demonstrations, architecture documents, or a list of future ideas.
> 1. Product principles
> Every feature must strengthen at least one of these outcomes:
> 
> * Make capturing information easier than copying and pasting.
> * Turn captured information into a useful object or completed action.
> * Preserve the context and provenance of the original information.
> * Make previously disconnected applications work together.
> * Help new users experience Recast's value before they need to understand its architecture.
> * Give users a natural reason to reuse and share useful workflows.
> 
> Do not turn Recast into a generic AI chatbot, a conventional automation dashboard, or an oversized launcher.
> The capsule remains the centre of the experience. Use the existing design direction: a small, beautiful physical object floating above the desktop, calm and tactile interactions, restrained warm orange accents, carefully considered dark/light themes, and no permanently visible dashboard that overwhelms the user.
> 2. Phase zero — Audit before implementation
> Inspect the actual repository and record the current state.
> Determine:
> 
> * Which Calendar and Mail operations genuinely work end to end.
> * Which provider connections, authorization flows, write operations, and verification paths exist.
> * Which interactions are simulated or use mock data.
> * Which operating systems and capture mechanisms are genuinely supported.
> * How captured objects, previews, destination adapters, permissions, cancellation, and Undo are currently represented.
> * Which UI components, stores, reducers, schemas, and tests already exist.
> * Whether multiple objects can already be captured and combined.
> * Which existing limitations prevent an impressive, complete user workflow.
> 
> Preserve uncommitted changes. Do not overwrite existing work or replace functioning integrations with mocks.
> After the audit, immediately implement the highest-value coherent vertical slice. Do not stop at a report or ask for another planning round.
> 3. Feature 1 — Capture Stack
> Priority: Highest
> Build a reliable way to collect multiple pieces of screen information before executing an action.
> A user should be able to capture a time, place, person, link, or text excerpt separately, temporarily hold those objects, and combine them into one intended result.
> Requirements:
> 
> * Display each captured object as a compact, visually distinct capsule.
> * Make object type and short human-readable content immediately understandable.
> * Allow users to remove, reorder, replace, and inspect captured objects.
> * Preserve the original source and capture context whenever the underlying capture mechanism can provide them.
> * Prevent accidental duplication where reliable deduplication is possible.
> * Let users cancel the entire composition without mutating destinations.
> * Ensure captured data is isolated appropriately between users and workspaces.
> * Keep the interaction functional using actual selectable information, not only hard-coded demonstration data.
> 
> Do not claim that Recast can extract arbitrary information from every application until the required OS permissions and capture mechanisms have been implemented and tested.
> 4. Feature 2 — Universal Typed Objects
> Priority: Highest
> Expand Recast's internal object model beyond Calendar events and Mail drafts.
> Audit the existing schema before extending it. Reuse compatible existing abstractions and add versioned schemas where needed.
> Candidate object types:
> 
> * `TextExcerpt`
> * `DateTime`
> * `Person`
> * `EmailAddress`
> * `PhoneNumber`
> * `Place`
> * `URL`
> * `Task`
> * `Event`
> * `Issue`
> * `CodeReference`
> * `FileReference`
> * `DocumentReference`
> 
> Each object should include the fields that are actually known, its origin when available, and an indication of uncertainty where extraction is ambiguous.
> Rules:
> 
> * Never silently invent missing values.
> * Distinguish extracted facts from user-entered values and inferred suggestions.
> * Do not silently rewrite the user's source text.
> * Let the user inspect or correct extracted values before consequential operations.
> * Preserve compatible object data as it moves between workflows.
> * Validate objects before executing destination operations.
> 
> The purpose is to make the same capture interaction reusable across many workflows without rewriting the central interaction every time.
> 5. Feature 3 — Contextual Action Palette
> Priority: Highest
> Build a compact action-selection interface appropriate to the existing capsule design.
> Possible actions include:
> 
> * Create calendar event.
> * Draft email.
> * Create task.
> * Create project issue.
> * Save a sourced note.
> * Create or populate a document.
> * Open directions to a captured place.
> * Copy structured data.
> * Start a user-configured workflow.
> 
> Only show actions that are compatible with the selected objects and the installed, connected destinations.
> For example, a captured time and place may offer an event action. A code reference plus an error message may offer a bug-report action.
> The interface should:
> 
> * Make the next useful action discoverable within a few seconds.
> * Be keyboard accessible.
> * Support cancellation and returning to the capture stack.
> * Display a useful explanation when an action is unavailable.
> * Avoid a huge list of integrations that overwhelms the user.
> * Respect the existing Recast visual design rather than introducing a generic command-palette UI.
> 
> 6. Feature 4 — Multi-Destination Workflows
> Priority: High
> Allow a single composition to produce multiple related destination actions.
> Example:
> A captured conference announcement can produce:
> 
> 1. A calendar-event preview.
> 2. A task to prepare for the conference.
> 3. A sourced research note.
> 4. A draft message to a colleague.
> 
> Show all proposed actions and destinations before execution.
> Requirements:
> 
> * Represent each operation independently.
> * Show which source objects map to each destination.
> * Validate required fields and permissions.
> * Execute operations according to explicit user approval and dependency rules.
> * Handle partial success honestly.
> * Never mark a whole workflow successful when one of its operations failed.
> * Avoid blind retries that could create duplicate events, tasks, or records.
> * Record actual operation results and provide a path to inspect failures.
> * Support cancellation before execution and safe recovery afterward.
> 
> Do not implement a fictional transaction spanning independent services that cannot actually roll back atomically. Represent partial outcomes clearly.
> 7. Feature 5 — Verified Action Receipts
> Priority: High
> After every supported action, display a compact receipt explaining what actually happened.
> Where information is available, show:
> 
> * The destination.
> * The created or updated object.
> * A link to open the result.
> * Relevant source references.
> * Success, failure, or uncertain outcome.
> * The next available recovery or correction action.
> 
> Undo should appear only where the operation can be reliably reversed. If an operation cannot be undone, offer the appropriate alternative rather than a fake Undo button.
> Use provider acknowledgements and actual destination state whenever available. Do not equate a network request being sent with a confirmed successful operation.
> 8. Feature 6 — Reusable Recast Recipes
> Priority: High
> Let users package useful action sequences into reusable recipes.
> Examples:
> 
> * Meeting invitation → calendar event plus preparation task.
> * Error message plus code reference → structured issue.
> * Article quotation plus URL → sourced research note.
> * Event announcement → calendar event plus message draft.
> 
> A recipe should describe:
> 
> * Its trigger or required captured objects.
> * Its sequence of actions.
> * Its supported destinations.
> * Required integrations and permissions.
> * Its inputs and field mappings.
> * Which steps need user confirmation.
> * Known limitations.
> 
> Provide versioning and a review screen before a recipe runs.
> Sharing should distribute the workflow definition, not private captured data, account credentials, or authentication tokens. Recipients should connect their own accounts and choose their own permissions.
> Start with a small number of first-party recipes before building a public marketplace.
> 9. Feature 7 — Context Preservation
> Priority: High
> Every captured object should retain the context needed to use it correctly later, wherever the source system permits it.
> Examples include:
> 
> * Original URL.
> * Page or document title.
> * Selected text.
> * Relevant file path.
> * Capture timestamp.
> * Associated source object identifier.
> * User correction history where necessary to explain changes.
> 
> Do not capture hidden content or bypass application security boundaries.
> For text excerpts and code references, make provenance useful rather than creating a large wall of metadata in the primary interface.
> The principle is simple: users should be able to understand where an object came from and verify it when necessary.
> 10. Feature 8 — The Capture Inbox
> Priority: Medium
> Provide a lightweight temporary inbox for incomplete compositions.
> Users should be able to:
> 
> * Resume a composition later.
> * Remove individual captured objects.
> * Clear the inbox.
> * See which actions remain incomplete.
> * Recover safely after an application restart where persistence is supported.
> 
> Keep it temporary and subordinate to the capsule. Do not turn this into another permanent dashboard.
> Establish appropriate local-versus-remote storage behavior and communicate it accurately.
> 11. Feature 9 — Quick Actions and Keyboard Flow
> Priority: Medium
> Make Recast feel fast for frequent users.
> Implement or improve:
> 
> * Configurable keyboard shortcuts.
> * Fast opening and dismissal.
> * Common action shortcuts.
> * Keyboard navigation between captured objects.
> * Predictable focus restoration.
> * Reduced-motion support.
> * Graceful behavior when permissions are missing or an application is unavailable.
> 
> Avoid assigning disruptive global shortcuts without an explicit user preference and platform checks.
> Never steal focus from unrelated applications unexpectedly.
> 12. Feature 10 — Personal Workflow Presets
> Priority: Medium
> Allow users to configure useful defaults for repeated actions.
> Examples:
> 
> * Default calendar.
> * Preferred task destination.
> * Preferred document format.
> * Default meeting duration, when explicitly configured.
> * Preferred note template.
> * Destination preferences for specific recipe types.
> 
> Every preset should be inspectable and editable. Defaults must never silently override a conflicting explicit user choice.
> Do not invent defaults from activity unless the behavior is transparent and user-controlled.
> 13. Feature 11 — Destination Expansion
> Prioritize a small group of genuine integrations that unlock multiple workflows.
> Investigate the current APIs, authentication mechanisms, scopes, rate limits, and implementation status for:
> 
> * Google Calendar.
> * Gmail.
> * Google Drive or Docs.
> * Microsoft Outlook and Calendar.
> * Todoist.
> * Linear.
> * GitHub Issues.
> * Notion.
> * Slack.
> * Google Maps or Apple Maps handoff.
> 
> The exact order should depend on current repository capabilities and the quality of actual supported workflows.
> Each connector must explicitly declare its real capabilities, such as:
> 
> * Open or deep-link.
> * Read.
> * Create.
> * Update.
> * Search.
> * Verify.
> * Undo or compensate.
> 
> Do not advertise a capability merely because the destination can be opened in a browser.
> Where a native API is impractical, use a clearly identified URL, share-sheet, or handoff integration if that route is reliable and useful.
> Build a small number of excellent connectors before attempting a large integration catalogue.
> 14. Feature 12 — Recast Playground
> Priority: High for acquisition
> Make the first experience easy to understand before users connect private accounts.
> Build a polished, interactive sandbox using clearly labelled sample data.
> A visitor should be able to:
> 
> 1. Select a sample time.
> 2. Capture a sample place.
> 3. Add a sample person.
> 4. Combine them into an event.
> 5. Review the destination action.
> 6. See how a successful result would be reported.
> 
> The experience must teach the actual Recast interaction rather than merely display a marketing animation.
> If an operation is simulated, identify it as a demo. Do not falsely claim that a real calendar, email, or other external service was modified.
> The sandbox should make the product understandable quickly and give users a clear path to the actual application.
> 15. Product design and quality constraints
> Retain Recast's established visual direction:
> 
> * Small, floating, physical-feeling capsule.
> * Calm and tactile interaction.
> * Dark mode and light mode considered equally.
> * Warm ivory and ink palette with restrained orange accents.
> * Premium typography and careful spacing.
> * Short, readable object labels.
> * Clear preview and confirmation stages.
> * Minimal success receipts.
> * Keyboard accessibility and reduced-motion support.
> 
> Do not add a permanent sidebar or dense dashboard merely to accommodate more capabilities.
> Every new feature must integrate naturally with the core interaction.
> 16. Engineering and test requirements
> 
> * Audit existing code before changing architecture.
> * Preserve user work and uncommitted changes.
> * Reuse functioning reducers, adapters, schemas, and tests.
> * Add tests for real data transformations and state transitions.
> * Test destination creation through actual supported integrations.
> * Test missing fields, ambiguous values, denied permissions, cancellation, network failures, partial success, and uncertain outcomes.
> * Verify that action receipts match real outcomes.
> * Check that recipes cannot bypass destination permissions.
> * Ensure private content and tokens are not inadvertently shared.
> * Test dark and light themes after interface changes.
> * Avoid arbitrary sleeps in tests where deterministic coordination is possible.
> * Never weaken existing assertions to obtain a green suite.
> 
> Distinguish implemented, locally tested, provider-tested, deployed, and real-user-validated behavior.
> 17. Definition of done
> Complete one coherent, high-quality product expansion, not a superficial implementation of every item.
> At minimum:
> 
> * Multiple real captured objects can be composed.
> * The action palette responds to object types and installed capabilities.
> * At least three useful workflows exist end to end, with honest handling of their real outcomes.
> * Existing Calendar and Mail flows continue to work.
> * The user can inspect the resulting action and relevant source context.
> * Action receipts show actual outcomes.
> * A first-party recipe or repeatable workflow is usable.
> * A first-time user can experience Recast through an accurate, polished demonstration.
> * Relevant existing and new tests pass.
> * Remaining gaps are documented truthfully.
> 
> Prefer the best working slice across the features above, and implement additional features when the existing architecture makes them practical without compromising the core workflow.
> 18. Final report
> Report:
> 
> * The initial repository findings.
> * Features implemented and actual user-facing behavior.
> * Connectors and operations genuinely supported.
> * New tests and exact results.
> * Screenshots or evidence paths.
> * Whether the Playground uses real or simulated data.
> * Known limitations.
> * Git status, commits, and push status where applicable.
> * The next highest-value improvement.
> 
> Do not stop after an audit or implementation plan. Build, verify, and report the actual result.
> Product standard: Recast should make an action feel obvious, effortless, and trustworthy. More features are valuable only when they strengthen that feeling.