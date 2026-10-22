/**
 * Every claim the agents page (/agents) makes, with the file in this repository that proves it. The page renders only from this
 * list, and test/agents-page.test.ts fails if a claim's evidence file is missing. Marketing copy cannot get ahead of the code.
 * Evidence levels follow docs/ENGINEERING_STATUS.md: H = local harness (real processes, official MCP SDK, Postgres wire protocol).
 */
export interface Claim { id: string; headline: string; detail: string; evidence: string[]; level: "U" | "H" }

export const CLAIMS: Claim[] = [
  { id: "identity", headline: "An identity per agent, in one command", level: "H",
    detail: "agent-auth init creates an Ed25519 key on the agent's machine and registers only the public half. Every request carries a short token and a fresh proof signed there, so a stolen token is useless on its own.",
    evidence: ["packages/agent-runtime/src/cli.ts", "packages/agent-runtime/src/bridge.ts", "apps/agent-server/test/pilot.test.ts"] },
  { id: "bounds", headline: "Permissions with edges", level: "H",
    detail: "A Space lists exactly which tool actions an agent may call, with parameter limits, a call budget, a money budget and an expiry of at most 30 days. Concurrent calls never share the last unit of budget. Stop is immediate and permanent.",
    evidence: ["packages/agent-runtime/src/space.ts", "packages/agent-runtime/test/spaces.test.ts", "apps/agent-server/test/spaces.test.ts"] },
  { id: "approvals", headline: "A person approves the risky calls, once", level: "H",
    detail: "Policy is deny by default. An approval is bound to the exact tool, arguments and Space, and works once: approving \"email Meera\" cannot be replayed as \"email everyone\".",
    evidence: ["packages/agent-runtime/src/approvals.ts", "packages/agent-runtime/src/policy.ts", "apps/agent-server/test/pilot.test.ts"] },
  { id: "audit", headline: "A paper trail that shows tampering", level: "H",
    detail: "Every decision is written to a hash-chained, Ed25519-signed log before the call is forwarded; if the log cannot be written, nothing happens. Edits, deletions, reordering and forks are detected.",
    evidence: ["packages/agent-runtime/src/audit.ts", "packages/agent-runtime/test/gateway.test.ts"] },
  { id: "credentials", headline: "Your agent never holds the tool's credentials", level: "H",
    detail: "Upstream credentials stay in the runtime's vault and are exchanged per call. The agent's own token is never forwarded, and model keys never pass through Recast.",
    evidence: ["packages/agent-runtime/src/exchange.ts", "packages/agent-runtime/test/gateway.test.ts", "docs/17-agent-pilot.md"] },
  { id: "mcp", headline: "Works with the MCP client you already use", level: "H",
    detail: "Tested with the official MCP SDK over Streamable HTTP and over stdio, through the gateway, against real local MCP servers. Desktop clients launch agent-auth connect like any other MCP server.",
    evidence: ["apps/agent-server/test/pilot.test.ts", "packages/agent-runtime/test/mcp-real.test.ts"] },
  { id: "resolve", headline: "Typed objects instead of strings", level: "H",
    detail: "resolve_object turns \"Meera Iyer, meera@x.com\" into a Person with per-field confidence and provenance, and says what placing it would do and what consent it needs. Available as an MCP tool and an HTTP API.",
    evidence: ["packages/mcp/src/backend.ts", "packages/mcp/test/mcp.test.ts", "apps/api/test/docs.test.ts"] },
];

/** Said plainly on the page, so a design partner knows exactly what they are signing up for. */
export const NOT_YET: string[] = [
  "No hosted service yet: the pilot runs the runtime in your environment or ours, set up together.",
  "Not externally security-reviewed; our internal review and its open risks are in docs/14-security-review.md.",
  "No real third-party tools connected through it in production yet; tested with local MCP servers.",
  "The CLI is not packaged; it runs from the repository with Node 22.",
];
