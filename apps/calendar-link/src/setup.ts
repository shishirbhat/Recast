// One-time setup: asks for the Google Client ID and Client secret in this terminal and writes apps/calendar-link/.env
// (git-ignored, readable only by you). The secret is not shown while you paste it, and is never printed.
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const envFile = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".env");

// One reader for the whole run (a reader per question would drop lines already typed or pasted ahead).
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let hiding = false;
const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (!hiding) write(s); };
// Lines can arrive before the question is asked (a paste of both values at once): keep them in order.
const lines: string[] = []; const waiting: ((l: string) => void)[] = [];
rl.on("line", (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
function ask(question: string, hidden = false): Promise<string> {
  process.stdout.write(question); hiding = hidden;
  const done = (a: string) => { if (hidden) process.stdout.write("\n"); hiding = false; return a.trim().replace(/^["']|["']$/g, ""); };
  const ready = lines.shift();
  return ready !== undefined ? Promise.resolve(done(ready)) : new Promise((resolve) => waiting.push((l) => resolve(done(l))));
}

if (existsSync(envFile) && (await ask(`A settings file already exists (${envFile}). Replace it? (y/N) `)).toLowerCase() !== "y") { console.log("Left it as it was."); rl.close(); process.exit(0); }
let id = "";
while (!id.endsWith(".apps.googleusercontent.com")) {
  id = await ask("Paste your Google Client ID (it ends with .apps.googleusercontent.com), then press Enter: ");
  if (!id.endsWith(".apps.googleusercontent.com")) console.log("That doesn't look like a Client ID. Copy it again from Google Cloud > Credentials.");
}
let secret = "";
while (secret.length < 10) {
  secret = await ask("Paste your Google Client secret, then press Enter (it stays hidden): ", true);
  if (secret.length < 10) console.log("That looks too short. Copy the Client secret again.");
}
writeFileSync(envFile, `GOOGLE_CLIENT_ID=${id}\nGOOGLE_CLIENT_SECRET=${secret}\nPORT=8787\n`, { mode: 0o600 }); chmodSync(envFile, 0o600);
rl.close();
console.log(`Saved. Now start the sign-in page with:\n  pnpm --filter @recast/calendar-link run start`);
