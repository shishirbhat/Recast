#!/usr/bin/env -S npx tsx
// recipes lint <dir>                         every recipe parses, and says whether its exact content is reviewed
// recipes review <file> --by <name> [--notes]  records a review of this exact content in <dir>/reviews.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isReviewed, parseRecipe, recipeHash, RecipeError, type Recipe, type RecipeReview } from "./recipe";

export interface CatalogEntry { file: string; recipe: Recipe; review: RecipeReview | null }
export const reviewsFile = (dir: string) => path.join(dir, "reviews.json");
export const readReviews = (dir: string): RecipeReview[] => (existsSync(reviewsFile(dir)) ? JSON.parse(readFileSync(reviewsFile(dir), "utf8")) : []);

/** Every recipe in a directory, with the review that matches its exact content (or null). A broken recipe stops the load. */
export async function loadCatalog(dir: string): Promise<CatalogEntry[]> {
  const reviews = readReviews(dir); const out: CatalogEntry[] = []; const ids = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    let recipe: Recipe; try { recipe = parseRecipe(readFileSync(path.join(dir, f), "utf8")); } catch (e) { throw new RecipeError(`${f}: ${e instanceof Error ? e.message : String(e)}`); }
    if (ids.has(recipe.id)) throw new RecipeError(`${f}: recipe id '${recipe.id}' is used twice`); ids.add(recipe.id);
    out.push({ file: f, recipe, review: await isReviewed(recipe, reviews) });
  }
  return out;
}

export async function runRecipesCli(argv: string[], out: (s: string) => void, now = () => new Date()): Promise<number> {
  const [cmd, target, ...rest] = argv;
  try {
    if (cmd === "lint" && target) {
      const cat = await loadCatalog(target);
      for (const c of cat) out(`${c.review ? "reviewed  " : "UNREVIEWED"} ${c.recipe.id} v${c.recipe.version} (${c.file})${c.review ? ` by ${c.review.reviewedBy}` : ""}`);
      return cat.every((c) => c.review) ? 0 : 1;
    }
    if (cmd === "review" && target) {
      const by = rest[rest.indexOf("--by") + 1]; if (!rest.includes("--by") || !by) throw new RecipeError("--by <name> is required: a review names who reviewed it");
      const notes = rest.includes("--notes") ? rest[rest.indexOf("--notes") + 1] : undefined;
      const recipe = parseRecipe(readFileSync(target, "utf8")); const dir = path.dirname(target);
      const reviews = readReviews(dir).filter((r) => !(r.recipeId === recipe.id && r.version === recipe.version));
      const review: RecipeReview = { recipeId: recipe.id, version: recipe.version, hash: await recipeHash(recipe), reviewedBy: by, reviewedAt: now().toISOString(), ...(notes ? { notes } : {}) };
      writeFileSync(reviewsFile(dir), JSON.stringify([...reviews, review].sort((a, b) => a.recipeId.localeCompare(b.recipeId) || a.version - b.version), null, 2) + "\n");
      out(`reviewed ${recipe.id} v${recipe.version} (${review.hash.slice(0, 12)}) by ${by}`); return 0;
    }
    out("usage: recipes lint <dir> | recipes review <file> --by <name> [--notes <text>]"); return 2;
  } catch (e) { out(`error: ${e instanceof Error ? e.message : String(e)}`); return 1; }
}

if (process.argv[1] && /recipes-cli\.(ts|js)$/.test(process.argv[1])) runRecipesCli(process.argv.slice(2), (s) => console.log(s)).then((c) => process.exit(c));
