// Test builds only: stands in for Google's APIs inside the app's main process. What was written is kept on globalThis
// so the test can look (the real Google is checked by hand: docs/REAL_TEST_PLAN.md).
const s = (globalThis.__recastFake ??= { events: {}, tasks: {}, calls: [] });
const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export default async function fakeFetch(u, init = {}) {
  const url = String(u), method = init.method ?? "GET"; s.calls.push(`${method} ${url}`);
  if ((init.headers ?? {}).authorization !== "Bearer AT-desktop") return json(401, {});
  if (url.startsWith("https://tasks.googleapis.com/")) {
    if (method === "POST") { const id = `t${Object.keys(s.tasks).length + 1}`; s.tasks[id] = JSON.parse(String(init.body)); return json(200, { id }); }
    if (method === "DELETE") { delete s.tasks[url.split("/tasks/").pop()]; return json(204, null); }
  }
  if (url.startsWith("https://www.googleapis.com/calendar/v3/")) {
    const id = decodeURIComponent(url.split("/events/")[1]?.split("?")[0] ?? "");
    if (method === "POST") { const b = JSON.parse(String(init.body)); if (s.events[b.id]) return json(409, {}); s.events[b.id] = { ...b, status: "confirmed" }; return json(200, s.events[b.id]); }
    if (method === "GET") return s.events[id] ? json(200, s.events[id]) : json(404, {});
    if (method === "DELETE") { if (s.events[id]) s.events[id].status = "cancelled"; return json(204, null); }
  }
  return json(400, {});
}
