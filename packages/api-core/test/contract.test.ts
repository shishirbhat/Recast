// The API contract: sound, served per account, matched by every response the tests produce (contract-guard.ts), and protected
// against breaking changes by the committed v1 snapshot.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createResolver } from "@recast/resolve";
import { MemoryKeyStore, OPENAPI, breakingChanges, createApi, surface } from "../src";
import { checkResponse } from "../src/contract";

const collectRefs = (v: unknown, out: string[] = []): string[] => { if (Array.isArray(v)) v.forEach((x) => collectRefs(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "$ref" && typeof x === "string") out.push(x); else collectRefs(x, out); } return out; };

describe("the contract document", () => {
  it("every reference resolves and every operation names itself", () => {
    for (const r of collectRefs(OPENAPI)) expect(Object.keys(OPENAPI.components.schemas), r).toContain(r.replace("#/components/schemas/", ""));
    const ids = Object.values(OPENAPI.paths).flatMap((ops) => Object.values(ops).map((op: any) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length); expect(ids.every(Boolean)).toBe(true);
  });
  it("every status code the server can return is declared by some operation", () => {
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const thrown = new Set([...src.matchAll(/HttpError\((\d{3}),/g)].map((m) => m[1]!)); thrown.add("500");
    const declared = new Set(Object.values(OPENAPI.paths).flatMap((ops) => Object.values(ops).flatMap((op: any) => Object.keys(op.responses))));
    expect([...thrown].filter((s) => !declared.has(s))).toEqual([]);
  });
});

describe("GET /v1/openapi.json", () => {
  it("shows each account only what it can use, and itself matches the contract", async () => {
    const keys = new MemoryKeyStore();
    await keys.add("sk_test_contract_pub1", { tenantId: "p", tier: "free" }); await keys.add("sk_test_contract_int1", { tenantId: "i", tier: "free", cohort: "internal" });
    const api = createApi({ resolver: createResolver(), keys });
    const get = async (k: string) => { const r = await api.handle(new Request("http://x/v1/openapi.json", { headers: { authorization: `Bearer ${k}` } })); const j = await r.json() as any; expect(checkResponse("GET", "/v1/openapi.json", r.status, j)).toEqual([]); return j; };
    expect(Object.keys((await get("sk_test_contract_pub1")).paths).sort()).toEqual(["/v1/capabilities", "/v1/health", "/v1/openapi.json"]);
    expect(Object.keys((await get("sk_test_contract_int1")).paths)).toEqual(expect.arrayContaining(["/v1/resolve", "/v1/place", "/v1/place/reconcile"]));
  });
});

describe("compatibility within v1", () => {
  const baseline = JSON.parse(readFileSync(new URL("../contract/v1.json", import.meta.url), "utf8"));
  it("the current contract has no breaking change against the committed v1 baseline", () => { expect(breakingChanges(baseline, surface())).toEqual([]); });
  it("additions pass; removals, narrowed answers and new required inputs are caught", () => {
    const now = surface(); const grown = structuredClone(now);
    grown.operations["GET /v1/new_thing"] = ["200"]; grown.schemas.Placement!.properties.push("new_field");
    expect(breakingChanges(now, grown)).toEqual([]);
    const broken = structuredClone(now);
    delete broken.operations["POST /v1/place/reconcile"];
    broken.operations["POST /v1/place"] = broken.operations["POST /v1/place"]!.filter((s) => s !== "202");
    broken.schemas.Placement!.properties = broken.schemas.Placement!.properties.filter((p) => p !== "risk");
    broken.schemas.Resolved!.required = broken.schemas.Resolved!.required.filter((p) => p !== "meta");
    broken.schemas.ResolveRequest!.required.push("target");
    broken.schemas.Health!.consts.status = "up";
    expect(breakingChanges(now, broken).sort()).toEqual([
      "POST /v1/place no longer answers 202", "POST /v1/place/reconcile was removed", "Health.status changed from \"ok\"",
      "Resolved.meta is no longer always present", "ResolveRequest.target became required", "Placement.risk was removed",
    ].sort());
  });
});
