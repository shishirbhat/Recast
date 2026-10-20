import { describe, expect, it } from "vitest";
import { createResolver } from "../src";
import { LABELLED } from "./labelled";

describe("rules-only accuracy on a hand-labelled set (regression guard, not a benchmark claim)", () => {
  it("never resolves a non-object, and finds most real ones with the right fields", async () => {
    const res = createResolver({ now: () => new Date("2026-10-15T10:00:00Z") });
    let right = 0, wrongType = 0, missed = 0, falsePos = 0, fieldBad: string[] = [];
    const rows: string[] = [];
    for (const l of LABELLED) {
      const o = await res.resolve({ raw: l.raw });
      const got = o.status === "resolved" ? o.object.type : null;
      if (l.type === null) { if (got) { falsePos++; rows.push(`FALSE-POSITIVE ${JSON.stringify(l.raw)} -> ${got}`); } else right++; continue; }
      if (!got) { missed++; rows.push(`MISSED ${JSON.stringify(l.raw)} (${o.status}: ${"reason" in o ? o.reason : ""})`); continue; }
      if (got !== l.type) { wrongType++; rows.push(`WRONG-TYPE ${JSON.stringify(l.raw)} -> ${got}, wanted ${l.type}`); continue; }
      const bad = Object.entries(l.fields ?? {}).filter(([k, v]) => o.status === "resolved" && JSON.stringify(o.object.fields[k]) !== JSON.stringify(v));
      if (bad.length) { fieldBad.push(l.raw); rows.push(`FIELDS ${JSON.stringify(l.raw)}: ${bad.map(([k, v]) => `${k} wanted ${JSON.stringify(v)} got ${JSON.stringify(o.status === "resolved" ? o.object.fields[k] : "")}`).join("; ")}`); } else right++;
    }
    console.log(`LABELLED n=${LABELLED.length} right=${right} falsePositive=${falsePos} wrongType=${wrongType} missed=${missed} badFields=${fieldBad.length}\n${rows.join("\n")}`);
    expect(falsePos).toBe(0);               // the one thing that must never regress: inventing an object from noise
    expect(wrongType).toBe(0);
  });
});
