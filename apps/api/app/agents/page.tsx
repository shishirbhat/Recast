import type { Metadata } from "next";
import { CLAIMS, NOT_YET } from "@/lib/claims";

export const metadata: Metadata = {
  title: "Recast for MCP agents",
  description: "Give your AI agent an identity, permissions and a paper trail, in one command.",
};
// The contact link comes from the deployment (RECAST_CONTACT_URL), so it is read per request, not baked in at build time.
export const dynamic = "force-dynamic";

const INIT = `npx tsx packages/agent-runtime/src/cli.ts init \\
  --name my-agent --org acme --tenant <your tenant id> \\
  --gateway https://<your runtime>/mcp --register`;
const CONFIG = `{ "mcpServers": { "recast-my-agent": {
    "command": "agent-auth", "args": ["connect", "--name", "my-agent"] } } }`;

export default function Agents() {
  const contact = process.env.RECAST_CONTACT_URL;
  return (
    <main className="docs">
      <p className="muted">For teams building agents on MCP</p>
      <h1 className="hero">Give your AI agent an identity, permissions and a paper trail, in one command.</h1>
      <p className="lead">Your agent calls real tools on behalf of real people. Recast sits between the agent and its tools: it knows which agent is calling, lets it do only what a person allowed, asks that person before the risky parts, and keeps a record nobody can quietly edit.</p>
      <p>{contact ? <a className="cta" href={contact}>Ask for a design-partner pilot</a> : <strong>Design-partner pilots are open. Reply to whoever sent you this page.</strong>} {" "}<a href="/docs">API docs</a></p>

      <h2>How it fits in</h2>
      <ol>
        <li>Run <code>agent-auth init</code> where your agent runs. The private key never leaves that machine.</li>
        <li>Give the agent a Space: the exact actions it may take, for how long, and how much it may spend.</li>
        <li>Point your MCP client at <code>agent-auth connect</code>. Your tools are reached only through the gateway.</li>
      </ol>
      <pre tabIndex={0}><code>{INIT}</code></pre>
      <pre tabIndex={0}><code>{CONFIG}</code></pre>

      <h2>What you get</h2>
      <div className="grid">
        {CLAIMS.map((c) => (
          <section key={c.id} className="card" aria-labelledby={`claim-${c.id}`}>
            <h3 id={`claim-${c.id}`}>{c.headline}</h3>
            <p>{c.detail}</p>
            <p className="evidence">Shown by <code>{c.evidence.join(", ")}</code></p>
          </section>
        ))}
      </div>

      <h2>What a pilot looks like</h2>
      <ul>
        <li>One agent of yours, one Space, two weeks.</li>
        <li>We set up the runtime with you; your tool credentials stay in your vault.</li>
        <li>You keep the signed audit log and can verify it yourself with <code>agent-auth verify-audit</code>.</li>
        <li>What we learn decides what we build next. Tell us where it gets in your way.</li>
      </ul>

      <h2>What is not there yet</h2>
      <p className="muted">We would rather you hear it from us.</p>
      <ul>{NOT_YET.map((n) => <li key={n}>{n}</li>)}</ul>
    </main>
  );
}
