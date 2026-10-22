/**
 * Inviting someone in a real browser: one invite, two ways in (browser or VS Code), the extension download served by
 * Relay when it has been packaged, and the invite working once. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = !RUN || !existsSync(STATIC);
const packaged = (() => {
  try {
    return readdirSync(resolve(import.meta.dirname, "../../vscode")).some((f) => /^relay-vscode-.*\.vsix$/.test(f));
  } catch {
    return false;
  }
})();
let server: RelayServer;
let browser: Browser;

before(async () => {
  if (skip) return;
  ({ server } = await testServer({ "src/app.js": "export const a = 1;\n" }, { staticDir: STATIC }));
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

test("invite: one link for the browser, one for VS Code; the invite works once", { skip }, async () => {
  const { token } = server.members.invite("Olu", "owner");
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] })).newPage();
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("welcome").waitFor();

  await p.getByRole("button", { name: "Share" }).click();
  await p.getByTestId("invite-dialog").waitFor();
  await p.getByTestId("invite-name").fill("Kai");
  await p.getByLabel(/Viewer/).check();
  await p.getByRole("button", { name: "Create invite" }).click();
  const browserLink = await p.getByTestId("invite-browser").inputValue();
  const vscodeLink = await p.getByTestId("invite-vscode").inputValue();
  assert.match(browserLink, new RegExp(`^${server.url}/join#.+`));
  assert.equal(vscodeLink, `vscode://relay.relay-vscode/join?invite=${encodeURIComponent(browserLink)}`, "the VS Code link carries the same invite");
  assert.ok(server.members.list().some((m) => m.name === "Kai" && m.role === "viewer"));

  if (packaged) {
    const href = await p.getByTestId("invite-vsix").getAttribute("href");
    const res = await fetch(`${server.url}${href}`);
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 1000, "a real extension package");
  } else {
    assert.match(await p.getByTestId("invite-vsix-missing").innerText(), /hasn't been packaged/);
  }
  await p.getByRole("button", { name: "Copy Browser link" }).click();
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), browserLink);

  // Kai opens the browser link: signed in as a viewer. The same invite can't be used again (e.g. from VS Code).
  const k = await (await browser.newContext()).newPage();
  await k.goto(browserLink);
  await k.waitForURL(`${server.url}/`);
  await k.getByTestId("welcome").waitFor();
  const again = await fetch(`${server.url}/api/join`, { method: "POST", headers: { "content-type": "application/json", "x-relay": "1" }, body: JSON.stringify({ token: browserLink.split("#")[1] }) });
  assert.notEqual(again.status, 200, "an invite works once");
});
