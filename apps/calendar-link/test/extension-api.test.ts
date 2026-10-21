// The extension door, without a browser: pairing, and Gmail drafts only when the person ticked Gmail.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExtensionApi } from "../src/extension-api.js";
import { GMAIL_SCOPE, SCOPE } from "../src/server.js";

const EXT = `chrome-extension://${"a".repeat(32)}`;
function setup(scope: string) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "recast-ext-api-")), ".secrets"); mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(dir, "google-token.json");
  writeFileSync(tokenFile, JSON.stringify({ access_token: "AT", expires_at: Date.now() + 3_600_000, scope, token_type: "Bearer", connected_at: "x" }));
  const calls: string[] = [];
  const api = createExtensionApi({ clientId: "c", clientSecret: "s", tokenFile, tokenUrl: "https://google.test/token", now: Date.now, stateFile: path.join(dir, "t.json"), dir,
    fetch: (async (u: string) => { calls.push(String(u)); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch });
  return { api, calls };
}
async function pair(api: ReturnType<typeof setup>["api"]) {
  const r = await api.handle("pair", EXT, {}); expect(r.status).toBe(202); expect(String(r.body.code)).toMatch(/^\d{4}$/);
  expect((await api.handle("status", EXT, {})).status).toBe(403);           // pending is not allowed
  api.decide(EXT, true);
}

describe("extension door", () => {
  it("status reports whether Gmail drafts were allowed", async () => {
    const a = setup(SCOPE); await pair(a.api);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ paired: true, connected: true, gmail: false });
    const b = setup(`${SCOPE} ${GMAIL_SCOPE}`); await pair(b.api);
    expect((await b.api.handle("status", EXT, {})).body).toMatchObject({ gmail: true });
  });
  it("Gmail is refused without the Gmail permission, before anything reaches Google", async () => {
    const a = setup(SCOPE); await pair(a.api);
    const r = await a.api.handle("commit", EXT, { destination: "gmail", op: {}, consent: { kind: "release" } });
    expect(r.status).toBe(409); expect(String(r.body.message)).toMatch(/Gmail drafts are not allowed/); expect(a.calls).toHaveLength(0);
  });
  it("Gmail cannot be asked about one draft: the check says so instead of guessing 'not there'", async () => {
    const b = setup(`${SCOPE} ${GMAIL_SCOPE}`); await pair(b.api);
    const r = await b.api.handle("reconcile", EXT, { destination: "gmail", op: {} });
    expect(r.body).toMatchObject({ checkable: false }); expect(r.body).not.toHaveProperty("found"); expect(b.calls).toHaveLength(0);
  });
  it("undo only works on a receipt this program issued", async () => {
    const b = setup(SCOPE); await pair(b.api);
    expect((await b.api.handle("undo", EXT, { receipt: { receiptId: "rc-forged" } })).body).toMatchObject({ outcome: "failed", message: "That placement is not one this computer made" });
  });
});
