/**
 * Runs the extension's tests inside a real VS Code (downloaded by @vscode/test-electron) against a real Relay server.
 * The developer's checkout is a separate clone of the project, as it would be on their machine.
 * Usage: npm test (builds first). Without a display, it re-runs itself under xvfb-run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
};
const { server, repo } = await testServer(FILES, { flushMs: 30 });
let code = 1;
try {
  // The developer's own checkout: a clone, with one file already edited locally (not yet shared).
  const checkout = join(mkdtempSync(join(tmpdir(), "relay-checkout-")), "demo");
  execFileSync("git", ["clone", "-q", repo, checkout]);
  const { token } = server.members.invite("Ada", "owner");
  const bo = await joinAs(server, "Bo", "editor");
  server.relay.createTask({ id: "T-docs", objective: "Explain the greeting in the README", scope: ["README.md"] }, HUMAN);
  code = await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "dist-test", "suite.js"),
    launchArgs: [checkout, "--disable-extensions", "--no-sandbox", "--disable-gpu", "--disable-workspace-trust", `--user-data-dir=${mkdtempSync(join(tmpdir(), "relay-vscode-user-"))}`],
    extensionTestsEnv: { RELAY_TEST_INVITE: `${server.url}/join#${token}`, RELAY_TEST_SERVER: server.url, RELAY_TEST_BO_COOKIE: bo.cookie, RELAY_TEST_BO_ID: bo.id, RELAY_TEST_CHECKOUT: checkout },
  }).catch((e: Error) => {
    console.error(e.message);
    return 1;
  });
} finally {
  await server.close();
}
process.exit(code);
