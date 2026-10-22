import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { ERROR_CODES, EXAMPLES, curl } from "@/lib/examples";

export const metadata: Metadata = { title: "Recast API docs", description: "Resolve text into typed objects and route them to a person's apps." };
export const dynamic = "force-static";

// The SDK example is real code: the test runs this same file against the server.
const SDK_EXAMPLE = readFileSync(path.join(process.cwd(), "lib/sdk-example.ts"), "utf8").replace(/^\/\/.*\n/, "");



export default function Docs() {
  return (
    <main className="docs">
      <h1>Recast API</h1>
      <p className="muted">Resolve raw text into a typed object, with confidence and provenance for every field, and a route to the app it belongs in.</p>
      <nav aria-label="On this page"><ul>
        {[["start", "Start"], ["auth", "Authentication"], ...EXAMPLES.map((e) => [e.id, e.title.split(" (")[0]!]), ["sdk", "SDK"], ["limits", "Limits"], ["errors", "Errors"], ["versions", "Versions"]].map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}
      </ul></nav>

      <h2 id="start">Start</h2>
      <p>Recast is in private release. Your Recast contact issues an API key (shown once; only its hash is stored) and tells you which capabilities your account has. Keys start with <code>sk_live_</code> or <code>sk_test_</code>.</p>
      <pre tabIndex={0}><code>export RECAST_API_KEY=sk_live_…</code></pre>

      <h2 id="auth">Authentication</h2>
      <p>Send <code>Authorization: Bearer $RECAST_API_KEY</code> on every request except <code>GET /v1/health</code>. Keep the key on your server; never ship it to a browser or an app.</p>

      {EXAMPLES.map((e) => (
        <section key={e.id} aria-labelledby={e.id}>
          <h2 id={e.id}>{e.title}</h2>
          <p><span className="pill">{e.method} {e.path}</span></p>
          <pre tabIndex={0}><code>{curl(e)}</code></pre>
          {e.note ? <p>{e.note}</p> : null}
          <p className="muted">Expected: HTTP {e.expect.status}{e.expect.code ? ` with code ${e.expect.code}` : ""}.</p>
        </section>
      ))}

      <h2 id="sdk">TypeScript SDK</h2>
      <p><code>@recast/sdk</code> retries on 429 using <code>Retry-After</code>, sends one idempotency key per placement, maps answers to camelCase and raises typed errors. It is not published to npm yet; it lives in this repository.</p>
      <pre tabIndex={0}><code>{SDK_EXAMPLE}</code></pre>

      <h2 id="limits">Limits and headers</h2>
      <ul>
        <li><code>RateLimit-Limit</code> and <code>RateLimit-Remaining</code> on every answer; <code>429 rate_limited</code> with <code>Retry-After</code> when you go over.</li>
        <li><code>X-Recast-Quota-Limit</code> and <code>X-Recast-Quota-Used</code>: resolutions this month (UTC).</li>
        <li>Bodies up to 512 KB; batches of 1 to 50 items.</li>
        <li><code>Recast-Schema-Version</code> on every answer; <code>Cache-Control: no-store</code>.</li>
      </ul>

      <h2 id="errors">Errors</h2>
      <p>Every error is <code>{`{"error":{"code":"…","message":"…"}}`}</code>. Branch on <code>code</code>; the message is for people and may change.</p>
      <div className="tablewrap" tabIndex={0} role="region" aria-label="Error codes"><table>
        <thead><tr><th scope="col">Code</th><th scope="col">HTTP</th><th scope="col">What to do</th></tr></thead>
        <tbody>{ERROR_CODES.map(([c, s, m]) => <tr key={c}><td><code>{c}</code></td><td>{s}</td><td>{m}</td></tr>)}</tbody>
      </table></div>

      <h2 id="versions">Versions and compatibility</h2>
      <p>The major version is in the path (<code>/v1</code>). Within v1 we only add: new endpoints, new optional fields, new values in open lists (statuses, destinations, error codes). So ignore fields you do not know, treat an unknown resolve status as unresolved, and never treat an unknown placement status as success. A breaking change gets a new path and at least six months' notice through <code>Deprecation</code> and <code>Sunset</code> headers. The full contract is at <a href="/v1/openapi.json"><code>/v1/openapi.json</code></a> (with your key).</p>
      <p className="muted"><a href="/v1/health">Status</a></p>
    </main>
  );
}
