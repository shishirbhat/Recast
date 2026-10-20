// Composition through the interaction engine: collect pieces into one capsule, preview what they make, fill in what is
// missing, then place through the normal consent path. Real core (compose, resolve, propose, commit) and a real bridge.
import { describe, expect, it } from "vitest";
import { chipRect, selectView } from "../src/index.js";
import { Driver, R } from "./driver.js";

const at = (r: { x: number; y: number }) => ({ x: r.x + 5, y: r.y + 5 });
/** With the lift key held while carrying, click another piece to add it. */
function addPiece(d: Driver, r: { x: number; y: number }) {
  d.hit(d.send({ type: "liftKey", down: true }));
  const p = at(r); d.move(p.x, p.y); d.down(p.x, p.y); d.up(p.x, p.y);
  d.send({ type: "liftKey", down: false });
}
const agendaChip = () => { const c = chipRect(R.agenda, 0); return { x: c.x + 20, y: c.y + 10 }; };

describe("capsule: collecting pieces", () => {
  it("lifting a piece starts a capsule; releasing over nothing keeps it instead of cancelling", () => {
    const d = new Driver(); d.lift("when");
    expect(d.state.phase).toBe("carrying"); expect(d.state.capsule?.fragments.map((f) => f.id)).toEqual(["when"]);
    expect(d.state.live).toMatch(/Added time "Sat 14 Nov 2026, 7:30 pm". 1 piece in the capsule. Still needs title/);
    d.up(R.when.x + 5, R.when.y + 5);
    expect(d.state.phase).toBe("carrying"); expect(d.state.outcome).toBeNull();
    expect(d.state.live).toMatch(/Holding 1 piece/);
  });
  it("adds more pieces with the lift key; the same piece twice is refused; the view shows values and their origins", () => {
    const d = new Driver(); d.lift("when"); d.up(R.when.x + 5, R.when.y + 5);
    addPiece(d, R.where);
    d.hit(d.send({ type: "liftKey", down: true })); d.move(R.where.x + 5, R.where.y + 5);
    expect(selectView(d.state).capsuleOutline).toBeNull();          // a piece already in the capsule is not offered again
    d.down(R.where.x + 5, R.where.y + 5); d.up(R.where.x + 5, R.where.y + 5); d.send({ type: "liftKey", down: false });
    expect(d.state.capsule?.fragments.map((f) => f.id)).toEqual(["when", "where"]);
    const v = selectView(d.state);
    expect(v.token).toMatchObject({ pieces: 2, type: "Event" });
    expect(v.capsule?.status).toBe("incomplete");
    expect(v.capsule?.fields).toEqual(expect.arrayContaining([{ name: "start", value: "2026-11-14T19:30", origin: "extracted" }, expect.objectContaining({ name: "end", origin: "default" })]));
    expect(v.capsule?.missing.map((m) => m.field)).toEqual(["title"]);
  });
  it("with the lift key down, the piece under the pointer is outlined before it is added", () => {
    const d = new Driver(); d.lift("when"); d.up(R.when.x + 5, R.when.y + 5);
    d.hit(d.send({ type: "liftKey", down: true })); d.move(R.what.x + 5, R.what.y + 5);
    expect(selectView(d.state).capsuleOutline).toEqual(R.what);
    expect(d.state.live).toMatch(/Launch dinner. Click to add it to the capsule/);
  });
});

describe("capsule: placing", () => {
  it("time + place + title is complete: the calendar offers a normal chip, previews the event, and places it on release", async () => {
    const d = new Driver(); d.lift("when"); d.up(R.when.x + 5, R.when.y + 5); addPiece(d, R.where); addPiece(d, R.what);
    expect(d.state.carried?.object?.type).toBe("Event");
    const c = agendaChip(); d.move(R.agenda.x + 40, R.agenda.y + 120); d.move(c.x, c.y);
    expect(d.state.phase).toBe("previewing");
    expect(d.state.chips[0]).toMatchObject({ label: "entry", status: "ready" }); expect(d.state.chips[0]!.needs).toBeUndefined();
    expect(d.state.preview?.ghost.rows).toEqual(expect.arrayContaining([{ label: "Event.title", value: "Launch dinner" }, { label: "Event.start", value: "2026-11-14T19:30" }]));
    await d.run(d.up(c.x, c.y));
    expect(d.bridges["calendar.agenda"]!.state).toEqual(["Add to calendar|Launch dinner|2026-11-14T19:30|2026-11-14T20:30|Toit, 298 100 Feet Rd, Bengaluru"]);
    expect(d.state.toast?.kind).toBe("placed"); expect(d.state.capsule).toBeNull();
  });
  it("missing title: the chip says so, the preview shows 'needed' (never a guess), placing asks for it, then places", async () => {
    const d = new Driver(); d.lift("when"); d.up(R.when.x + 5, R.when.y + 5); addPiece(d, R.where);
    const c = agendaChip(); d.move(R.agenda.x + 40, R.agenda.y + 120); d.move(c.x, c.y);
    expect(d.state.chips[0]).toMatchObject({ label: "entry", needs: ["title"] });
    expect(d.state.preview?.ghost.rows).toContainEqual({ label: "Event.title", value: "needed" });
    expect(d.state.live).toMatch(/Still needs title. Release to fill them in/);
    d.up(c.x, c.y);
    expect(d.state.phase).toBe("completing"); expect(selectView(d.state).completing).toBe(true);
    expect(d.state.live).toMatch(/Before it can be placed: title/);
    d.key("Enter"); expect(d.state.phase).toBe("completing"); expect(d.state.live).toBe("Still needed: title.");
    d.send({ type: "answer", field: "title", value: "Dinner with Meera" });
    expect(d.state.live).toBe("Complete. Press Enter to continue.");
    await d.run(d.key("Enter"));
    expect(d.bridges["calendar.agenda"]!.state[0]).toMatch(/^Add to calendar\|Dinner with Meera\|2026-11-14T19:30/);
    expect(d.eventLog).toBeDefined();
  });
  it("two different times: shown as a choice, never silently picked", async () => {
    const d = new Driver(); d.lift("when"); d.up(R.when.x + 5, R.when.y + 5); addPiece(d, R.when2); addPiece(d, R.what);
    const v = selectView(d.state); expect(v.capsule?.conflicts[0]).toMatchObject({ field: "start", options: [{ value: "2026-11-14", fragmentId: "when" }, { value: "2026-11-15", fragmentId: "when2" }] });
    const c = agendaChip(); d.move(R.agenda.x + 40, R.agenda.y + 120); d.move(c.x, c.y);
    expect(d.state.chips[0]!.needs).toEqual(["a choice of start"]);
    d.up(c.x, c.y); expect(d.state.phase).toBe("completing");
    d.send({ type: "choose", field: "start", fragmentId: "when2" });
    await d.run(d.key("Enter"));
    expect(d.bridges["calendar.agenda"]!.state[0]).toMatch(/\|2026-11-15T19:30\|/);
  });
  it("Escape while completing cancels: nothing is placed and the capsule is gone", () => {
    const d = new Driver(); d.lift("when"); d.up(R.when.x + 5, R.when.y + 5);
    const c = agendaChip(); d.move(R.agenda.x + 40, R.agenda.y + 120); d.move(c.x, c.y); d.up(c.x, c.y);
    expect(d.state.phase).toBe("completing");
    d.key("Escape");
    expect(d.state).toMatchObject({ phase: "idle", capsule: null, outcome: { kind: "cancelled", reason: "escape" } });
    expect(d.bridges["calendar.agenda"]!.state).toEqual([]); expect(d.log.some((e) => e.type === "commit")).toBe(false);
  });
  it("a piece-only capsule is not offered to destinations that cannot take an event", () => {
    const d = new Driver(); d.lift("when"); d.up(R.when.x + 5, R.when.y + 5);
    d.move(R.mail.x + 50, R.mail.y + 50);
    expect(d.state.chips).toEqual([]); expect(d.state.destination).toBeNull();
  });
  it("the captured pieces are never changed by composing, answering or placing", async () => {
    const d = new Driver(); const before = JSON.stringify(d.sc.candidates.map((c) => c.fragment ?? null));
    d.lift("when"); d.up(R.when.x + 5, R.when.y + 5); addPiece(d, R.where);
    const c = agendaChip(); d.move(R.agenda.x + 40, R.agenda.y + 120); d.move(c.x, c.y); d.up(c.x, c.y);
    d.send({ type: "answer", field: "title", value: "X" }); await d.run(d.key("Enter"));
    expect(JSON.stringify(d.sc.candidates.map((c2) => c2.fragment ?? null))).toBe(before);
  });
});

describe("capsule: what can start one", () => {
  it("a title alone is not liftable; it joins a capsule that already has a time", () => {
    const d = new Driver();
    d.hit(d.send({ type: "liftKey", down: true })); d.move(R.what.x + 5, R.what.y + 5);
    expect(d.state.hovered).toBeNull();
    d.down(R.what.x + 5, R.what.y + 5); expect(d.state.phase).toBe("lifting"); expect(d.state.capsule).toBeNull();
  });
});

describe("capsule: starting from a whole object", () => {
  it("carrying an object that is also a piece, then adding a time, turns the carry into a capsule of both", () => {
    const d = new Driver();
    const toit = d.sc.candidates.find((c) => c.id === "toit")!;
    toit.fragment = { id: "toit", kind: "place", text: "Toit", value: { name: "Toit" }, confidence: 0.9, evidence: [{ locator: { kind: "css", value: "#toit" } }] };
    d.lift("toit");
    expect(d.state.capsule).toBeNull(); expect(d.state.carried?.object?.type).toBe("Location");
    addPiece(d, R.when);
    expect(d.state.capsule?.fragments.map((f) => f.id)).toEqual(["toit", "when"]);
    expect(d.state.carried?.id).toBe("capsule");
  });
});

describe("capsule: keyboard only", () => {
  it("Space adds the focused piece, Enter finishes, Tab reaches the calendar, Enter places", async () => {
    const d = new Driver(); await d.run(d.send({ type: "keyboardLift" }));
    const tabTo = (id: string) => { for (let i = 0; i < 12 && d.state.hovered?.id !== id; i++) d.key("Tab"); expect(d.state.hovered?.id).toBe(id); };
    tabTo("what"); d.key(" "); expect(d.state.live).toBe("A title joins a capsule once it holds a time or a place."); expect(d.state.capsule).toBeNull();
    tabTo("when"); expect(d.state.live).toMatch(/a time\. Space to add it to a capsule/);
    d.key(" "); tabTo("where"); d.key(" "); tabTo("what"); d.key(" ");
    expect(d.state.capsule?.fragments.map((f) => f.id)).toEqual(["when", "where", "what"]); expect(d.state.phase).toBe("lifting");
    d.key("Enter");
    expect(d.state.placements.map((p) => `${p.label}@${p.destination.id}`)).toEqual(["entry@agenda"]);
    await d.run(d.key("Enter"));
    expect(d.bridges["calendar.agenda"]!.state[0]).toMatch(/^Add to calendar\|Launch dinner\|/);
  });
});
