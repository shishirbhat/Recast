/**
 * Collaboration latency, measured against the real Relay server with real y-websocket clients (and a real browser for
 * keystroke-to-paint). Loopback only: this measures Relay's own overhead, not network distance.
 *
 *   node bench/latency.ts [--out docs/evidence/latency.json] [--no-browser]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import WS from "ws";
import { chromium } from "playwright-core";
import { client, join as joinAs, testServer, until } from "../test/collab-helpers.ts";
import type { Client } from "../test/collab-helpers.ts";
import { HUMAN } from "../test/helpers.ts";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1]! : null;
const BROWSER = !args.includes("--no-browser");
const STATIC = resolve(import.meta.dirname, "../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s.at(-1)!), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
};
const now = () => performance.now();
const results: Record<string, unknown> = {};

/** Time from one client's insert until every other client has it, `rounds` times, with a short gap between edits. */
async function propagation(clients: Client[], rounds: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const writer = clients[i % clients.length]!;
    const others = clients.filter((c) => c !== writer);
    const marker = `<${i}>`;
    const t0 = now();
    const seen = Promise.all(
      others.map(
        (c) =>
          new Promise<void>((ok) => {
            if (c.text.toString().includes(marker)) return ok();
            const f = () => c.text.toString().includes(marker) && (c.text.unobserve(f), ok());
            c.text.observe(f);
          }),
      ),
    );
    writer.text.insert(writer.text.length, marker);
    await seen;
    out.push(now() - t0);
    await new Promise((r) => setTimeout(r, 5));
  }
  return out;
}

const { server, repo } = await testServer({ "notes.txt": "start\n", "src/app.js": "export const x = 1;\n" }, { flushMs: 300, staticDir: existsSync(STATIC) ? STATIC : undefined });
try {
  // 1. Remote edit propagation.
  for (const n of [2, 5, 10]) {
    const clients: Client[] = [];
    for (let i = 0; i < n; i++) clients.push(await client(server, (await joinAs(server, `P${n}-${i}`)).cookie, "notes.txt"));
    await propagation(clients, 20); // warm-up
    results[`propagation_${n}_clients_ms`] = stats(await propagation(clients, 200));
    if (n === 10) results.server_rss_mb_with_10_clients = Math.round(process.memoryUsage().rss / 1e6);
    for (const c of clients) c.close();
  }

  // 2. Reconnect: a client misses 50 edits while offline, then resyncs.
  {
    const a = await client(server, (await joinAs(server, "RA")).cookie, "notes.txt");
    const b = await client(server, (await joinAs(server, "RB")).cookie, "notes.txt");
    const xs: number[] = [];
    for (let i = 0; i < 20; i++) {
      b.provider.disconnect();
      for (let k = 0; k < 50; k++) a.text.insert(a.text.length, "x");
      await new Promise((r) => setTimeout(r, 50));
      const t0 = now();
      b.provider.connect();
      await until(() => b.text.toString() === a.text.toString(), 5000, "resync");
      xs.push(now() - t0);
    }
    results.reconnect_resync_after_50_missed_edits_ms = stats(xs);

    // 3. Durability: edit until the file on disk has it (server flush interval 300 ms).
    const ds: number[] = [];
    for (let i = 0; i < 20; i++) {
      const m = `<disk${i}>`;
      const t0 = now();
      a.text.insert(a.text.length, m);
      await until(() => readFileSync(join(repo, "notes.txt"), "utf8").includes(m), 5000, "disk");
      ds.push(now() - t0);
    }
    results.edit_to_disk_ms_flush_300 = stats(ds);
    a.close();
    b.close();
  }

  // 4. Task events: engine records an event, a subscribed client receives it on /events.
  {
    const { cookie } = await joinAs(server, "Ev");
    const ws = new WS(`${server.url.replace("http", "ws")}/events`, { headers: { cookie } });
    await new Promise((ok) => ws.once("open", ok));
    const xs: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = now();
      const got = new Promise<void>((ok) => {
        const f = (raw: WS.RawData) => {
          const msg = JSON.parse(String(raw)) as { events?: { type: string; data: { i?: number } }[] };
          if (msg.events?.some((e) => e.type === "bench.ping" && e.data.i === i)) (ws.off("message", f), ok());
        };
        ws.on("message", f);
      });
      server.relay.record("bench.ping", HUMAN, { i });
      await got;
      xs.push(now() - t0);
      await new Promise((r) => setTimeout(r, Math.random() * 50));
    }
    results.task_event_propagation_ms = stats(xs);

    // 4b. Events written by another process (a hook, an MCP server, the CLI) are found by the server's 200 ms poll.
    const ys: number[] = [];
    const { spawn } = await import("node:child_process");
    const dbPath = (server.relay as unknown as { dbPath: string }).dbPath;
    for (let i = 0; i < 20; i++) {
      const got = new Promise<number>((ok) => {
        const f = (raw: WS.RawData) => {
          const msg = JSON.parse(String(raw)) as { events?: { type: string; data: { i?: number; t?: number } }[] };
          const e = msg.events?.find((x) => x.type === "bench.external" && x.data.i === i);
          if (e) (ws.off("message", f), ok(Date.now() - e.data.t!));
        };
        ws.on("message", f);
      });
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import { Relay } from ${JSON.stringify(resolve(import.meta.dirname, "../src/core/engine.ts"))}; const r = new Relay(${JSON.stringify(dbPath)}); r.record("bench.external", "system:bench", { i: ${i}, t: Date.now() }); r.close();`], { stdio: "ignore" });
      const exited = new Promise((r) => child.once("exit", r));
      ys.push(await got);
      await exited;
    }
    results.task_event_propagation_other_process_ms = stats(ys);
    ws.close();
  }

  // 5. Keystroke to paint in the real IDE (Chromium), while a second collaborator is in the same file.
  if (BROWSER && existsSync(STATIC)) {
    const other = await client(server, (await joinAs(server, "Peer")).cookie, "src/app.js");
    const browser = await chromium.launch({ executablePath: CHROME });
    const { token } = server.members.invite("Typist", "owner");
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
    await page.goto(`${server.url}/join#${token}`);
    await page.waitForURL(`${server.url}/`);
    await page.getByTestId("file-src/app.js").click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.evaluate(() => {
      const w = window as unknown as { __lat: number[] };
      w.__lat = [];
      const content = document.querySelector(".cm-content")!;
      document.addEventListener(
        "keydown",
        (e) => {
          const t0 = e.timeStamp;
          const obs = new MutationObserver(() => {
            obs.disconnect();
            requestAnimationFrame(() => w.__lat.push(performance.now() - t0));
          });
          obs.observe(content, { childList: true, subtree: true, characterData: true });
        },
        { capture: true },
      );
    });
    for (let i = 0; i < 120; i++) await page.keyboard.type("a", { delay: 15 });
    await page.waitForTimeout(300);
    const lat = (await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat)).slice(20);
    results.browser_keystroke_to_paint_ms = stats(lat);
    // The peer sees the typing too: browser -> server -> y-websocket client.
    await until(() => (other.text.toString().match(/a/g)?.length ?? 0) >= 120, 5000, "peer sees typing");
    await browser.close();
    other.close();
  }
} finally {
  await server.close();
}

const conditions = {
  date: new Date().toISOString(),
  node: process.version,
  cpu: `${cpus().length} x ${cpus()[0]?.model}`,
  memoryGb: Math.round(totalmem() / 1e9),
  transport: "loopback (127.0.0.1), server and clients in one process except the browser",
  serverFlushMs: 300,
};
const report = { conditions, results };
console.log(JSON.stringify(report, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
