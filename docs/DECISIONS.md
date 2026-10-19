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
