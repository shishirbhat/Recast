/** Integrated terminal: real PTYs over the authenticated WebSocket, with the owner-only / loopback policy. */
import { test } from "node:test";
import assert from "node:assert/strict";
import WS from "ws";
import { api, join, testServer, until } from "./collab-helpers.ts";
import type { RelayServer } from "../src/server/server.ts";

function term(server: RelayServer, cookie: string, session = "") {
  const ws = new WS(`${server.url.replace("http", "ws")}/terminal?session=${session}&cols=100&rows=30`, { headers: { cookie } });
  const t = { ws, out: "", id: "", exit: null as number | null, error: "", closedCode: 0 };
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "ready") t.id = m.id;
    if (m.type === "output") t.out += m.data;
    if (m.type === "exit") t.exit = m.code;
    if (m.type === "error") t.error = m.message;
  });
  ws.on("close", (code) => (t.closedCode = code));
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  return { t, send, opened: new Promise<void>((ok) => ws.on("open", () => ok())) };
}

test("an owner gets a real shell in the project root; it survives a reconnect with output replayed", async () => {
  const { server, repo } = await testServer();
  try {
    const owner = await join(server, "Olu", "owner");
    const caps = (await api(server, owner.cookie, "GET", "/api/capabilities")).body;
    assert.equal(caps.terminal.available, true);
    const a = term(server, owner.cookie);
    await a.opened;
    await until(() => !!a.t.id, 5000, "ready");
    a.send({ type: "input", data: "echo relay-$((6*7)); pwd\r" });
    await until(() => a.t.out.includes("relay-42") && a.t.out.includes(repo), 5000, "command output");
    const id = a.t.id;
    a.t.ws.close();
    await until(() => a.t.closedCode !== 0, 2000, "closed");
    // Reattach: same session, earlier output replayed, shell still alive.
    const b = term(server, owner.cookie, id);
    await b.opened;
    await until(() => b.t.id === id && b.t.out.includes("relay-42"), 5000, "replay");
    b.send({ type: "input", data: "echo still-$((1+1))\r" });
    await until(() => b.t.out.includes("still-2"), 5000, "same shell");
    assert.deepEqual((await api(server, owner.cookie, "GET", "/api/terminals")).body.sessions.map((s: { id: string }) => s.id), [id]);
    assert.equal((await api(server, owner.cookie, "POST", `/api/terminals/${id}/kill`)).body.killed, true);
    b.t.ws.close();
  } finally {
    await server.close();
  }
});

test("terminal policy: editors and viewers are refused; another owner cannot attach to your session", async () => {
  const { server } = await testServer();
  try {
    const owner = await join(server, "Olu", "owner");
    const other = await join(server, "Ana", "owner");
    const editor = await join(server, "Ed", "editor");
    const caps = (await api(server, editor.cookie, "GET", "/api/capabilities")).body;
    assert.equal(caps.terminal.available, false);
    assert.match(caps.terminal.reason, /Only project owners/);
    const e = term(server, editor.cookie);
    await until(() => e.t.closedCode === 4403, 5000, "editor refused");
    assert.match(e.t.error, /Only project owners/);
    const mine = term(server, owner.cookie);
    await until(() => !!mine.t.id, 5000, "ready");
    const theirs = term(server, other.cookie, mine.t.id);
    await until(() => theirs.t.closedCode === 4403, 5000, "other owner refused");
    assert.match(theirs.t.error, /Not your terminal session/);
    mine.t.ws.close();
  } finally {
    await server.close();
  }
});

test("terminal is off when the server listens on a network address, unless --allow-terminal", async () => {
  const off = await testServer(undefined, { host: "0.0.0.0" });
  try {
    const o = await join(off.server, "Olu", "owner");
    const caps = (await api(off.server, o.cookie, "GET", "/api/capabilities")).body;
    assert.equal(caps.terminal.available, false);
    assert.match(caps.terminal.reason, /--allow-terminal/);
  } finally {
    await off.server.close();
  }
  const on = await testServer(undefined, { host: "0.0.0.0", allowTerminal: true });
  try {
    const o = await join(on.server, "Olu", "owner");
    assert.equal((await api(on.server, o.cookie, "GET", "/api/capabilities")).body.terminal.available, true);
  } finally {
    await on.server.close();
  }
});
