// Recipes and policy packs: declarative, reviewed, and never self-granting (docs/19-recipes.md).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { freshDb } from "@recast/store/testing";
import { MemorySpaceStore, RecipeError, SqlAgentRegistry, createAgentIdentity, evaluate, instantiate, isReviewed, parsePolicy, parseRecipe, recipeHash, withSpaceRules, SpaceError, validateSpace } from "../src";
import { loadCatalog, runRecipesCli } from "../src/recipes-cli";

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../recipes");
const T0 = Date.parse("2026-10-19T10:00:00Z");
const base = `id: test-recipe
version: 1
title: Test
description: A test recipe.
space:
  durationHours: 24
  budget: { maxCalls: 10 }
  tools:
    - { tool: gmail, action: create_draft }
policy:
  - { id: no-send, tool: gmail, action: send_email, then: deny }
`;

describe("a recipe is declarative and can only narrow", () => {
  it("parses a valid recipe", () => { expect(parseRecipe(base)).toMatchObject({ id: "test-recipe", policy: [{ then: "deny" }] }); });
  it("refuses allow rules, a default, per-agent rules, wildcards and long durations", () => {
    const bad = [
      base.replace("then: deny", "then: allow"), base + "default: allow\n", base.replace("{ id: no-send,", "{ agent: agt_x, id: no-send,"),
      base.replace("action: create_draft", 'action: "*"'), base.replace("durationHours: 24", "durationHours: 721"), base.replace("maxCalls: 10", "maxCalls: 0"), "{not: [yaml",
    ];
    for (const b of bad) expect(() => parseRecipe(b), b.slice(0, 40)).toThrow(RecipeError);
  });
  it("applying it can lower budgets and drop tools, never raise or remove everything", () => {
    const r = parseRecipe(base); const o = { tenantId: "t", agentId: "a", createdBy: "usr", nowMs: T0 };
    const s = instantiate(r, { ...o, narrow: { maxCalls: 3, durationHours: 2 } });
    expect(s).toMatchObject({ budget: { maxCalls: 3 }, expiresAt: new Date(T0 + 2 * 3600_000).toISOString(), rules: [{ id: "recipe:test-recipe@1:no-send", then: "deny" }] });
    for (const narrow of [{ maxCalls: 11 }, { durationHours: 25 }, { spendLimitMinor: 5 }, { dropTools: ["gmail.create_draft"] }]) expect(() => instantiate(r, { ...o, narrow }), JSON.stringify(narrow)).toThrow(RecipeError);
  });
  it("its policy pack applies only inside its Space, and can only tighten the tenant's policy", async () => {
    const spaces = new MemorySpaceStore(); const sp = await spaces.create(instantiate(parseRecipe(base), { tenantId: "t", agentId: "agt_a", createdBy: "u", nowMs: T0 }), T0);
    const tenant = parsePolicy("rules:\n  - { tool: gmail, then: allow }\n");
    expect(evaluate(tenant, { agentId: "agt_a", tool: "gmail", action: "send_email" }, {}).decision).toBe("allow");
    expect(evaluate(withSpaceRules(tenant, sp), { agentId: "agt_a", tool: "gmail", action: "send_email" }, {}).decision).toBe("deny");
    expect(evaluate(withSpaceRules(tenant, sp), { agentId: "agt_other", tool: "gmail", action: "send_email" }, {}).decision).toBe("allow");   // only this Space's agent
    expect(() => validateSpace({ ...sp, rules: [{ tool: "gmail", then: "allow" }] }, T0)).toThrow(SpaceError);
    const sneaky = { ...sp, rules: [{ tool: "gmail", then: "allow" as const }] };   // even a stored allow is ignored
    expect(evaluate(withSpaceRules(parsePolicy("rules: []\n"), sneaky), { agentId: "agt_a", tool: "gmail", action: "create_draft" }, {}).decision).toBe("deny");
  });
  it("the database refuses a Space rule that is not deny or require_approval", async () => {
    const db = await freshDb(); const t = (await db.query<{ id: string }>(`insert into tenants(name) values ('A') returning id`)).rows[0]!.id;
    const id = await createAgentIdentity("x", "y"); await new SqlAgentRegistry(db).register({ agentId: id.agentId, tenantId: t, name: "x", publicJwk: id.publicJwk });
    const agent = (await db.query<{ id: string }>(`select id from agents where agent_key = $1`, [id.agentId])).rows[0]!.id;
    await expect(db.query(`insert into agent_spaces(tenant_id, agent_id, name, tools, max_calls, expires_at, rules) values ($1,$2,'s','[{"tool":"a","action":"b"}]',1, now() + interval '1 day', '[{"tool":"gmail","then":"allow"}]')`, [t, agent])).rejects.toThrow(/only add deny or require_approval/);
  });
});

describe("only reviewed content can be applied", () => {
  it("a review covers the exact content: any behavioural edit needs a new review", async () => {
    const r = parseRecipe(base); const review = { recipeId: r.id, version: 1, hash: await recipeHash(r), reviewedBy: "x", reviewedAt: "2026-10-19T00:00:00Z" };
    expect(await isReviewed(r, [review])).toEqual(review);
    expect(await isReviewed(parseRecipe(base.replace("maxCalls: 10", "maxCalls: 9")), [review])).toBeNull();
    expect(await isReviewed(parseRecipe(base.replace("title: Test", "title: Renamed")), [review])).toEqual(review);   // wording only
  });
  it("every recipe in the catalog is reviewed for its current content (CI gate)", async () => {
    const cat = await loadCatalog(CATALOG);
    expect(cat.map((c) => [c.recipe.id, !!c.review])).toEqual([["draft-replies", true], ["grocery-runner", true], ["meeting-scheduler", true]]);
  });
  it("the review tool records who reviewed what; lint fails while anything is unreviewed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recipes-")); cpSync(CATALOG, dir, { recursive: true }); const out: string[] = [];
    const f = path.join(dir, "draft-replies.yaml"); writeFileSync(f, readFileSync(f, "utf8").replace("maxCalls: 200", "maxCalls: 2000"));
    expect(await runRecipesCli(["lint", dir], (s) => out.push(s))).toBe(1); expect(out.join("\n")).toMatch(/UNREVIEWED draft-replies/);
    expect(await runRecipesCli(["review", f], (s) => out.push(s))).toBe(1); expect(out.at(-1)).toMatch(/--by <name> is required/);
    expect(await runRecipesCli(["review", f, "--by", "Meera"], (s) => out.push(s))).toBe(0);
    expect(await runRecipesCli(["lint", dir], (s) => out.push(s))).toBe(0);
  });
});
