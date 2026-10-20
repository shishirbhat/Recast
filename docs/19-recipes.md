# Recipes and policy packs

A recipe is a reviewed, declarative template for a Space: what an agent may do, with what bounds, and which extra rules apply. Its policy pack is a list of rules that only **deny** or **require a person's approval**. Recipes save people from writing safe configurations by hand. They never make anything less safe than what the person already allowed.

## The rules a recipe cannot break
1. **Never self-granting.**
   - Applying a recipe creates a Space and nothing else. It never grants a scope.
   - The server refuses (`409 needs_scopes`, listing what is missing) when the agent lacks a scope the recipe needs.
   - A Space can only narrow scopes and policy (D19).
2. **Packs only tighten.**
   - A pack may not contain `allow`, set a default, or name another agent.
   - Its rules apply only inside the Space the recipe created, to that Space's agent.
   - This is checked three times: at parse, at Space creation, and by a database trigger. `withSpaceRules` also ignores any stored rule that is not deny or require_approval.
   - Deny still beats approval, so a pack cannot soften a tenant's deny.
3. **Only reviewed content runs.**
   - A review records the SHA-256 of the recipe's behavioural content (id, version, space, policy), who reviewed it and when.
   - Any change to that content makes the recipe unreviewed until someone reviews it again. Wording changes (title, description) do not.
   - Only reviewed recipes can be applied (`409 not_reviewed`).
4. **Bounded by construction.** A recipe's Space must pass the same validation as any Space:
   - no wildcards;
   - a call budget;
   - at most 30 days (`durationHours` ≤ 720);
   - costs only with a money budget.
5. **People can only narrow when applying.** `narrow` may lower calls, spend or duration, or drop tools. Anything else is `400 invalid_narrowing`.

## Format
```yaml
id: draft-replies            # lowercase, dashes
version: 1                   # bump on any behavioural change
title: Draft replies, never send
description: …
space:
  durationHours: 72
  budget: { maxCalls: 200 }  # optional spend: { currency: INR, limitMinor: 500000 }
  tools:
    - { tool: gmail, action: read_thread }
    - { tool: gmail, action: create_draft, constraints: { body: { max: 10000 } } }
policy:                      # the pack: deny or require_approval only
  - { id: no-send, tool: gmail, action: send_email, then: deny }
```
Pack rule ids become `recipe:<id>@<version>:<rule id>`, so the audit log says which recipe made a decision.

## The first-party catalog (`recipes/`)
| Recipe | What it allows | Pack |
|---|---|---|
| `draft-replies` | read threads, create drafts (body ≤ 10,000 characters), 200 calls, 3 days | deny send, delete, forward |
| `meeting-scheduler` | create events with ≤ 10 attendees, each approved by the person, 50 calls, 7 days | deny delete |
| `grocery-runner` | buy from `fresh-mart` only, ≤ INR 5,000 in total, 20 calls, 7 days | orders over INR 2,000 need approval |

Reviews are in `recipes/reviews.json`. These were reviewed by the engineering agent that wrote them (an internal review), not by an independent person.

## Operating it
- Lint: `npx tsx packages/agent-runtime/src/recipes-cli.ts lint recipes`. It exits 1 if anything is unreviewed. The test suite runs the same check, so CI fails on an unreviewed edit.
- Review: `npx tsx packages/agent-runtime/src/recipes-cli.ts review recipes/<file>.yaml --by "<name>" [--notes "…"]`. `--by` is required.
- Runtime (`apps/agent-server`, with `RECIPES_DIR`):
  - `GET /admin/recipes?tenant=…` lists each recipe with its review state;
  - `POST /admin/recipes/<id>/apply` with `{tenant, agentId, createdBy, narrow?}` returns the Space and the recipe version it came from.
- Release: `agent.recipes` is **internal**. Sharing recipes between accounts (`community.recipes`) is **disabled**: shared recipes need a signing and moderation design first.

## Evidence
| Claim | Test | Level |
|---|---|---|
| parse refuses allow, default, per-agent rules, wildcards, long durations | `packages/agent-runtime/test/recipe.test.ts` | U |
| narrowing only lowers; packs apply only to their Space's agent; stored allow ignored | same | U |
| database refuses a non-tightening Space rule | same, PGlite | H |
| any behavioural edit invalidates the review; catalog fully reviewed (CI gate); review tool requires a name | same | U |
| a pack's approval rule acts at the gateway; a tenant deny still wins | `packages/agent-runtime/test/spaces.test.ts` | U, H |
| server: catalog listed; missing scopes refused; applied Space bounds a real MCP client; edited recipe refused | `apps/agent-server/test/recipes.test.ts` | H |

## Not done
- **No signatures on reviews.** A review is a record in the repository, protected by code review of the repository itself. Shared recipes would need signed reviews and a publisher identity.
- **No UI** to browse or apply recipes. That comes with the UI pass (#32). Today it is the admin API.
- **No recipe parameters** (for example "which store"). A different store is a different recipe and a different review.
