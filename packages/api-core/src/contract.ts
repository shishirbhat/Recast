import Ajv2020 from "ajv/dist/2020";
import { OPENAPI, declaredResponse } from "./openapi";

/**
 * Checks a real response against the contract in ./openapi. Used by the contract tests here, in apps/api (the built server) and in
 * the SDK (every response the SDK reads). Not used at runtime.
 */
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("date-time", (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)));
ajv.addSchema({ $id: "recast", components: OPENAPI.components });
const rebase = (v: unknown): unknown => Array.isArray(v) ? v.map(rebase) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "$ref" && typeof x === "string" ? x.replace(/^#/, "recast#") : rebase(x)])) : v;
const cache = new Map<string, ReturnType<typeof ajv.compile>>();

/** Template paths ("/v1/place/undo") match exactly; a request path with a query string is matched without it. */
export function checkResponse(method: string, path: string, status: number, body: unknown): string[] {
  const p = path.split("?")[0]!.replace(/\/+$/, "");
  const d = declaredResponse(method, p, status); if ("undeclared" in d) return [d.undeclared];
  const key = `${method} ${p} ${status}`;
  let v = cache.get(key); if (!v) { v = ajv.compile(rebase(d.schema) as object); cache.set(key, v); }
  return v(body) ? [] : (v.errors ?? []).map((e) => `${key}: ${e.instancePath || "(body)"} ${e.message}${e.params && "additionalProperty" in e.params ? ` '${(e.params as { additionalProperty: string }).additionalProperty}'` : ""}`);
}

/** A fetch that checks every /v1 answer against the contract and records any breach. */
export function contractFetch(inner: typeof fetch, breaches: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await inner(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.startsWith("/v1/")) {
      const text = await r.clone().text(); let body: unknown = undefined; try { body = JSON.parse(text); } catch { breaches.push(`${url.pathname}: body is not JSON`); }
      breaches.push(...checkResponse(init?.method ?? "GET", url.pathname, r.status, body));
    }
    return r;
  }) as typeof fetch;
}

/** Wraps an API so every response for an operation in the contract is checked; breaches are pushed to `breaches`. */
export function withContractCheck<T extends { handle(req: Request): Promise<Response> }>(api: T, breaches: string[]): T {
  return { ...api, handle: async (req: Request) => {
    const res = await api.handle(req); const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (path in OPENAPI.paths) breaches.push(...checkResponse(req.method, path, res.status, await res.clone().json().catch(() => "(not JSON)")));
    return res;
  } };
}
