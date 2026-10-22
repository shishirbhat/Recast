/**
 * Collaboration reliability in real browsers against the real server: honest sync status on a dead connection,
 * convergence under overlapping edits, late joiners, reloads, typing before the first sync, presence after an
 * abrupt disconnect, and a server restart with editors open. Skipped unless RELAY_E2E=1.
 */
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { testServer, until } from "../collab-helpers.ts";
import { startServer } from "../../src/server/server.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { partitionable } from "./net.ts";
import type { Partition } from "./net.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = !RUN || !existsSync(STATIC);
const FILES: Record<string, string> = {
  "src/status.js": "// status\n",
  "src/overlap.js": "const value = 1;\n",
  "src/late.js": "// late\n",
  "src/reload.js": "// reload\n",
  "src/early.js": "// early\n",
  "src/multi-a.js": "// a\n",
  "src/multi-b.js": "// b\n",
  "src/presence.js": "// presence\n",
  "src/gutter.js": "// gutter\n",
};
let server: RelayServer;
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  if (skip) return;
  ({ server } = await testServer(FILES, { staticDir: STATIC }));
  browser = await chromium.launch({ executablePath: CHROME });
});
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

async function signIn(name: string, net?: (p: Page) => Promise<void>): Promise<{ p: Page; id: string; ctx: BrowserContext }> {
  const { token, member } = server.members.invite(`${name} ${Math.random().toString(36).slice(2, 6)}`, "owner");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(ctx);
  const p = await ctx.newPage();
  if (net) await net(p);
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("welcome").waitFor();
  return { p, id: member.id, ctx };
}
async function open(p: Page, path: string) {
  await p.getByTestId(`file-${path}`).click();
  await p.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0);
}
async function caretAtEnd(p: Page, line = 0) {
  await p.locator(".cm-line").nth(line).click();
  await p.keyboard.press("End");
}
const shared = (path: string) => server.docs.open(path).text.toString();
/** The editor's text as the person sees it, without collaborators' caret name flags. */
const editorText = (p: Page) =>
  p.evaluate(() => {
    const c = document.querySelector(".cm-content")!.cloneNode(true) as HTMLElement;
    c.querySelectorAll(".cm-ySelectionCaret, .cm-ySelectionInfo, .cm-widgetBuffer").forEach((e) => e.remove());
    return [...c.querySelectorAll(".cm-line")].map((l) => (l.textContent ?? "").replace(/\u2060/g, "")).join("\n");
  });
async function showsText(p: Page, want: string, what: string) {
  const end = Date.now() + 5000;
  let got = "";
  while (Date.now() < end) {
    got = await editorText(p);
    if (got === want) return;
    await p.waitForTimeout(50);
  }
  assert.equal(got, want, what);
}
const status = (p: Page) => p.getByTestId("sync-status").innerText();

test("a dead connection never shows Synced: unconfirmed edits say so, and are saved once it recovers", { skip }, async () => {
  let net!: Partition;
  const { p } = await signIn("Ada", async (pg) => void (net = await partitionable(pg)));
  await open(p, "src/status.js");
  await caretAtEnd(p);
  await p.keyboard.type(" first");
  await until(() => shared("src/status.js").includes("first"), 5000, "the first edit to reach the server");
  await p.waitForFunction(() => document.querySelector("[data-testid=sync-status]")?.textContent === "Synced");

  // The socket stays open but nothing gets through, as on a dropped Wi-Fi link: the browser isn't told.
  net.cut();
  await p.keyboard.type(" second");
  await p.waitForFunction(() => document.querySelector("[data-testid=sync-status]")?.textContent === "Not saved yet", null, { timeout: 6000 });
  assert.ok(!shared("src/status.js").includes("second"), "the server really doesn't have it");

  await net.heal();
  await until(() => shared("src/status.js").includes("first second"), 8000, "the unconfirmed edit to arrive after the connection recovers");
  await p.waitForFunction(() => document.querySelector("[data-testid=sync-status]")?.textContent === "Synced", null, { timeout: 6000 });
});

test("overlapping edits on the same line from two people converge to the same text everywhere", { skip }, async () => {
  const { p: a } = await signIn("Ada");
  const { p: b } = await signIn("Bo");
  await open(a, "src/overlap.js");
  await open(b, "src/overlap.js");
  await caretAtEnd(a);
  await caretAtEnd(b);
  // Both type at the same place at the same time.
  await Promise.all([a.keyboard.type(" // ada ada ada", { delay: 15 }), b.keyboard.type(" // bo bo bo", { delay: 15 })]);
  await until(() => shared("src/overlap.js").includes("ada ada ada") && shared("src/overlap.js").includes("bo bo bo"), 8000, "both people's text on the server");
  const want = shared("src/overlap.js");
  await showsText(a, shared("src/overlap.js"), "Ada's editor matches the server");
  await showsText(b, shared("src/overlap.js"), "Bo's editor matches the server");
  // Each person's characters stay in their own order (no interleaving inside one person's run).
  assert.match(want, /ada ada ada/);
  assert.match(want, /bo bo bo/);
});

test("someone who opens the file later sees everything typed so far, including unsaved-to-disk text", { skip }, async () => {
  const { p: a } = await signIn("Ada");
  await open(a, "src/late.js");
  await caretAtEnd(a);
  await a.keyboard.type(" typed before Bo arrived");
  await until(() => shared("src/late.js").includes("before Bo arrived"), 5000, "Ada's edit on the server");
  const { p: b } = await signIn("Bo");
  await open(b, "src/late.js");
  await b.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("before Bo arrived"), null, { timeout: 5000 });
  assert.equal((await editorText(b)).match(/before Bo arrived/g)?.length, 1, "the text appears once, not duplicated by the join");
});

test("reloading while a collaborator types loses nothing and duplicates nothing", { skip }, async () => {
  const { p: a } = await signIn("Ada");
  const { p: b } = await signIn("Bo");
  await open(a, "src/reload.js");
  await open(b, "src/reload.js");
  await caretAtEnd(b);
  const typing = b.keyboard.type(" 0123456789abcdefghij", { delay: 40 });
  await a.waitForTimeout(150);
  await a.reload();
  await a.getByTestId("welcome").waitFor();
  await open(a, "src/reload.js");
  await typing;
  await until(() => shared("src/reload.js").includes("0123456789abcdefghij"), 8000, "all of Bo's keys on the server");
  await showsText(a, shared("src/reload.js"), "the reloaded editor matches the server");
  assert.equal(shared("src/reload.js").match(/0123456789abcdefghij/g)?.length, 1);
});

test("keys typed the moment a file opens, before its first sync, are kept once", { skip }, async () => {
  const { p } = await signIn("Ada");
  // Quick Open moves focus into the editor (an Explorer single click keeps focus in the Explorer, as in VS Code).
  await p.keyboard.press("Control+P");
  await p.keyboard.type("early.js");
  await p.getByRole("option", { name: /early\.js/ }).first().waitFor();
  await p.keyboard.press("Enter");
  // No wait for the content: type straight away.
  await p.keyboard.type("XYZ");
  await until(() => shared("src/early.js").includes("XYZ"), 5000, "the early keys on the server");
  await p.waitForFunction(() => document.querySelector("[data-testid=sync-status]")?.textContent === "Synced", null, { timeout: 5000 });
  assert.equal(shared("src/early.js").match(/XYZ/g)?.length, 1);
  assert.ok(shared("src/early.js").includes("// early"), "the file's own content is still there");
});

test("edits in two files at once each go to their own file", { skip }, async () => {
  const { p } = await signIn("Ada");
  await open(p, "src/multi-a.js");
  await caretAtEnd(p);
  await p.keyboard.type(" in-a");
  await open(p, "src/multi-b.js");
  await caretAtEnd(p);
  await p.keyboard.type(" in-b");
  await until(() => shared("src/multi-a.js").includes("in-a") && shared("src/multi-b.js").includes("in-b"), 5000, "each edit in its file");
  assert.ok(!shared("src/multi-a.js").includes("in-b") && !shared("src/multi-b.js").includes("in-a"));
});

test("line authorship in the gutter: a slow, older answer never overwrites a newer one", { skip }, async () => {
  const { p } = await signIn("Ada");
  let delayNext = false;
  let slowDelivered = false;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await p.route(/\/api\/attribution\?/, async (route) => {
    if (slowDelivered) {
      // Later refreshes wait, so what the page shows now is exactly what the slow answer left it with.
      await held;
      return route.abort().catch(() => {});
    }
    // Capture the server's answer now, deliver it late: exactly what a slow response to an earlier request looks like.
    const slow = delayNext;
    delayNext = false;
    const res = await route.fetch();
    if (slow) await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response: res });
    if (slow) slowDelivered = true;
  });
  try {
    await open(p, "src/gutter.js");
    await caretAtEnd(p);
    delayNext = true;
    await p.keyboard.type("\nconst one = 1;");
    // Wait until the (delayed) request for the first edit has been sent, then edit again.
    await until(() => !delayNext, 5000, "the first authorship request");
    await p.keyboard.type("\nconst two = 2;");
    await until(() => shared("src/gutter.js").includes("two = 2"), 5000, "both edits on the server");
    await until(() => slowDelivered, 6000, "the slow answer to arrive after the fresh one");
    await p.waitForTimeout(300);
    const marks = await p.locator(".relay-author-gutter .relay-author").evaluateAll((els) => els.map((e) => (e as HTMLElement).title));
    assert.equal(marks.length, 2, `both new lines are still marked as Ada's (got ${JSON.stringify(marks)})`);
  } finally {
    release();
  }
});

test("presence: someone whose browser disappears without saying goodbye drops out of everyone's avatars", { skip }, async () => {
  const { p: a } = await signIn("Ada");
  const { id: boId, ctx: boCtx, p: b } = await signIn("Bo");
  await open(a, "src/presence.js");
  await open(b, "src/presence.js");
  await a.getByTestId(`presence-${boId}`).waitFor();
  // Close the whole browser context: sockets go with it, no app code runs.
  await boCtx.close();
  await a.getByTestId(`presence-${boId}`).waitFor({ state: "detached", timeout: 8000 });
  await a.waitForFunction(() => !document.querySelector(".cm-ySelectionInfo"), null, { timeout: 8000 });
});

test("a server restart with editors open: they reconnect, nothing typed is lost, and the server keeps one copy", { skip }, async () => {
  const files = { "src/restart.js": "// restart\n" };
  const first = await testServer(files, { staticDir: STATIC });
  const port = Number(new URL(first.server.url).port);
  let srv = first.server;
  const { token } = srv.members.invite("Ada restart", "owner");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(ctx);
  const p = await ctx.newPage();
  try {
    await p.goto(`${srv.url}/join#${token}`);
    await p.waitForURL(`${srv.url}/`);
    await open(p, "src/restart.js");
    await caretAtEnd(p);
    await p.keyboard.type(" before");
    await until(() => srv.docs.open("src/restart.js").text.toString().includes("before"), 5000, "the edit before the restart");

    await srv.close();
    // Typed while the server is down: kept in the browser, flagged, and sent once it's back.
    await p.keyboard.type(" during");
    await p.waitForFunction(() => /Offline|Connecting|pending/.test(document.querySelector("[data-testid=sync-status]")?.textContent ?? ""), null, { timeout: 8000 });
    srv = await startServer({ root: first.repo, dbPath: first.dbPath, port, flushMs: 30, staticDir: STATIC });
    await until(() => srv.docs.open("src/restart.js").text.toString().includes("before during"), 15000, "the offline edit after the restart");
    await p.waitForFunction(() => document.querySelector("[data-testid=sync-status]")?.textContent === "Synced", null, { timeout: 10000 });
    const text = srv.docs.open("src/restart.js").text.toString();
    assert.equal(text.match(/before/g)?.length, 1, `no duplicated text after reconnect: ${JSON.stringify(text)}`);
    srv.docs.flushAll();
    assert.equal(readFileSync(join(first.repo, "src/restart.js"), "utf8"), text);
  } finally {
    await srv.close().catch(() => {});
  }
});
