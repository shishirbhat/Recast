// Test builds only: stands in for Google's APIs inside the app's main process. What was written is kept on globalThis
// so the test can look (the real Google is checked by hand: docs/REAL_TEST_PLAN.md).
const s = (globalThis.__recastFake ??= { events: {}, tasks: {}, todoist: {}, calls: [] });
const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export default async function fakeFetch(u, init = {}) {
  const url = String(u), method = init.method ?? "GET"; s.calls.push(`${method} ${url}`);
  // Todoist (API v1), with its own token.
  if (url.startsWith("https://api.todoist.com/")) {
    if ((init.headers ?? {}).authorization !== `Bearer ${"d".repeat(40)}`) return json(401, {});
    const id = url.split("/tasks/")[1];
    if (method === "POST") { const b = JSON.parse(String(init.body)); const tid = `TD${Object.keys(s.todoist).length + 1}`; s.todoist[tid] = { id: tid, content: b.content, description: b.description ?? "", checked: false }; return json(200, s.todoist[tid]); }
    if (method === "DELETE") { delete s.todoist[id]; return json(204, null); }
    return id && s.todoist[id] ? json(200, s.todoist[id]) : json(404, {});
  }
  if ((init.headers ?? {}).authorization !== "Bearer AT-desktop") return json(401, {});
  if (url.startsWith("https://tasks.googleapis.com/")) {
    if (method === "POST") { const id = `t${Object.keys(s.tasks).length + 1}`; s.tasks[id] = JSON.parse(String(init.body)); return json(200, { id }); }
    if (method === "DELETE") { delete s.tasks[url.split("/tasks/").pop()]; return json(204, null); }
  }
  if (url.startsWith("https://www.googleapis.com/calendar/v3/")) {
    const id = decodeURIComponent(url.split("/events/")[1]?.split("?")[0] ?? "");
    if (method === "POST") { const b = JSON.parse(String(init.body)); if (s.events[b.id]) return json(409, {}); s.events[b.id] = { ...b, status: "confirmed", htmlLink: `https://www.google.com/calendar/event?eid=${b.id}` }; return json(200, s.events[b.id]); }
    if (method === "GET") return s.events[id] ? json(200, s.events[id]) : json(404, {});
    if (method === "DELETE") { if (s.events[id]) s.events[id].status = "cancelled"; return json(204, null); }
  }
  return json(400, {});
}
