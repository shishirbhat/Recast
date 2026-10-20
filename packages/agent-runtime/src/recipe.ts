import { canonicalJson, sha256Hex } from "@recast/core";
import { parse as parseYaml } from "yaml";
import type { Rule } from "./policy";
import { MAX_SPACE_MS, validateSpace, type SpaceBudget, type SpaceInput, type SpaceTool } from "./space";

/**
 * Recipes: reviewed, declarative templates for a Space. A recipe proposes what an agent may do (tools, constraints, budget,
 * duration, approvals) and a policy pack of rules that only ever deny or ask a person. Applying one creates a Space and nothing
 * else: it never grants a scope, never adds an `allow`, and its pack applies only inside the Space it created.
 * Only a recipe whose exact content was reviewed can be applied; editing it invalidates the review.
 */
export interface Recipe {
  id: string; version: number; title: string; description: string;
  space: { tools: SpaceTool[]; budget: SpaceBudget; durationHours: number };
  /** The policy pack: deny or require_approval only. */
  policy: Rule[];
}
export interface RecipeReview { recipeId: string; version: number; hash: string; reviewedBy: string; reviewedAt: string; notes?: string }
export class RecipeError extends Error {}

const ID = /^[a-z][a-z0-9-]{1,63}$/;
const fail = (m: string): never => { throw new RecipeError(m); };

export function validateRecipe(r: unknown): Recipe {
  if (!r || typeof r !== "object") fail("a recipe must be an object");
  const x = r as Recipe;
  if (typeof x.id !== "string" || !ID.test(x.id)) fail("id must be lowercase letters, digits and dashes");
  if (!Number.isInteger(x.version) || x.version < 1) fail("version must be a positive whole number");
  if (typeof x.title !== "string" || !x.title.trim() || x.title.length > 120) fail("title is required (at most 120 characters)");
  if (typeof x.description !== "string" || x.description.length > 2000) fail("description is required (at most 2000 characters)");
  if (!x.space || typeof x.space !== "object") fail("space is required");
  const hours = x.space.durationHours;
  if (!(typeof hours === "number" && hours > 0 && hours * 3600_000 <= MAX_SPACE_MS)) fail("space.durationHours must be more than 0 and at most 720");
  if (!Array.isArray(x.policy)) fail("policy must be a list (it may be empty)");
  for (const [i, rule] of x.policy.entries()) {
    if (!rule || typeof rule !== "object") fail(`policy[${i}] must be a rule`);
    if (rule.then !== "deny" && rule.then !== "require_approval") fail(`policy[${i}]: a recipe may only deny or require approval, never allow`);
    if (rule.agent !== undefined) fail(`policy[${i}]: a recipe's rules apply to the agent it is given to; 'agent' is not allowed`);
  }
  if ((x as unknown as Record<string, unknown>).default !== undefined) fail("a recipe cannot set the policy default");
  // The Space part must be valid on its own (no wildcards, budgets, costs need a spend budget...).
  validateSpace({ tenantId: "t", agentId: "a", name: x.title, tools: x.space.tools, budget: x.space.budget, expiresAt: new Date(Date.now() + hours * 3600_000).toISOString() }, Date.now());
  return x;
}

export function parseRecipe(text: string): Recipe {
  let doc: unknown; try { doc = parseYaml(text); } catch (e) { throw new RecipeError(`not valid YAML: ${e instanceof Error ? e.message : String(e)}`); }
  try { return validateRecipe(doc); } catch (e) { if (e instanceof RecipeError) throw e; throw new RecipeError(e instanceof Error ? e.message : String(e)); }
}

/** The content a review covers: everything that changes behaviour. */
export const recipeHash = (r: Recipe) => sha256Hex(canonicalJson({ id: r.id, version: r.version, space: r.space, policy: r.policy }));

export async function isReviewed(r: Recipe, reviews: RecipeReview[]): Promise<RecipeReview | null> {
  const h = await recipeHash(r);
  return reviews.find((v) => v.recipeId === r.id && v.version === r.version && v.hash === h) ?? null;
}

/** A person may make a recipe tighter when applying it, never looser. */
export interface Narrowing { maxCalls?: number; spendLimitMinor?: number; durationHours?: number; dropTools?: string[] }

/** The Space a recipe creates for one agent. Throws if the narrowing would widen anything or remove every tool. */
export function instantiate(r: Recipe, o: { tenantId: string; agentId: string; createdBy: string; nowMs: number; narrow?: Narrowing }): SpaceInput {
  const n = o.narrow ?? {};
  if (n.maxCalls !== undefined && !(Number.isInteger(n.maxCalls) && n.maxCalls >= 1 && n.maxCalls <= r.space.budget.maxCalls)) fail(`maxCalls can only be lowered (at most ${r.space.budget.maxCalls})`);
  if (n.durationHours !== undefined && !(n.durationHours > 0 && n.durationHours <= r.space.durationHours)) fail(`durationHours can only be shortened (at most ${r.space.durationHours})`);
  if (n.spendLimitMinor !== undefined && !(r.space.budget.spend && Number.isInteger(n.spendLimitMinor) && n.spendLimitMinor >= 0 && n.spendLimitMinor <= r.space.budget.spend.limitMinor)) fail("the spend limit can only be lowered");
  const drop = new Set(n.dropTools ?? []);
  const tools = r.space.tools.filter((t) => !drop.has(`${t.tool}.${t.action}`)); if (!tools.length) fail("a Space needs at least one tool");
  const budget: SpaceBudget = { maxCalls: n.maxCalls ?? r.space.budget.maxCalls, ...(r.space.budget.spend ? { spend: { currency: r.space.budget.spend.currency, limitMinor: n.spendLimitMinor ?? r.space.budget.spend.limitMinor } } : {}) };
  const rules: Rule[] = r.policy.map((rule, i) => ({ ...rule, id: `recipe:${r.id}@${r.version}:${rule.id ?? i}` }));
  return { tenantId: o.tenantId, agentId: o.agentId, name: r.title, purpose: `From recipe ${r.id} v${r.version}: ${r.description}`.slice(0, 500), tools, budget, rules,
    expiresAt: new Date(o.nowMs + (n.durationHours ?? r.space.durationHours) * 3600_000).toISOString(), createdBy: o.createdBy };
}
