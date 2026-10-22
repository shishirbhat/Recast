/**
 * Runs the extension's tests inside a real VS Code (downloaded by @vscode/test-electron) against a real Relay server.
 * The developer's checkout is a separate clone of the project, as it would be on their machine.
 * Usage: npm test (builds first). Without a display, it re-runs itself under xvfb-run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";
import { join as joinAs, testServer } from "../../test/collab-helpers.ts";
import { HUMAN } from "../../test/helpers.ts";

if (!process.env.DISPLAY && process.platform === "linux" && !process.env.RELAY_NO_XVFB) {
  const r = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, RELAY_NO_XVFB: "1" } });
  process.exit(r.status ?? 1);
}

const root = resolve(import.meta.dirname, "..");
const FILES = {
  "src/app.js": "export function greet(name) {\n  return 'Hello ' + name;\n}\n",
  "src/other.js": "export const other = 1;\n",
  "src/undo.js": "// undo\n",
  "src/presence.js": "const a = 1;\nconst b = 2;\n",
  "src/rename.js": "// rename me\n",
  "README.md": "# Demo\n",
  "src/interop.js": "// interop\nexport const shared = true;\n",
};
const STATIC = resolve(root, "../ide/web/out");
const SHOTS = resolve(root, "../docs/evidence/vscode-extension-2026-10-22");
const { server, repo } = await testServer(FILES, { flushMs: 30, ...(existsSync(STATIC) ? { staticDir: STATIC } : {}) });
const signals = mkdtempSync(join(tmpdir(), "relay-signals-"));
const waitFor = async (name: string, ms: number) => {
  const end = Date.now() + ms;
  while (!existsSync(join(signals, name))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${name}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * Bea, in the browser IDE (real Chromium), working in the same file as Ada in VS Code: each sees the other's text and
 * caret. Screenshots of both windows go to the evidence folder.
 */
async function browserBea(invite: string): Promise<void> {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 760 }, colorScheme: "dark" })).newPage();
    await p.goto(invite);
    await p.waitForURL(`${server.url}/`);
    await p.getByTestId("file-src/interop.js").click();
    await p.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0);
    // Ada (in VS Code) types first; her text and her caret flag show up here.
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("hello from VS Code"), null, { timeout: 120_000 });
    await p.waitForFunction(() => [...document.querySelectorAll(".cm-ySelectionInfo")].some((e) => e.textContent?.includes("Ada")), null, { timeout: 10_000 });
    await p.locator(".cm-line").nth(1).click();
    await p.keyboard.press("End");
    await p.keyboard.type(" // hello from the browser");
    await waitFor("vscode-shot-done", 60_000);
    mkdirSync(SHOTS, { recursive: true });
    await p.screenshot({ path: join(SHOTS, "02-browser-sees-vscode.png") });
  } finally {
    await browser.close();
  }
}
let code = 1;
try {
  // The developer's own checkout: a clone, with one file already edited locally (not yet shared).
  const checkout = join(mkdtempSync(join(tmpdir(), "relay-checkout-")), "demo");
  execFileSync("git", ["clone", "-q", repo, checkout]);
  const { token } = server.members.invite("Ada", "owner");
  const bo = await joinAs(server, "Bo", "editor");
  const bea = server.members.invite("Bea", "editor");
  const beaDone = existsSync(STATIC) ? browserBea(`${server.url}/join#${bea.token}`) : Promise.reject(new Error("build the browser IDE first (ide/web: npm run build)"));
  beaDone.catch(() => {});
  // Screenshot VS Code (the whole Xvfb screen) when the suite asks.
  const shooter = (async () => {
    await waitFor("vscode-shot", 300_000);
    mkdirSync(SHOTS, { recursive: true });
    execFileSync("import", ["-window", "root", join(SHOTS, "01-vscode-sees-browser.png")]);
    writeFileSync(join(signals, "vscode-shot-done"), "");
  })();
  shooter.catch(() => {});
  server.relay.createTask({ id: "T-docs", objective: "Explain the greeting in the README", scope: ["README.md"] }, HUMAN);
  code = await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "dist-test", "suite.js"),
    launchArgs: [checkout, "--disable-extensions", "--no-sandbox", "--disable-gpu", "--disable-workspace-trust", `--user-data-dir=${mkdtempSync(join(tmpdir(), "relay-vscode-user-"))}`],
    extensionTestsEnv: { RELAY_TEST_INVITE: `${server.url}/join#${token}`, RELAY_TEST_SERVER: server.url, RELAY_TEST_BO_COOKIE: bo.cookie, RELAY_TEST_BO_ID: bo.id, RELAY_TEST_CHECKOUT: checkout, RELAY_TEST_SIGNALS: signals },
  }).catch((e: Error) => {
    console.error(e.message);
    return 1;
  });
  // The browser half of the interop test must have passed too.
  try {
    await Promise.all([beaDone, shooter]);
    console.log("ok - browser side: Bea saw Ada's text and caret from VS Code, and typed back");
  } catch (e) {
    console.log(`not ok - browser side: ${(e as Error).message}`);
    code = 1;
  }
} finally {
  await server.close();
}
process.exit(code);
