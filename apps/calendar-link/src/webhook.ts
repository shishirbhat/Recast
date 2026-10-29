// The person's own webhook (Zapier, Make, n8n, their own server), optional. Recast keeps the address, a name and a signing
// secret it generated, in a file only the person can read. Every delivery is signed so the receiver can check it came
// from this computer: X-Recast-Signature = sha256 HMAC of "<timestamp>.<body>" with the secret.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Transport } from "@recast/bridges";

export interface WebhookLink { url: string; name: string; secret: string; connected_at: string }
export const webhookFile = (dir: string) => path.join(dir, "webhook.json");
export function readWebhook(dir: string): WebhookLink | null { try { return JSON.parse(readFileSync(webhookFile(dir), "utf8")) as WebhookLink; } catch { return null; } }
export function forgetWebhook(dir: string) { if (existsSync(webhookFile(dir))) rmSync(webhookFile(dir)); }

/** https, or http only to this computer (for a receiver being built locally). No credentials in the address. */
export function webhookUrlProblem(u: string): string | null {
  let url: URL; try { url = new URL(u.trim()); } catch { return "That is not a web address."; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "Use an https:// address (http:// only for localhost).";
  if (url.username || url.password) return "Leave the name and password out of the address.";
  return null;
}
export const signature = (secret: string, timestamp: string, body: string) => `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

async function deliver(link: Pick<WebhookLink, "url" | "secret">, body: string, f: typeof fetch, now: number, headers: Record<string, string> = {}) {
  const ts = String(Math.floor(now / 1000)); const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    // No redirects: the delivery goes to the address the person gave, nowhere else.
    return await f(link.url, { method: "POST", redirect: "manual", signal: ctl.signal, headers: { "content-type": "application/json", "user-agent": "Recast", "X-Recast-Timestamp": ts, "X-Recast-Signature": signature(link.secret, ts, body), ...headers }, body });
  } finally { clearTimeout(timer); }
}

/** Saves the webhook only after it answered a signed test ping with a 2xx. The secret is returned once, for the page. */
export async function connectWebhook(dir: string, name: string, url: string, f: typeof fetch, now: number): Promise<{ ok: true; link: WebhookLink } | { ok: false; message: string }> {
  name = name.replace(/\s+/g, " ").trim().slice(0, 40) || "Your webhook"; url = url.trim();
  const problem = webhookUrlProblem(url); if (problem) return { ok: false, message: `${problem} Nothing was saved.` };
  const link: WebhookLink = { url, name, secret: randomBytes(32).toString("hex"), connected_at: new Date(now).toISOString() };
  let r: Response;
  try { r = await deliver(link, JSON.stringify({ recast: 1, kind: "ping", at: new Date(now).toISOString() }), f, now); }
  catch { return { ok: false, message: "The webhook could not be reached (or took longer than 10 seconds). Nothing was saved." }; }
  if (r.status >= 300 && r.status < 400) return { ok: false, message: "The webhook answered with a redirect. Recast sends only to the exact address you give. Nothing was saved." };
  if (r.status < 200 || r.status >= 300) return { ok: false, message: `The webhook answered ${r.status} to a test ping. Nothing was saved.` };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(webhookFile(dir), JSON.stringify(link), { mode: 0o600 }); chmodSync(webhookFile(dir), 0o600);
  return { ok: true, link };
}

/** Sends to the saved address only, signed. A redirect is a refusal; a 2xx is delivered. */
export function webhookTransport(link: WebhookLink, f: typeof fetch, now: () => number): Transport {
  return async (req) => {
    if (req.method !== "POST" || req.url !== link.url) throw new Error("A webhook delivery goes to the saved address only");
    const r = await deliver(link, JSON.stringify(req.body ?? {}), f, now(), req.headers ?? {});
    if (r.status >= 300 && r.status < 400) return { status: 400, json: { error: "redirect refused" } };
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}
