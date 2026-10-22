// Linear, optional and separate from Google: one team, with a personal API key the person creates in Linear
// (Settings → Security & access → Personal API keys). Kept on this computer only.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Transport } from "@recast/bridges";

export interface LinearLink { key: string; teamId: string; teamKey: string; teamName: string; connected_at: string }
export const linearFile = (dir: string) => path.join(dir, "linear.json");
export function readLinear(dir: string): LinearLink | null { try { return JSON.parse(readFileSync(linearFile(dir), "utf8")) as LinearLink; } catch { return null; } }
export function forgetLinear(dir: string) { if (existsSync(linearFile(dir))) rmSync(linearFile(dir)); }

/** Finds the team by its key (for example ENG) with the API key before saving anything. */
export async function connectLinear(dir: string, key: string, teamKey: string, f: typeof fetch, now: number): Promise<{ ok: true; link: LinearLink } | { ok: false; message: string }> {
  key = key.trim(); teamKey = teamKey.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,6}$/.test(teamKey)) return { ok: false, message: "Write the team's key, for example ENG (it starts every issue id, like ENG-12)." };
  if (!/^lin_api_[A-Za-z0-9]{20,}$/.test(key)) return { ok: false, message: "That does not look like a Linear API key (they start with lin_api_)." };
  let body: Record<string, any>;
  try {
    const r = await f("https://api.linear.app/graphql", { method: "POST", headers: { authorization: key, "content-type": "application/json" },
      body: JSON.stringify({ query: "query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }", variables: { key: teamKey } }) });
    if (r.status === 401 || r.status === 400) return { ok: false, message: "Linear did not accept that key. Nothing was saved." };
    if (r.status !== 200) return { ok: false, message: `Linear answered ${r.status}. Nothing was saved.` };
    body = await r.json() as Record<string, any>;
  } catch { return { ok: false, message: "Linear could not be reached. Nothing was saved." }; }
  const team = body?.data?.teams?.nodes?.[0];
  if (body?.errors?.length || !team?.id) return { ok: false, message: `No team with the key ${teamKey} is visible with this key. Nothing was saved.` };
  const link: LinearLink = { key, teamId: String(team.id), teamKey: String(team.key), teamName: String(team.name ?? team.key), connected_at: new Date(now).toISOString() };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(linearFile(dir), JSON.stringify(link), { mode: 0o600 }); chmodSync(linearFile(dir), 0o600);
  return { ok: true, link };
}

export function linearTransport(link: LinearLink, f: typeof fetch): Transport {
  return async (req) => {
    if (new URL(req.url).origin !== "https://api.linear.app") throw new Error("Linear requests go to api.linear.app only");
    const r = await f(req.url, { method: req.method, headers: { authorization: link.key, "content-type": "application/json", ...req.headers }, ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}
