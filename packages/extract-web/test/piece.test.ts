// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compose } from "@recast/core";
import { classifyPiece } from "../src/index.js";

const OPTS = { url: "https://chat.example.com/thread/1", now: "2026-10-19T09:00:00Z", timezone: "Asia/Kolkata" };
const page = (html: string) => { document.documentElement.innerHTML = `<body>${html}</body>`; };
const piece = (sel: string) => classifyPiece(document.querySelector(sel)!, OPTS);

describe("pieces read from the element under the pointer", () => {
  it("a time inside a chat message is a time piece; its evidence points at that element and keeps the text", () => {
    page(`<div class="msg"><p>Dinner? <span id="t">Sat 14 Nov, 2026 at 7:30 pm</span> works for me</p></div>`);
    const p = piece("#t")!;
    expect(p).toMatchObject({ kind: "time", text: "Sat 14 Nov, 2026 at 7:30 pm", source: { app: "chat.example.com", url: OPTS.url } });
    expect(p.evidence[0]).toMatchObject({ locator: { kind: "css" }, excerpt: "Sat 14 Nov, 2026 at 7:30 pm" });
    expect(document.querySelector(p.evidence[0]!.locator.value)?.id).toBe("t");
  });
  it("an address is a place piece with its structured value", () => {
    page(`<div class="card"><address id="a">298 100 Feet Road, Indiranagar, Bengaluru 560038</address></div>`);
    expect(piece("#a")).toMatchObject({ kind: "place", value: { address: "298 100 Feet Road, Indiranagar, Bengaluru 560038" } });
  });
  it("a heading with its address under it is a place: the heading is the name, the rest is the address", () => {
    page(`<section class="place"><h1 id="h">Dakshin</h1><address>12 MG Road, Bengaluru 560001</address></section>`);
    expect(piece("#h")).toMatchObject({ kind: "place", text: "Dakshin", value: { name: "Dakshin", address: "12 MG Road, Bengaluru 560001" } });
  });
  it("a short heading is a title piece; ordinary prose is nothing", () => {
    page(`<h2 id="h">Launch dinner</h2><p id="p">We should really catch up properly sometime soon, it has been ages.</p>`);
    expect(piece("#h")).toMatchObject({ kind: "title", text: "Launch dinner" });
    expect(piece("#p")).toBeNull();
  });
  it("pieces from different elements compose into a ready event that cites each element", () => {
    page(`<h2 id="h">Launch dinner</h2><span id="t">2026-11-14 19:30</span><address id="a">298 100 Feet Road, Indiranagar, Bengaluru 560038</address>`);
    const c = compose([piece("#t")!, piece("#a")!, piece("#h")!], OPTS);
    expect(c.status).toBe("ready");
    expect(c.candidate!.fields["location"]!.evidence[0]!.locator.value).toBe(piece("#a")!.evidence[0]!.locator.value);
  });
});
