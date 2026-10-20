/**
 * One-click ship from the browser: Source Control → "Ship to main" against a MOCK GitHub API and a real bare remote.
 * Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import { TOKEN, mockGitHub } from "../github-mock.ts";
import { git, makeRepo } from "../helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { SHOP_FILES } from "./fixture.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);

let server: RelayServer;
let browser: Browser;
let repo: string;
let bare: string;
let mock: ReturnType<typeof mockGitHub>;

before(async () => {
  if (skip) return;
  repo = makeRepo(SHOP_FILES);
  bare = join(mkdtempSync(join(tmpdir(), "relay-remote-")), "shop.git");
  git(repo, "init", "-q", "--bare", "-b", "main", bare);
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "origin", "main");
  mock = mockGitHub(bare);
  await new Promise<void>((ok) => mock.server.listen(0, "127.0.0.1", ok));
  const api = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  server = (await testServer({}, { root: repo, staticDir: STATIC, github: { token: TOKEN, api, repo: "acme/shop" } })).server;
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
  await new Promise<void>((ok) => mock.server.close(() => ok()));
});

async function signIn(role: "owner" | "editor") {
  const { token } = server.members.invite(`${role} person`, role);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("empty-editor").waitFor();
  return page;
}

test("owner ships and merges in one click; editors see why they can't", { skip }, async () => {
  writeFileSync(join(repo, "README.md"), "# shop\n\nShipped from the browser.\n");
  const ed = await signIn("editor");
  await ed.getByTestId("activity-scm").click();
  const edBtn = ed.getByTestId("github-ship-merge");
  await edBtn.waitFor();
  assert.equal(await edBtn.isDisabled(), true);
  assert.equal(await edBtn.getAttribute("title"), "Only project owners can ship");

  const p = await signIn("owner");
  await p.getByTestId("activity-scm").click();
  const ship = p.getByTestId("github-ship-merge");
  await ship.waitFor();
  assert.match(await ship.innerText(), /Ship to main/);
  await ship.click();
  await p.getByText(/Merged #1 into main/).first().waitFor({ timeout: 20000 });
  assert.equal(git(bare, "show", "main:README.md"), "# shop\n\nShipped from the browser.");
  // Afterwards the gate says there's nothing to ship.
  await p.getByTestId("github-ship-merge").waitFor();
  await p.waitForFunction(() => (document.querySelector("[data-testid=github-ship-merge]") as HTMLButtonElement | null)?.disabled === true);
});
