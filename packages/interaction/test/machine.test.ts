import { describe, expect, it } from "vitest";
import { HOLD_MS, serialize } from "@recast/core";
import { CHIP_H, CHIP_W, chipRect, selectView } from "../src/index.js";
import { Driver, R } from "./driver.js";

// chip i of a destination, as a point inside it
const chipAt = (dest: typeof R.calendar, i = 0) => { const c = chipRect(dest, i); return { x: c.x + CHIP_W / 2, y: c.y + CHIP_H / 2 }; };

describe("lifting", () => {
  it("enters lift mode on the key, outlines what is under the pointer, and leaves when the key is released", () => {
    const d = new Driver();
    d.hit(d.send({ type: "liftKey", down: true }));
    expect(d.state.phase).toBe("lifting");
    d.move(30, 30);
    expect(d.state.hovered?.id).toBe("meera");
    expect(selectView(d.state).liftOutline).toEqual(R.meera);
    expect(d.state.live).toMatch(/Meera Iyer, Person\. Click to lift/);
    d.move(400, 600);
    expect(d.state.hovered).toBeNull();
    d.send({ type: "liftKey", down: false });
    expect(d.state.phase).toBe("idle");
  });
  it("ignores a hit-test answer that belongs to an older question", () => {
    const d = new Driver();
    d.hit(d.send({ type: "liftKey", down: true }));
    const fx = d.send({ type: "pointerMove", p: { x: 30, y: 30 } });
    d.move(400, 600);                                              // a newer question, answered first
    d.hit(fx);                                                     // the stale answer arrives late
    expect(d.state.hovered).toBeNull();
  });
  it("carries on after the key is released once something is lifted", () => {
    const d = new Driver(); d.lift("meera");
    expect(d.state.phase).toBe("carrying");
    d.send({ type: "liftKey", down: false });
    expect(d.state.phase).toBe("carrying");
  });
});

describe("approach and preview", () => {
  it("shows only the relationships the destination supports for this object, then a ghost on the nearest chip", () => {
    const d = new Driver(); d.lift("meera");
    d.move(450, 120);                                              // inside the calendar
    expect(d.state.phase).toBe("approaching");
    expect(d.state.chips.map((c) => c.label)).toEqual(["attendee"]);   // a Person is not offered "location"
    const v = selectView(d.state); expect(v.destinationRect).toEqual(R.calendar);
    const c = chipAt(R.calendar); d.move(c.x - 40, c.y);          // near the chip: the magnet takes it
    expect(d.state.phase).toBe("previewing");
    expect(selectView(d.state).token).toMatchObject({ snapped: true });
    expect(selectView(d.state).ghost?.ghost.rows).toEqual([{ label: "Person.name", value: "Meera Iyer" }, { label: "Person.email", value: "meera@example.com" }]);
    d.move(450, 250);                                              // far from the chip
    expect(d.state.phase).toBe("approaching"); expect(selectView(d.state).ghost).toBeNull();
    d.move(400, 600);                                              // off every destination
    expect(d.state.phase).toBe("carrying"); expect(d.state.chips).toEqual([]);
  });
  it("does not treat a window as a destination if it supports nothing for this object", () => {
    const d = new Driver(); d.lift("meera");
    d.move(800, 100);                                              // Tasks only accepts Documents
    expect(d.state.phase).toBe("carrying"); expect(d.state.destination).toBeNull(); expect(d.state.chips).toEqual([]);
  });
  it("announces destination, options and preview for screen readers", () => {
    const d = new Driver(); d.lift("meera"); d.move(450, 120);
    expect(d.state.live).toBe("Google Calendar. Options: attendee.");
    const c = chipAt(R.calendar); d.move(c.x, c.y);
    expect(d.state.live).toMatch(/^attendee\. Add attendee: Meera Iyer as attendee\. Release to place\.$/);
  });
  it("lets an object that is not sure of itself be chosen only by going directly over the chip (no magnet)", () => {
    const d = new Driver(); d.lift("shaky");
    d.move(450, 120); const c = chipAt(R.calendar);
    d.move(c.x - CHIP_W / 2 - 30, c.y);                            // would be within the magnet for a confident object
    expect(d.state.phase).toBe("approaching");
    d.move(c.x, c.y);
    expect(d.state.phase).toBe("previewing");
  });
});

describe("placing: consent follows the trust model", () => {
  it("low risk: executes on release, toasts, and Undo really reverses it", async () => {
    const d = new Driver(); d.lift("toit"); d.move(450, 120);
    const c = chipAt(R.calendar); d.move(c.x, c.y);
    const fx = d.up(c.x, c.y);
    expect(fx).toEqual([expect.objectContaining({ type: "commit", consent: { kind: "release" } })]);
    expect(d.state.phase).toBe("committing");
    await d.run(fx);
    expect(d.state.phase).toBe("idle");
    expect(d.bridges["google-calendar.event-editor"]!.state).toEqual(["Set location|Toit|298 100 Feet Rd, Bengaluru"]);
    expect(d.state.toast).toMatchObject({ kind: "placed", text: "Added as location" });
    expect(selectView(d.state).toast!.remainingMs).toBe(6000);
    await d.run(d.send({ type: "undoRequest" }));
    expect(d.bridges["google-calendar.event-editor"]!.state).toEqual([]);
    expect(d.state.toast).toMatchObject({ kind: "undone", text: "Undone" });
    expect((await d.eventLog.entries()).map((e) => e.kind)).toEqual(["commit", "undo"]);
  });
  it("the toast lasts six seconds, and an undone toast three", async () => {
    const d = new Driver(); d.lift("toit"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y);
    await d.run(d.up(c.x, c.y));
    d.advance(5999); expect(d.state.toast).not.toBeNull();
    d.advance(1); expect(d.state.toast).toBeNull();
  });
  it("medium risk (notifies someone): release asks for a light confirmation instead of committing", async () => {
    const d = new Driver(); d.lift("meera"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y);
    const fx = d.up(c.x, c.y);
    expect(fx).toEqual([]);
    expect(d.state.phase).toBe("confirming"); expect(d.state.pending?.kind).toBe("confirm");
    expect(d.bridges["google-calendar.event-editor"]!.state).toEqual([]);
    await d.run(d.down(c.x, c.y));
    expect(d.bridges["google-calendar.event-editor"]!.state).toEqual(["Add attendee|Meera Iyer|meera@example.com"]);
    expect(d.state.toast?.text).toBe("Added as attendee");
  });
  it("high risk (send): needs a real hold of 600 ms; 599 ms does nothing", async () => {
    const d = new Driver(); d.lift("meera"); d.move(450, 420); const c = chipAt(R.mail); d.move(c.x, c.y);
    expect(d.up(c.x, c.y)).toEqual([]);
    expect(d.state.pending?.kind).toBe("hold");
    d.down(c.x, c.y); d.advance(300);
    expect(selectView(d.state).hold!.progress).toBeCloseTo(0.5, 1);
    expect(d.advance(299)).toEqual([]);
    expect(d.bridges["mail.send-now"]!.state).toEqual([]);
    const fx = d.advance(1);                                       // 600 ms
    expect(fx).toEqual([expect.objectContaining({ type: "commit", consent: { kind: "hold", heldMs: HOLD_MS } })]);
    await d.run(fx);
    expect(d.bridges["mail.send-now"]!.state).toEqual(["Send to person|meera@example.com"]);
    expect(d.state.toast?.text).toBe("Sent");
  });
  it("letting go of a hold early starts over and commits nothing", () => {
    const d = new Driver(); d.lift("meera"); d.move(450, 420); const c = chipAt(R.mail); d.move(c.x, c.y); d.up(c.x, c.y);
    d.down(c.x, c.y); d.advance(400);
    d.up(c.x, c.y);
    expect(d.state.hold).toEqual({ startedAt: null, progress: 0 });
    expect(d.advance(1000)).toEqual([]); expect(d.state.phase).toBe("confirming");
    expect(d.state.live).toMatch(/longer/);
  });
  it("a blocked chip explains why, and releasing on it places nothing", () => {
    const d = new Driver(); d.lift("noemail"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y);
    expect(d.state.chips[0]).toMatchObject({ status: "blocked", reason: "needs email" });
    expect(d.state.blockedNote).toBe("Can't: needs email");
    expect(selectView(d.state).ghost).toBeNull();
    const fx = d.up(c.x, c.y);
    expect(fx).toEqual([]); expect(d.state.phase).toBe("idle");
    expect(d.state.outcome).toEqual({ kind: "cancelled", reason: "blocked: needs email" });
  });
  it("dropping on nothing cancels and changes nothing", () => {
    const d = new Driver(); d.lift("meera"); d.move(450, 120); d.move(450, 600);
    expect(d.up(450, 600)).toEqual([]);
    expect(d.state.outcome).toEqual({ kind: "cancelled", reason: "dropped-nowhere" });
    for (const b of Object.values(d.bridges)) expect(b.state).toEqual([]);
  });
  it("a failed placement says so, changes nothing, and can be retried", async () => {
    const d = new Driver(); d.bridges["google-calendar.event-editor"]!.failNext = true;
    d.lift("toit"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y);
    await d.run(d.up(c.x, c.y));
    expect(d.state.toast).toMatchObject({ kind: "error", text: "Couldn't place it: destination unavailable. Nothing changed." });
    expect(d.bridges["google-calendar.event-editor"]!.state).toEqual([]);
    d.lift("toit"); d.move(450, 120); d.move(c.x, c.y);
    await d.run(d.up(c.x, c.y));
    expect(d.bridges["google-calendar.event-editor"]!.state).toHaveLength(1);
  });
});

describe("Escape", () => {
  const phases: [string, (d: Driver) => void][] = [
    ["lifting", (d) => d.hit(d.send({ type: "liftKey", down: true }))],
    ["carrying", (d) => d.lift("meera")],
    ["approaching", (d) => { d.lift("meera"); d.move(450, 250); }],
    ["previewing", (d) => { d.lift("meera"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y); }],
    ["confirming", (d) => { d.lift("meera"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y); d.up(c.x, c.y); }],
  ];
  it.each(phases)("cancels from %s and changes nothing", (phase, setup) => {
    const d = new Driver(); setup(d);
    expect(d.state.phase).toBe(phase);
    expect(d.key("Escape")).toEqual([]);
    expect(d.state.phase).toBe("idle"); expect(d.state.carried).toBeNull(); expect(d.state.chips).toEqual([]);
    expect(d.state.outcome).toEqual({ kind: "cancelled", reason: "escape" });
    for (const b of Object.values(d.bridges)) expect(b.state).toEqual([]);
  });
  it("cannot take back a commit already sent; the placement still lands with its toast and Undo", async () => {
    const d = new Driver(); d.lift("toit"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y);
    const fx = d.up(c.x, c.y);
    d.key("Escape");
    expect(d.state.phase).toBe("committing");
    await d.run(fx);
    expect(d.state.toast?.kind).toBe("placed");
  });
});

describe("keyboard-only path", () => {
  it("lifts by keyboard, tabs through every place it could go, and places with Enter", async () => {
    const d = new Driver();
    await d.run(d.send({ type: "keyboardLift" }));
    expect(d.state).toMatchObject({ phase: "lifting", mode: "keyboard" });
    expect(d.state.live).toMatch(/^Meera Iyer, Person\. Enter to lift\.$/);
    d.key("Tab"); expect(d.state.hovered?.id).toBe("noemail");
    d.key("Tab", true, true); expect(d.state.hovered?.id).toBe("meera");
    d.key("Enter");
    expect(d.state.phase).toBe("previewing");
    expect(d.state.placements.map((p) => `${p.proposal.relation}@${p.destination.id}`)).toEqual(["attendee@calendar", "recipient@mail"]);
    expect(d.state.live).toMatch(/attendee\. Add attendee: Meera Iyer as attendee/);
    d.key("Tab"); expect(d.state.destination?.id).toBe("mail");
    d.key("Tab"); expect(d.state.destination?.id).toBe("calendar");
    d.key("Enter");
    expect(d.state.phase).toBe("confirming");                      // notifies someone: light confirmation
    await d.run(d.key("Enter"));
    expect(d.bridges["google-calendar.event-editor"]!.state).toEqual(["Add attendee|Meera Iyer|meera@example.com"]);
    expect(d.state.toast?.text).toBe("Added as attendee");
  });
  it("high-risk by keyboard: hold Enter for 600 ms", async () => {
    const d = new Driver(); await d.run(d.send({ type: "keyboardLift" })); d.key("Enter");
    d.key("Tab"); d.key("Enter");
    expect(d.state.pending?.kind).toBe("hold");
    d.key("Enter", true); d.advance(599);
    d.key("Enter", false); expect(d.state.hold.startedAt).toBeNull();
    d.key("Enter", true); d.advance(300); d.advance(300);
    await d.run(d.effects);
    expect(d.bridges["mail.send-now"]!.state).toEqual(["Send to person|meera@example.com"]);
  });
  it("says so when nothing accepts the lifted object, and Escape leaves", async () => {
    const d = new Driver(); d.sc.destinations = d.sc.destinations.filter((x) => x.id === "tasks");
    await d.run(d.send({ type: "keyboardLift" })); d.key("Enter");
    expect(d.state.live).toMatch(/Nothing here accepts Meera Iyer/);
    d.key("Escape"); expect(d.state.phase).toBe("idle");
  });
  it("the keyboard lift shortcut pressed again cancels", async () => {
    const d = new Driver(); await d.run(d.send({ type: "keyboardLift" }));
    d.send({ type: "keyboardLift" });
    expect(d.state.phase).toBe("idle");
  });
  it("ignores the pointer while in keyboard mode", async () => {
    const d = new Driver(); await d.run(d.send({ type: "keyboardLift" }));
    expect(d.send({ type: "pointerMove", p: { x: 30, y: 30 } })).toEqual([]);
    expect(d.state.hovered?.id).toBe("meera");
  });
});

describe("guarantees", () => {
  it("never mutates the lifted object, through every outcome", async () => {
    const d = new Driver(); const before = serialize(d.sc.candidates[0]!.object);
    d.lift("meera"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y); d.up(c.x, c.y);
    await d.run(d.down(c.x, c.y));
    await d.run(d.send({ type: "undoRequest" }));
    expect(serialize(d.sc.candidates[0]!.object)).toBe(before);
  });
  it("a toast from an earlier placement survives starting a new lift, and Undo still works", async () => {
    const d = new Driver(); d.lift("toit"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y);
    await d.run(d.up(c.x, c.y));
    d.hit(d.send({ type: "liftKey", down: true }));
    expect(d.state.toast?.kind).toBe("placed");
    await d.run(d.send({ type: "undoRequest" }));
    expect(d.bridges["google-calendar.event-editor"]!.state).toEqual([]);
  });
  it("is deterministic: the same events give the same states and effects", async () => {
    const play = async () => {
      const d = new Driver(); d.lift("meera"); d.move(450, 120); const c = chipAt(R.calendar); d.move(c.x, c.y); d.up(c.x, c.y); await d.run(d.down(c.x, c.y));
      return JSON.stringify({ s: d.state, e: d.log });
    };
    expect(await play()).toBe(await play());
  });
  it("token follows the pointer until it snaps to a chip", () => {
    const d = new Driver(); d.lift("meera"); d.move(450, 250);
    expect(selectView(d.state).token).toMatchObject({ at: { x: 450, y: 250 }, snapped: false, glyph: "P", title: "Meera Iyer" });
    const c = chipAt(R.calendar); d.move(c.x, c.y);
    expect(selectView(d.state).token).toMatchObject({ at: c, snapped: true });
  });
});
