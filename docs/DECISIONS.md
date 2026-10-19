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
