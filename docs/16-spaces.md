# Spaces: bounded agent configurations

A Space says what one agent may do for a person, for how long, and at what cost. It is the unit a person creates, watches and stops. A Space **only narrows** what scopes and policy already allow. It never grants anything by itself.

## What a Space holds
| Field | Meaning | Limits |
|---|---|---|
| `tools` | the tool actions the agent may call, each with optional parameter `constraints`, `approval: "always"` and a `cost` | 1 to 50 actions. Plain names only: **no wildcards** |
| `budget.maxCalls` | calls the agent may make in this Space | 1 to 100,000 |
| `budget.spend` | money the agent may spend, in minor units of one currency | required when any action has a cost |
| `cost` | per call: `fixedMinor`, and/or `param` (the call's own amount, e.g. an order total) | a missing, negative or fractional amount is refused, never treated as free |
| `expiresAt` | when the Space ends | in the future, at most **30 days** away (also enforced by a database check) |
| `status` | `active` or `stopped` | stop is immediate and **permanent** (a trigger refuses a restart) |

The derived state is `active`, `stopped`, `expired` or `exhausted` (no calls left).

## What the gateway does on each tool call (with `SPACES_MODE=required`)
1. Authenticate the agent (token, optional proof), as before.
2. **Release check:** the tenant's cohort must have `agent.gateway` and `agent.spaces` (`docs/RELEASE_STATES.md`). Otherwise every method is refused, `initialize` included.
3. Scope check, as before.
4. **Pick the Space:** the one named in `x-recast-space`, or else the only active Space of this agent that includes the action. Several matches without a header are refused, so the agent has to say which budget it is spending.
5. **Space checks:** active, includes the action, the parameters meet the Space's constraints, and the call can be priced.
6. **Policy:** the tenant's policy plus the Space's approval rules. Those rules are only `require_approval`, so deny still beats them. An approval is bound to the exact parameters **and the Space**.
7. **Reserve** one call and the cost in a single atomic statement (`reserve_space`, row lock). Two concurrent calls never share the last unit.
8. Spend one scope call. If that fails, the Space reservation is given back.
9. Audit the decision, with `spaceId` and `costMinor` in the signed entry, then forward.
10. **Settle.** If the tool refuses (a JSON-RPC error or a 4xx), the money is given back but the call still counts. If the outcome is unknown (unreachable mid-request or 5xx), the money stays spent. That is conservative, in line with D16.

`tools/list` shows only tools that are both scoped and in an active Space.

## Operating it
Admin API on `apps/agent-server` (admin token):
- `POST /admin/spaces` `{tenant, agentId, name, purpose?, tools, budget, expiresAt, createdBy}` returns the Space with `state` and `remaining`. A bad Space gets `400 invalid_space` with the reason.
- `GET /admin/spaces?tenant=…[&agent=…]`
- `POST /admin/spaces/:id/stop` `{tenant, by}`. Stopping is never release-gated: anyone who can see a Space can always stop it.

Control center: **Agents** lists each Space with what is left (calls, money, time) and a **Stop** button (`apps/web/app/agents/page.tsx`).

## Evidence
| Claim | Test | Level |
|---|---|---|
| unbounded Spaces refused | `packages/agent-runtime/test/spaces.test.ts` | U |
| membership, constraints, budget, refunds, approval binding, stop, expiry, tool list, audit fields, release gate | same file, through the gateway against a local HTTP upstream | U, H |
| atomic reservation under concurrency, tenant isolation, no restart, 30-day check | same file, `SqlSpaceStore` on PGlite | H |
| official MCP client through the deployable server over Postgres wire; admin create, list and stop; audit verifies | `apps/agent-server/test/spaces.test.ts` | H |
| control center shows a Space and Stop ends it | `apps/web/test/app.test.ts` (Chromium, axe) | H |

## Not done
- **Spend is what the call declares.** The gateway prices a call from its parameters. It cannot see what a merchant actually charged. Reconciling against the provider's receipt needs real providers (R).
- **In-flight calls finish.** Stop takes effect on the next call. A call already forwarded completes.
- **One currency per Space.** No conversion.
- **Not Spaces-by-default.** `SPACES_MODE` defaults to `off` while `agent.spaces` is `internal`. Turning it on for a deployment makes Spaces mandatory for every agent there.
- **Gateway bypass.** An agent that holds the upstream credential itself is not bounded by any of this. The gateway's guarantee holds only when upstream credentials live in the runtime's vault (task #42 documents the limits).
