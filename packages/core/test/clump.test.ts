// Clumps: pieces pressed together into one object, recursively, without losing any ingredient.
import { describe, expect, it } from "vitest";
import { answerClump, canMerge, looksLikeError, pieceOfSelection, chooseClump, mergeClumps, newClump, plan, propose, removeIngredient, resolve, typeOf, viewClump, type Clump, type Fragment } from "../src/index.js";
import { relationById } from "../src/rules.js";

const CTX = { now: "2026-10-19T09:00:00Z", timezone: "Asia/Kolkata" };   // Monday 19 Oct 2026, 14:30 in Bengaluru
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({
  id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#el${n}` }, excerpt: text }], source: { app: "chrome", url: `https://example.com/${kind}` }, ...extra,
});
const one = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}) => newClump(`c${++n}`, frag(kind, text, extra));
const merged = (a: Clump, b: Clump, confirmChange = false) => { const r = mergeClumps(a, b, { confirmChange }); if (!r.ok) throw new Error(r.reason); return r.clump; };

describe("pressing pieces together", () => {
  it("Maya + a restaurant is one object: a plan to meet there, still missing a time", () => {
    const maya = one("person", "Maya Rao", { value: { name: "Maya Rao", email: "maya@example.com" } });
    const dakshin = one("place", "Dakshin", { value: { name: "Dakshin", address: "12 MG Road, Bengaluru" } });
    const c = merged(dakshin, maya);
    expect(c.id).toBe(dakshin.id);   // the object that was already there, grown
    const v = viewClump(c, CTX);
    expect(v).toMatchObject({ type: "Event", label: "Meet Maya at Dakshin", proposed: true, placeableAs: ["Calendar"], candidate: null });
    expect(v.summary).toEqual(["Maya Rao", "Dakshin"]);
    expect(v.missing.map((m) => m.field).sort()).toEqual(["start", "title"]);
    expect(v.event!.fields.description).toMatchObject({ value: "With Maya Rao", origin: "extracted" });
  });
  it("the plan + a time is a proposed event, and every ingredient is still there with its source", () => {
    const plan = merged(one("place", "Dakshin", { value: { name: "Dakshin" } }), one("person", "Maya Rao"));
    const c = merged(plan, one("time", "Friday 7:30 PM"));
    expect(c.ingredients.map((f) => f.kind)).toEqual(["place", "person", "time"]);
    const v = viewClump(c, CTX);
    expect(v.event!.fields.start).toMatchObject({ value: "2026-10-23T19:30", origin: "inferred" });
    expect(v.summary).toEqual(["Maya Rao", "Dakshin", "Fri, 23 Oct, 7:30 PM"]);
    expect(v.missing.map((m) => m.field)).toEqual(["title"]);   // never invented: the person accepts the suggestion
    const ready = viewClump(answerClump(c, "title", v.missing[0]!.suggestions![0]!), CTX);
    expect(ready).toMatchObject({ label: "Meet Maya at Dakshin", proposed: false });
    expect(ready.candidate!.type).toBe("Event");
    for (const field of ["location", "start", "description"]) expect(ready.candidate!.fields[field]!.evidence[0]!.source?.url).toMatch(/^https:\/\/example\.com\//);
  });
  it("a composed event goes through the normal proposal path to a calendar, with the usual risk", () => {
    const c = answerClump(merged(merged(one("place", "Dakshin"), one("person", "Maya Rao")), one("time", "2026-10-23 19:30")), "title", "Dinner with Maya");
    const obj = resolve(viewClump(c, CTX).candidate!);
    const contract = { destination: "calendar.agenda", app: "Calendar", targetKind: "Calendar" as const, reliability: "official-api" as const, accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title", "Event.start"] }] };
    const [p] = propose(obj, contract);
    expect(p).toMatchObject({ status: "ready", relationId: "event-calendar-entry" });
    expect(relationById("event-calendar-entry")!.risk).toBe("low");
  });
  it("merging a whole clump into another works (recursive), and order of ingredients is kept", () => {
    const a = merged(one("person", "Maya Rao"), one("person", "Arjun Mehta"));
    expect(viewClump(a, CTX)).toMatchObject({ type: "People", label: "Maya Rao + Arjun Mehta", placeableAs: [] });
    const b = merged(one("place", "Dakshin"), one("time", "2026-10-23 19:30"));
    const c = merged(b, a);
    expect(viewClump(c, CTX).event!.fields.description!.value).toBe("With Maya Rao, Arjun Mehta");
    expect(c.ingredients).toHaveLength(4);
  });
  it("a person + a sentence is a message draft; it needs an address the page did not give", () => {
    const c = merged(one("person", "Maya Rao"), one("text", "Can we move dinner to Saturday?"));
    let v = viewClump(c, CTX);
    expect(v).toMatchObject({ type: "Message", label: "Message Maya", placeableAs: ["Drafts"], candidate: null });
    expect(v.missing[0]!.reason).toMatch(/Maya Rao has no email address on the page/);
    v = viewClump(answerClump(c, "to", "not-an-email"), CTX); expect(v.missing[0]!.reason).toMatch(/does not look like an email/);
    v = viewClump(answerClump(c, "to", "maya@example.com"), CTX);
    expect(v.candidate).toMatchObject({ type: "Message", properties: { to: ["maya@example.com"], snippet: "Can we move dinner to Saturday?" } });
  });
});

describe("what does not merge silently", () => {
  it("a product cannot join a plan; an object cannot merge with itself", () => {
    const plan = merged(one("place", "Dakshin"), one("person", "Maya Rao"));
    const kettle = one("thing", "Stagg EKG Kettle");
    expect(mergeClumps(plan, kettle)).toMatchObject({ ok: false, code: "incompatible", reason: expect.stringMatching(/cannot be combined/) });
    expect(mergeClumps(plan, plan)).toMatchObject({ ok: false, code: "same_object" });
    const t = one("time", "Friday 7 PM"); const withTime = merged(plan, t, true);
    expect(mergeClumps(withTime, one("time", "Friday 7 PM"))).toMatchObject({ ok: false, code: "same_object", reason: "that is already in it" });
  });
  it("a message that gains a time would become an event: the person has to confirm that", () => {
    const msg = merged(one("person", "Maya Rao"), one("text", "Dinner?"));
    expect(canMerge(msg, one("time", "Friday 7 PM"))).toMatchObject({ ok: true, becomes: "Event", change: { from: "Message", to: "Event" } });
    const r = mergeClumps(msg, one("time", "Friday 7 PM"));
    expect(r).toMatchObject({ ok: false, code: "needs_confirmation", becomes: "Event" });
    expect(mergeClumps(msg, one("time", "Friday 7 PM"), { confirmChange: true }).ok).toBe(true);
  });
  it("two different times stay a visible conflict until the person chooses", () => {
    const t1 = frag("time", "Friday 7:30 PM"), t2 = frag("time", "Saturday 8 PM");
    let c = merged(merged(newClump("x", t1), one("place", "Dakshin")), newClump("y", t2));
    const v = viewClump(c, CTX); expect(v.conflicts[0]!.field).toBe("start"); expect(v.candidate).toBeNull();
    c = chooseClump(c, "start", t2.id); expect(viewClump(c, CTX).event!.fields.start!.value).toBe("2026-10-24T20:00");
  });
});

describe("pulling apart", () => {
  it("removing an ingredient gives it back as its own object and recalculates the rest", () => {
    const time = frag("time", "Friday 7:30 PM");
    const c = merged(merged(one("place", "Dakshin"), one("person", "Maya Rao")), newClump("t", time));
    const { rest, released } = removeIngredient(c, time.id, "back");
    expect(released).toEqual({ id: "back", ingredients: [time], answers: {}, choices: {} });
    expect(rest!.id).toBe(c.id); expect(viewClump(rest!, CTX).missing.map((m) => m.field)).toContain("start");
    const last = removeIngredient(removeIngredient(rest!, rest!.ingredients[1]!.id, "r1").rest!, rest!.ingredients[0]!.id, "r2");
    expect(last.rest).toBeNull();
  });
  it("a choice about a removed ingredient goes with it", () => {
    const t1 = frag("time", "Friday 7:30 PM"), t2 = frag("time", "Saturday 8 PM");
    const c = chooseClump(merged(newClump("a", t1), newClump("b", t2)), "start", t2.id);
    expect(removeIngredient(c, t2.id, "z").rest!.choices).toEqual({});
  });
  it("composing is pure: same inputs, same answer, nothing mutated", () => {
    const a = one("place", "Dakshin"), b = one("person", "Maya Rao"); const snapshot = JSON.stringify([a, b]);
    expect(JSON.stringify(viewClump(merged(a, b), CTX))).toBe(JSON.stringify(viewClump(merged(a, b), CTX)));
    expect(JSON.stringify([a, b])).toBe(snapshot);
    expect(typeOf([frag("place", "x")])).toBe("Fragment");
  });
});

describe("a whole page is a document", () => {
  const page = (title: string, url = "https://example.com/q3-plan") => one("page", title, { value: { name: title, url }, confidence: 0.95, evidence: [{ locator: { kind: "meta", value: "title" }, excerpt: title }], source: { app: "example.com", url } });
  // The registry's Google Tasks contract, copied here so the core stays free of the bridges package.
  const tasks = { destination: "google-tasks.list", app: "Google Tasks", targetKind: "Task" as const, reliability: "official-api" as const, accepts: [{ relationId: "document-task-reference", effect: "Add a task", dataMoved: ["Document.title", "Document.url"] }] };

  it("on its own it can go to a task list or a documents tool, with its title and address from the page", () => {
    const v = viewClump(page("Q3 plan"), CTX);
    expect(v).toMatchObject({ type: "Document", label: "Q3 plan", proposed: false, summary: ["Page", "example.com"], placeableAs: ["Task", "Project"], missing: [] });
    expect(v.document!.fields).toMatchObject({ title: { value: "Q3 plan", origin: "extracted" }, url: { value: "https://example.com/q3-plan", origin: "extracted" } });
    expect(v.candidate).toMatchObject({ type: "Document", properties: { title: "Q3 plan", url: "https://example.com/q3-plan" } });
    expect(v.candidate!.fields["title"]!.evidence[0]).toMatchObject({ locator: { kind: "meta", value: "title" }, origin: "extracted", source: { url: "https://example.com/q3-plan" } });
  });
  it("goes through the normal proposal path to Google Tasks: low risk, nobody notified", () => {
    const [p] = propose(resolve(viewClump(page("Q3 plan"), CTX).candidate!), tasks);
    expect(p).toMatchObject({ relationId: "document-task-reference", status: "ready", effectFlags: [] });
    expect(plan(p!, { now: () => CTX.now }).dataMoved).toEqual([{ path: "Document.title", value: "Q3 plan" }, { path: "Document.url", value: "https://example.com/q3-plan" }]);
  });
  it("a page with no title asks for one; what the person types wins, and is marked as theirs", () => {
    const blank = page("");
    const v = viewClump(blank, CTX);
    expect(v).toMatchObject({ type: "Document", candidate: null, missing: [{ field: "title" }] });
    const named = viewClump(answerClump(blank, "title", "Read later: Q3 plan"), CTX);
    expect(named.document!.fields.title).toMatchObject({ value: "Read later: Q3 plan", origin: "user" });
    expect(named.candidate!.fields["title"]!.confidence).toBe(1);
  });
  it("is not pressed into anything but a date: the page and the piece stay whole, and the reason says what would work", () => {
    const c = canMerge(one("person", "Maya Rao"), page("Q3 plan"));
    expect(c).toMatchObject({ ok: false, code: "incompatible" });
    expect(c.ok ? "" : c.reason).toMatch(/Q3 plan is a whole page: add a date to make it a task/);
    expect(typeOf([frag("page", "A"), frag("page", "B")])).toHaveProperty("incompatible");
    expect(typeOf([frag("page", "A"), frag("time", "Friday"), frag("person", "Maya")])).toHaveProperty("incompatible");
  });
});

describe("a page and a date are a task", () => {
  const page = (title = "Q3 plan") => one("page", title, { value: { name: title, url: "https://example.com/q3" }, confidence: 0.95, source: { app: "example.com", url: "https://example.com/q3" } });
  const list = { destination: "google-tasks.tasklist", app: "Google Tasks", targetKind: "TaskList" as const, reliability: "official-api" as const, accepts: [{ relationId: "task-tasklist-entry", effect: "Add a task", dataMoved: ["Task.title", "Task.url", "Task.due"] }] };

  it("turning the document into a task is the person's call (it changes where it can go)", () => {
    const r = mergeClumps(page(), one("time", "Friday"));
    expect(r).toMatchObject({ ok: false, code: "needs_confirmation", becomes: "Task" });
    expect(r.ok ? "" : r.reason).toBe("this turns the document into a task");
  });
  it("is due on the day the time piece names, read in the person's time zone; a time of day is shown as not kept", () => {
    const v = viewClump(merged(page(), one("time", "Friday 5 PM"), true), CTX);
    expect(v).toMatchObject({ type: "Task", label: "Q3 plan", placeableAs: ["TaskList"], summary: ["Task", "due Fri, 23 Oct"], missing: [] });
    expect(v.task!.fields.due).toMatchObject({ value: "2026-10-23", origin: "inferred" });
    expect(v.assumptions).toEqual(["A task is due on a day: the time (5:00 PM) is not kept"]);
    expect(v.candidate).toMatchObject({ type: "Task", properties: { title: "Q3 plan", url: "https://example.com/q3", due: "2026-10-23" } });
    const [p] = propose(resolve(v.candidate!), list);
    expect(p).toMatchObject({ relationId: "task-tasklist-entry", status: "ready", effectFlags: [] });
    expect(plan(p!, { now: () => CTX.now }).dataMoved).toEqual([{ path: "Task.title", value: "Q3 plan" }, { path: "Task.url", value: "https://example.com/q3" }, { path: "Task.due", value: "2026-10-23" }]);
  });
  it("two dates that disagree are shown, not chosen; the person's pick wins; a typed date wins over both", () => {
    const fri = one("time", "Friday"), sat = one("time", "Saturday");
    const c = merged(merged(page(), fri, true), sat);
    const v = viewClump(c, CTX);
    expect(v.candidate).toBeNull(); expect(v.conflicts.map((x) => x.field)).toEqual(["start"]);
    const picked = viewClump(chooseClump(c, "start", sat.ingredients[0]!.id), CTX);
    expect(picked.task!.fields.due!.value).toBe("2026-10-24"); expect(picked.candidate).not.toBeNull();
    const typed = viewClump(answerClump(c, "due", "2026-11-02"), CTX);
    expect(typed.task!.fields.due).toMatchObject({ value: "2026-11-02", origin: "user" });
  });
  it("a time piece with no readable date asks for the date", () => {
    const v = viewClump(merged(page(), one("time", "sometime soon"), true), CTX);
    expect(v.candidate).toBeNull(); expect(v.missing.map((m) => m.field)).toEqual(["due"]);
  });
});

describe("passages → a note that keeps its sources (D31)", () => {
  const quote = (text: string, url: string, title: string) => one("text", text, { source: { app: "chrome", url, title } });
  it("two passages from two pages are one note; each keeps its page; the title is suggested, not assumed", () => {
    const c = merged(quote("Interfaces should disappear.", "https://a.example/essay", "On tools"), quote("Make the common case fast.", "https://b.example/notes", "Notes"));
    const v = viewClump(c, CTX);
    expect(v).toMatchObject({ type: "Note", label: "On tools", proposed: true, placeableAs: ["Docs"], candidate: null, summary: ["2 passages", "from 2 pages"] });
    expect(v.missing).toEqual([{ field: "title", reason: "a note needs a title", suggestions: ["On tools"] }]);
    expect(v.note!.fields.body!.value).toBe("“Interfaces should disappear.”\n— On tools, https://a.example/essay\n\n“Make the common case fast.”\n— Notes, https://b.example/notes");
    expect(v.note!.sources).toEqual(["https://a.example/essay", "https://b.example/notes"]);
  });
  it("with a title it is a complete Note object; every passage's evidence and source come along", () => {
    const c = answerClump(merged(quote("Interfaces should disappear.", "https://a.example/essay", "On tools"), quote("Make the common case fast.", "https://b.example/notes", "Notes")), "title", "Design reading");
    const v = viewClump(c, CTX);
    expect(v).toMatchObject({ type: "Note", label: "Design reading", proposed: false, missing: [] });
    const o = resolve(v.candidate!);
    expect(o.type).toBe("Note");
    expect(o.properties).toMatchObject({ title: "Design reading", sources: ["https://a.example/essay", "https://b.example/notes"] });
    expect(o.fields["body"]!.evidence.map((e) => e.source?.url)).toEqual(["https://a.example/essay", "https://b.example/notes"]);
    expect(o.fields["title"]!.evidence[0]!.origin).toBe("user");
    expect(o.properties["body"]).toBe(v.note!.fields.body!.value);   // line breaks survive: the document reads as the review did
  });
  it("a single passage can be placed on its own as a note; a person turns a note into a message, after asking", () => {
    const v = viewClump(answerClump(quote("Make the common case fast.", "https://b.example/notes", "Notes"), "title", "One line"), CTX);
    expect(v).toMatchObject({ type: "Fragment", placeableAs: ["Docs"] }); expect(v.candidate!.type).toBe("Note");
    const note = merged(quote("a", "https://a.example", "A"), quote("b", "https://b.example", "B"));
    expect(canMerge(note, one("person", "Maya Rao"))).toMatchObject({ ok: true, becomes: "Message", change: { from: "Note", to: "Message" } });
  });
});

describe("an error → an issue (D32)", () => {
  const err = (text: string) => one("error", text, { source: { app: "chrome", url: "https://ci.example/run/42", title: "Build #42" } });
  it("an error with a note is an issue; everything captured is quoted literally, so a mention or link cannot act", () => {
    const c = merged(err("TypeError: Cannot read properties of undefined (reading 'id')\n    at load (app.js:12)"), one("text", "Happens after @maya signs in ```twice``` [x](https://evil.example)", { source: { app: "chrome", url: "https://ci.example/run/42", title: "Build #42" } }));
    const v = viewClump(c, CTX);
    expect(v).toMatchObject({ type: "Issue", proposed: true, placeableAs: ["Issues"], candidate: null, label: "TypeError: Cannot read properties of undefined (reading 'id')" });
    const body = v.issue!.fields.body!.value;
    expect(body).toBe([
      "Captured with Recast. Everything below is quoted exactly as it appeared.",
      "**Error**\n```text\nTypeError: Cannot read properties of undefined (reading 'id')\nat load (app.js:12)\n```",
      "**Notes**\n````text\nHappens after @maya signs in ```twice``` [x](https://evil.example)\n````",
      "**Seen on**\n```text\nBuild #42 — https://ci.example/run/42\n```",
    ].join("\n\n"));
    const o = resolve(viewClump(answerClump(c, "title", "Sign-in crash"), CTX).candidate!);
    expect(o.type).toBe("Issue"); expect(o.properties["body"]).toBe(body); expect(o.properties["sources"]).toEqual(["https://ci.example/run/42"]);
  });
  it("an error alone can be placed as an issue; a time or a person does not join an error", () => {
    expect(viewClump(err("Error: exit code 2"), CTX)).toMatchObject({ type: "Fragment", placeableAs: ["Issues"], missing: [{ field: "title", suggestions: ["Error: exit code 2"] }] });
    expect(canMerge(err("panic: oops"), one("time", "Friday 7 PM"))).toMatchObject({ ok: false, code: "incompatible" });
    expect(canMerge(err("panic: oops"), one("person", "Maya Rao"))).toMatchObject({ ok: false, code: "incompatible" });
  });
  it("what reads as an error", () => {
    for (const t of ["TypeError: x is undefined", "Traceback (most recent call last):", "panic: runtime error", "npm ERR! code ERR_SOCKET_TIMEOUT", "Process completed with exit code 1", "Uncaught ReferenceError: y"]) expect(looksLikeError(t), t).toBe(true);
    for (const t of ["Free for dinner this week?", "The filter coffee alone is worth the trip.", "exit code 0"]) expect(looksLikeError(t), t).toBe(false);
  });
});

describe("phase two: what a selection is, from its text alone", () => {
  it.each([
    ["Friday 23 October, 5:00 PM", "time"], ["tomorrow at 7pm", "time"], ["7:30 PM", "time"],
    ["maya.rao@example.com", "person"], ["TypeError: x is undefined", "error"],
    ["The filter coffee alone is worth the trip.", "text"], ["Q3 planning notes", "text"],
    ["We met on Friday and talked for hours about the roadmap and the hiring plan for next year", "text"],
  ])("%s → %s", (text, kind) => { expect(pieceOfSelection(text, CTX).kind).toBe(kind); });
  it("an email address carries its address as the person's email", () => {
    expect(pieceOfSelection("mailto:Maya.Rao@Example.com", CTX)).toEqual({ kind: "person", value: { email: "maya.rao@example.com" } });
  });
});
