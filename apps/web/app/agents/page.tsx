import { requireSession } from "@/lib/auth";
import { getRuntime, runtimeIsDemo } from "@/lib/runtime";
import { Badge, Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Agents() {
  await requireSession();
  const agents = await getRuntime().listAgents();
  return (
    <>
      <PageHeader title="Agents" lead="Every AI agent that can act for you, what each one may do, and how much of that is left. Each has its own key, so none of them shares yours." />
      {runtimeIsDemo() ? <p className="mb-4 text-xs text-muted">Sample agents. Connect the Agent Runtime to see yours.</p> : null}
      {agents.length === 0 ? <Empty>No agents yet.</Empty> : (
        <ul className="grid gap-3">
          {agents.map((a) => (
            <li key={a.agentId}>
              <Card>
                <p className="flex flex-wrap items-center gap-2 font-medium">{a.name} <Badge>{a.agentId}</Badge> {a.revoked ? <Badge tone="danger">Revoked</Badge> : <Badge tone="ok">Active</Badge>}</p>
                {a.scopes.length === 0 ? <p className="mt-2 text-muted">{a.revoked ? "Nothing: this agent was switched off." : "Not allowed to do anything right now."}</p> : (
                  <ul className="mt-3 grid gap-1">
                    {a.scopes.map((s) => (
                      <li key={s.id} className="flex flex-wrap justify-between gap-2 text-sm"><span><code className="font-mono text-xs">{s.tool}.{s.action}</code></span><span className="text-muted">{s.maxCalls - s.calls} of {s.maxCalls} calls left, until {s.expiresAt.replace("T", " ").slice(0, 16)} UTC</span></li>
                    ))}
                  </ul>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
