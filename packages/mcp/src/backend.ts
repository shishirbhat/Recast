import { MAX_RAW_CHARS, bridgeCatalog, createResolver, toWire, type ApiType, type Resolver } from "@recast/resolve";

export interface ResolveArgs { raw: string; source_url?: string; target_type?: ApiType; destination?: string; include_provenance?: boolean }
/** Where answers come from. Both return the public wire shape of `/v1/resolve` and `/v1/bridges`, so tools look the same either way. */
export interface Backend {
  readonly mode: "local" | "remote";
  resolve(args: ResolveArgs): Promise<unknown>;
  destinations(): Promise<unknown[]>;
}

/** A tool-facing failure: the message is shown to the model, so it says what to do next and never leaks internals. */
export class ToolError extends Error {}

/** Runs the resolve engine in this process. No key, no network: rules only unless an embedder or model is injected. */
export function localBackend(resolver: Resolver = createResolver()): Backend {
  return {
    mode: "local",
    async resolve(a) {
      if (a.raw.length > MAX_RAW_CHARS) throw new ToolError(`raw is longer than ${MAX_RAW_CHARS} characters; send the part that describes one thing`);
      const target = a.target_type || a.destination ? { ...(a.target_type ? { type: a.target_type } : {}), ...(a.destination ? { destination: a.destination } : {}) } : undefined;
      return toWire(await resolver.resolve({ raw: a.raw, ...(a.source_url ? { sourceUrl: a.source_url } : {}), ...(target ? { target } : {}) }), a.include_provenance ?? true);
    },
    async destinations() { return bridgeCatalog(); },
  };
}

/** Calls the hosted Recast API with the tenant's key, so usage, limits and corrections consent apply as for any API client. */
export function remoteBackend(opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): Backend {
  const base = (opts.baseUrl ?? "https://api.recast.dev").replace(/\/+$/, ""); const f = opts.fetch ?? fetch;
  async function call(path: string, init: RequestInit = {}) {
    let res: Response;
    try { res = await f(base + path, { ...init, headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) } }); }
    catch { throw new ToolError("could not reach the Recast API; try again shortly"); }
    const json = await res.json().catch(() => null) as { error?: { code?: string; message?: string; retry_after?: number } } | null;
    if (!res.ok) {
      const e = json?.error; const wait = e?.retry_after ? ` Retry after ${e.retry_after} s.` : "";
      throw new ToolError(`Recast API ${res.status} ${e?.code ?? "error"}: ${e?.message ?? res.statusText}.${wait}`);
    }
    return json;
  }
  return {
    mode: "remote",
    async resolve(a) {
      const target = a.target_type || a.destination ? { ...(a.target_type ? { type: a.target_type } : {}), ...(a.destination ? { destination: a.destination } : {}) } : undefined;
      return call("/v1/resolve", { method: "POST", body: JSON.stringify({ input: { raw: a.raw, ...(a.source_url ? { source_url: a.source_url } : {}) }, ...(target ? { target } : {}), options: { include_provenance: a.include_provenance ?? true } }) });
    },
    async destinations() { return ((await call("/v1/bridges")) as { bridges: unknown[] }).bridges; },
  };
}

export function backendFromEnv(env: NodeJS.ProcessEnv): Backend {
  return env.RECAST_API_KEY ? remoteBackend({ apiKey: env.RECAST_API_KEY, ...(env.RECAST_API_URL ? { baseUrl: env.RECAST_API_URL } : {}) }) : localBackend();
}
