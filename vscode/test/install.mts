/**
 * The packaged extension in a normally started VS Code (not the extension test host), against a real Relay server:
 * - the .vsix contains what it needs and nothing it shouldn't;
 * - it installs into a clean profile, and a newer version installs over an older one;
 * - an "Open in VS Code" link shows the real confirmation dialog: Escape declines (no join), Enter joins, and the
 *   server records which client joined ("vscode/<version>", which must equal the package's version);
 * - after VS Code restarts, the session is restored and opened files are shared again.
 * Keys are real X keystrokes (test/keys.py); screenshots go to the evidence folder.
 * Usage: npm run test:install (packages first). Re-runs itself under xvfb-run without a display.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { testServer } from "../../test/collab-helpers.ts";

if (!process.env.DISPLAY && process.platform === "linux" && !process.env.RELAY_NO_XVFB) {
  const r = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1280x1024x24", process.execPath, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, RELAY_NO_XVFB: "1" } });
  process.exit(r.status ?? 1);
}

const root = resolve(import.meta.dirname, "..");
const SHOTS = resolve(root, "../docs/evidence/vscode-extension-2026-10-22");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const vsix = join(root, `relay-vscode-${version}.vsix`);
const older = readdirSync(root).filter((f) => /^relay-vscode-.*\.vsix$/.test(f) && f !== `relay-vscode-${version}.vsix`).sort().at(-1);
const results: string[] = [];
const ok = (what: string) => (results.push(`ok - ${what}`), console.log(`ok - ${what}`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keys = (...a: string[]) => {
  const r = spawnSync("python3", [join(root, "test", "keys.py"), ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`keys.py: ${r.stderr}`);
};
const shot = (name: string) => (mkdirSync(SHOTS, { recursive: true }), spawnSync("import", ["-window", "root", join(SHOTS, name)]));
async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// 1. The package.
assert.ok(existsSync(vsix), `${vsix} is missing: run npm run package first`);
const listing = execFileSync("unzip", ["-l", vsix], { encoding: "utf8" });
for (const need of ["extension/package.json", "extension/dist/extension.js", "extension/media/relay.svg", "extension/readme.md"]) assert.ok(listing.toLowerCase().includes(need.toLowerCase()), `the package contains ${need}`);
for (const never of ["extension/src/", "extension/test/", "extension/node_modules/", ".map", "extension/dist-test/"]) assert.ok(!listing.includes(never), `the package leaves out ${never}`);
const manifest = JSON.parse(execFileSync("unzip", ["-p", vsix, "extension/package.json"], { encoding: "utf8" })) as { version: string; engines: { vscode: string } };
assert.equal(manifest.version, version);
ok(`the .vsix (${Math.round(readFileSync(vsix).length / 1024)} KB) has the runtime files, no sources/tests/maps/node_modules, version ${version}, engines ${manifest.engines.vscode}`);

// 2. Clean profile install, and an upgrade over an older version.
const exe = await downloadAndUnzipVSCode("stable");
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
const profile = mkdtempSync(join(tmpdir(), "relay-vscode-profile-"));
const dirs = ["--user-data-dir", join(profile, "user"), "--extensions-dir", join(profile, "extensions")];
const code = (...a: string[]) => execFileSync(cli!, [...cliArgs, ...dirs, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const installed = () => code("--list-extensions", "--show-versions").split("\n").find((l) => l.startsWith("relay.relay-vscode@"));
assert.equal(installed(), undefined, "the profile starts clean");
if (older) {
  code("--install-extension", join(root, older));
  const v = installed();
  assert.ok(v && !v.endsWith(`@${version}`), `older version installed first (${v})`);
  code("--install-extension", vsix, "--force");
  assert.equal(installed(), `relay.relay-vscode@${version}`);
  ok(`upgrade: ${older} then ${version} installed over it in a clean profile`);
} else {
  code("--install-extension", vsix);
  assert.equal(installed(), `relay.relay-vscode@${version}`);
  ok(`clean profile install of ${version} (no older package here to test an upgrade)`);
}

// 3. A real Relay server and a checkout; VS Code started normally.
const { server, repo } = await testServer({ "src/app.js": "export const app = 1;\n", "README.md": "# demo\n" }, { flushMs: 30 });
const checkout = join(mkdtempSync(join(tmpdir(), "relay-install-checkout-")), "demo");
execFileSync("git", ["clone", "-q", repo, checkout]);
const { token, member } = server.members.invite("Ada in VS Code", "editor");
const link = `vscode://relay.relay-vscode/join?invite=${encodeURIComponent(`${server.url}/join#${token}`)}`;
/** Hand a vscode:// link to the running VS Code, as the OS does when you click it (a second instance forwards it). */
const openUrl = (url: string) => {
  const p = spawn(exe, [...dirs, "--no-sandbox", "--disable-gpu", "--open-url", url], { stdio: "ignore", detached: true });
  setTimeout(() => {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {}
  }, 15_000).unref();
};
const joined = () => server.relay.events().find((e) => e.type === "member.joined" && (e.data as { member?: string }).member === member.id);
let vsc = spawn(exe, [...dirs, "--no-sandbox", "--disable-gpu", "--password-store=basic", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", checkout], { stdio: "ignore", detached: true });
try {
  keys("wait-window:code", "wait:6000");

  // 4. The join link. Two dialogs: VS Code's own "Allow 'Relay' extension to open this URI?", then Relay's "Join the
  // Relay project at …?". The pointer stays in a corner so no tooltip shows the link (it carries the invite).
  keys("move:5,1015");
  // A. Cancel VS Code's prompt: the link never reaches Relay.
  openUrl(link);
  keys("wait:3000");
  shot("06-vscode-asks-to-open-the-link.png");
  keys("Escape", "wait:1500");
  assert.equal(joined(), undefined);
  ok("A: VS Code's own prompt for the link, cancelled with Escape: not joined");
  // B. Allow it in VS Code; Relay then asks (a native dialog, light, at the top of the screen); Cancel declines.
  // Pixels prove the dialog is there before the click and gone after it.
  openUrl(link);
  keys("wait:3000", "Return", "wait:2000", "expect-light:178,112");
  shot("07-relay-asks-before-joining.png");
  keys("click:178,112", "wait:1500", "move:5,1015", "expect-dark:178,112");
  assert.equal(joined(), undefined, "declined in Relay's dialog: the server saw no join");
  ok("B: Relay's own confirmation appeared after VS Code's; Cancel closed it and nothing was joined");
  // C. Allow it in VS Code, then Join in Relay's dialog: joined, and the server knows which extension version joined.
  openUrl(link);
  keys("wait:3000", "Return", "wait:2000", "expect-light:533,112", "click:533,112", "wait:500", "move:5,1015");
  await until(() => !!joined(), 20_000, "the join after confirming both dialogs");
  assert.equal((joined()!.data as { client?: string }).client, `vscode/${version}`, "the running extension reports the packaged version");
  keys("wait:2000");
  shot("08-real-vscode-joined.png");
  keys("expect-dark:533,112");
  ok(`C: VS Code's prompt allowed, Relay's Join clicked: joined, and the server recorded client vscode/${version}`);

  // 5. Restart VS Code: the session comes back from VS Code's secret storage, and an opened project file is shared.
  process.kill(-vsc.pid!, "SIGTERM");
  // Wait for every process of that VS Code (same profile) to be gone before starting it again.
  const running = () => spawnSync("pgrep", ["-f", profile]).status === 0;
  await until(() => !running(), 20_000, "VS Code to exit").catch(() => spawnSync("pkill", ["-9", "-f", profile]));
  await until(() => !running(), 10_000, "VS Code to be gone");
  vsc = spawn(exe, [...dirs, "--no-sandbox", "--disable-gpu", "--password-store=basic", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", checkout], { stdio: "ignore", detached: true });
  keys("wait-window:code", "wait:6000");
  // Open a project file in the running window (a second instance forwards it, as the OS does).
  const opener = spawn(exe, [...dirs, "--no-sandbox", "--disable-gpu", "--reuse-window", join(checkout, "src/app.js")], { stdio: "ignore", detached: true });
  setTimeout(() => {
    try {
      process.kill(-opener.pid!, "SIGTERM");
    } catch {}
  }, 15_000).unref();
  keys("wait:4000");
  shot("09-real-vscode-after-restart.png");
  await until(() => server.collab.presence().some((p) => p.path === "src/app.js" && p.members.includes(member.id)), 30_000, "the restarted VS Code to share src/app.js");
  ok("after restarting VS Code the session was restored and the opened file is shared again");
} finally {
  try {
    process.kill(-vsc.pid!, "SIGTERM");
  } catch {}
  await server.close();
}
console.log(`# pass ${results.length}`);
process.exit(0);
