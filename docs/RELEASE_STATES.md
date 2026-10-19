# Release states

Build broadly, release narrowly (`docs/DECISIONS.md` D11). Every capability carries a release state, and every tenant belongs to a cohort. The server decides, per request, whether that cohort may use that capability.

## States and cohorts
| State | Who can use it |
|---|---|
| `internal` | the founding team's own tenants only |
| `private` | invited design partners (and internal) |
| `preview` | anyone who opted into previews (and the above) |
| `public` | every tenant |
| `disabled` | nobody, internal included. This is the kill switch |

A tenant's cohort is one of `internal`, `private`, `preview`, `public`. A capability in state S is available to a cohort C when C is at or before S in the order `internal < private < preview < public`.

New tenants start in `public`, which is the narrowest access. An operator moves a tenant deliberately:

```
pnpm --filter @recast/api keys tenant set <tenant-id> --cohort private
```

## Registry
The source is `packages/release/src/index.ts`. `GET /v1/capabilities` returns, for the calling key, only the capabilities it can use. Unreleased names are never listed to outsiders.

| Capability | State | Surface |
|---|---|---|
| `consumer.grab-and-place` | private | consumer |
| `consumer.compose` | internal | consumer |
| `workspace.control-center` | private | workspace |
| `workspace.supabase-signin` | internal | workspace |
| `api.resolve` | private | API: `/v1/resolve`, `/v1/resolve/batch`, `/v1/bridges` |
| `api.corrections` | private | API: `/v1/corrections` (opt-in still required) |
| `api.place` | internal | API: `/v1/place`, `/v1/place/undo`, `/v1/place/reconcile` |
| `api.place.object` | internal | API: `/v1/place` with a complete object |
| `sdk.place` | internal | SDK |
| `mcp.recast-tools` | private | MCP |
| `agent.gateway` | private | agent runtime |
| `agent.spaces` | internal | agent runtime |
| `community.recipes` | disabled | community |
| `data.library` | disabled | data |

Nothing is `public`. A test fails if anything becomes public without that test being changed on purpose. A public launch also needs a decision-log entry.

## Per-deployment overrides
Set `RECAST_RELEASE="api.place=preview,agent.spaces=private"`. An unknown capability or state stops the server from starting, so a typo can neither silently open nor silently close a capability.

## Rules
- **Server-side and authoritative.** The API checks the gate after authentication and before quota, idempotency or any work. A refused request is not counted against quota.
- **One answer.** "Not released to you" and "disabled" both return `403 not_available`, so outsiders cannot probe what exists.
- **Not an authorisation boundary on its own.** Key authentication, row-level security, consent, grants, approvals and policy all still apply. A release state only narrows what those already allow.
- **Narrowing never strands people.** Undo and reconcile act only on placements the tenant already made. They stay available whatever the tenant's cohort, and are stopped only by `api.place=disabled`, because they also call the destination.
- **Hiding a button is not a release control.** UIs may read `/v1/capabilities` to hide things, but the server check is what counts.

## Where the check is enforced today
| Surface | Enforced | Evidence |
|---|---|---|
| Developer API (`apps/api`, `packages/api-core`) | **yes**, per request, from `tenants.cohort` | `packages/api-core/test/release.test.ts` (memory and Postgres) |
| SDK | through the API | the SDK has no gate of its own; the API answers 403 |
| Local MCP server (`packages/mcp`) | in remote mode, through the API; in local mode **no** | local mode runs on the person's own machine with no tenant |
| Agent gateway (`apps/agent-server`) | **not yet** | to do with Spaces (task #41) |
| Control center (`apps/web`) | **not yet** | people's workspace accounts have no cohort yet |
| Consumer harness and extension | **no** | local builds; release is by distribution, not by a server |
