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
- **Decision:** capture mode (`armed`) is part of the clump state, so the machine itself refuses to pick anything up while Recast is off. One command (Alt+Shift+R, or a button) turns it on, reopens the composition, or turns it off; what it does is a pure function of the state (`commandEvents`). The action module is not a second state machine: it renders `moduleModel(state, REGISTRY)` and turns clicks and keys into the machine's own events. Its selector lists only the bridge registry, and an entry is available only when the composition fits the contract and a destination for it is connected.
- **Alternatives:** an always-on overlay (gets in the way of ordinary browsing and selection); a UI-only toggle (the extension's tabs could disagree, and a content script could still capture); a hard-coded destination list (it would offer what Recast cannot do); a full-screen review sheet (it took over the page).
- **Why:** the person decides when Recast acts, every tab agrees on it, and the module can only offer what a bridge really performs.
- **Change if:** a native shell exists (the same model is drawn in a desktop window and the command becomes global), or a destination needs settings before it can be offered (then the registry entry carries a "set up" step instead of "not connected").
