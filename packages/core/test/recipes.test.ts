// Recipes: one composition, several objects, each still checked by its destination's contract.
import { describe, expect, it } from "vitest";
import { answerClump, mergeClumps, newClump, planRecipe, propose, recipeById, resolve, RECIPES, type Clump, type Fragment } from "../src/index.js";

const CTX = { now: "2026-10-19T09:00:00Z", timezone: "Asia/Kolkata" };
const calendar = { destination: "cal", app: "Calendar", targetKind: "Calendar" as const, reliability: "official-api" as const, accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title", "Event.start", "Event.end", "Event.timezone", "Event.location"] }] };
const drafts = { destination: "drafts", app: "Gmail", targetKind: "Drafts" as const, reliability: "official-api" as const, accepts: [{ relationId: "message-draft-entry", effect: "Save as draft", dataMoved: ["Message.to", "Message.snippet"] }] };
const tasks = { destination: "tasks", app: "Tasks", targetKind: "TaskList" as const, reliability: "official-api" as const, accepts: [{ relationId: "task-tasklist-entry", effect: "Add a task", dataMoved: ["Task.title", "Task.url", "Task.due"] }] };
let n = 0;
const f = (kind: Fragment["kind"], text: string, value?: Fragment["value"]): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, ...(value ? { value } : {}), evidence: [{ locator: { kind: "css", value: `#e${n}` } }], source: { app: "chrome", url: "https://dakshin.example", title: "Dakshin" } });
const join = (...fs: Fragment[]): Clump => fs.slice(1).reduce((c, x) => { const r = mergeClumps(c, newClump(`c${++n}`, x), { confirmChange: true }); if (!r.ok) throw new Error(r.reason); return r.clump; }, newClump("obj-1", fs[0]!));
const dinner = (email?: string) => answerClump(join(f("place", "Dakshin", { name: "Dakshin", address: "12 MG Road" }), f("person", "Maya Rao", { name: "Maya Rao", ...(email ? { email } : {}) }), f("time", "Friday 7:30 PM")), "title", "Dinner with Maya");

describe("first-party recipes", () => {
  it("are definitions only: versioned, with steps, destinations and limitations, and no captured data", () => {
    for (const r of RECIPES) { expect(r.version).toBeGreaterThan(0); expect(r.steps.length).toBeGreaterThan(1); expect(r.limitations.length).toBeGreaterThan(0); expect(JSON.stringify(r)).not.toMatch(/@|https?:/); }
  });
  it("plan and invite: the event, and a draft to Maya worded by the recipe; each is accepted by its destination's contract", () => {
    const [ev, invite] = planRecipe(recipeById("plan-and-invite")!, dinner("maya@example.com"), CTX);
    expect(ev).toMatchObject({ id: "event", targetKind: "Calendar", worded: false, uses: ["Maya Rao", "Dakshin", "Fri, 23 Oct, 7:30 PM"] });
    expect(invite).toMatchObject({ id: "invite", targetKind: "Drafts", worded: true, uses: ["Maya Rao", "the event"], note: "Recast's wording; edit it in your drafts" });
    expect(invite!.candidate!.properties).toEqual({ to: ["maya@example.com"], snippet: "Hi Maya, are you free for Dinner with Maya at Dakshin on Friday 23 October at 7:30 PM?" });
    expect(propose(resolve(ev!.candidate!), calendar)[0]!.status).toBe("ready");
    const [, again] = planRecipe(recipeById("plan-and-invite")!, answerClump(dinner("maya@example.com"), "title", "Meet Maya at Dakshin"), CTX);
    expect(again!.candidate!.properties["snippet"]).toBe("Hi Maya, are you free for Meet Maya at Dakshin on Friday 23 October at 7:30 PM?");
    expect(propose(resolve(invite!.candidate!), drafts)[0]!.status).toBe("ready");
    expect(resolve(invite!.candidate!).fields["snippet"]!.evidence[0]!.locator.value).toBe("recipe:snippet");   // marked as Recast's wording
  });
  it("nothing is invented: without Maya's address the invite step says why, and the event step still stands", () => {
    const [ev, invite] = planRecipe(recipeById("plan-and-invite")!, dinner(), CTX);
    expect(ev!.candidate).not.toBeNull();
    expect(invite).toMatchObject({ candidate: null, reason: "Maya Rao has no email address on the page" });
  });
  it("plan and prepare: a task due on the event's day, with the page it came from", () => {
    const [, prep] = planRecipe(recipeById("plan-and-prepare")!, dinner(), CTX);
    expect(prep!.candidate!.properties).toEqual({ title: "Prepare: Dinner with Maya", due: "2026-10-23", url: "https://dakshin.example" });
    expect(propose(resolve(prep!.candidate!), tasks)[0]!.status).toBe("ready");
  });
  it("an incomplete event blocks every step, with the reason", () => {
    const c = join(f("place", "Dakshin", { name: "Dakshin" }), f("person", "Maya Rao", { name: "Maya Rao", email: "maya@example.com" }));
    for (const s of planRecipe(recipeById("plan-and-invite")!, c, CTX)) expect(s).toMatchObject({ candidate: null, reason: expect.stringMatching(/^the event is not complete/) });
  });
});
