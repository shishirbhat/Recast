// The spots Recast highlights on a screen, from the words OCR read off it: only what a person is likely to pick up.
import { describe, expect, it } from "vitest";
import { findSpots, type Line } from "../src/spots";

const ctx = { now: "2026-10-23T10:00:00Z", timezone: "UTC" };
/** A line of words laid out left to right, 10 px per letter, as OCR returns them. */
function line(text: string, y = 100): Line {
  let x = 20; return { words: text.split(" ").map((t) => { const w = { text: t, x0: x, y0: y, x1: x + t.length * 10, y1: y + 20 }; x += t.length * 10 + 8; return w; }) };
}

describe("spots on a screen", () => {
  it("a time inside a sentence is just the time, boxed around those words", () => {
    const [s] = findSpots([line("Lunch with Arjun on Friday 1:00 PM, if that works.")], ctx);
    expect(s).toMatchObject({ kind: "time", text: "Friday 1:00 PM" });
    expect(s!.x).toBeGreaterThan(200);    // not from the start of the line
  });
  it("an email address is a person; a web address is a link", () => {
    const spots = findSpots([line("Write to arjun.mehta@example.com or see https://example.com/plan.")], ctx);
    expect(spots.map((s) => [s.kind, s.text])).toEqual([["person", "arjun.mehta@example.com"], ["link", "https://example.com/plan"]]);
  });
  it("an error is the whole line", () => {
    expect(findSpots([line("TypeError: Cannot read properties of undefined (reading 'id')")], ctx)).toEqual([expect.objectContaining({ kind: "error", text: "TypeError: Cannot read properties of undefined (reading 'id')" })]);
  });
  it("plain numbers, lone weekdays and ordinary prose are not spots", () => {
    expect(findSpots([line("We sold 42 units in 2025 and Friday was busy"), line("The quick brown fox jumps over the lazy dog")], ctx)).toEqual([]);
  });
  it("a phone number and a file with its line are spots; an order number is not", () => {
    const spots = findSpots([line("Call Maya on +91 98450 12345 tonight"), line("Fails at src/app/checkout.ts:42 again"), line("Order 1234567890 shipped")], ctx);
    expect(spots.map((s) => [s.kind, s.text])).toEqual([["phone", "+91 98450 12345"], ["time", "tonight"], ["code", "src/app/checkout.ts:42"]]);
  });
  it("relative days and dates count", () => {
    const spots = findSpots([line("Standup tomorrow at 9:30 am"), line("Due 2026-11-03")], ctx);
    expect(spots.map((s) => s.text)).toEqual(["tomorrow at 9:30 am", "2026-11-03"]);
  });
});
