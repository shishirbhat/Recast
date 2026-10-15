import { getRuntime, runtimeIsDemo } from "@/lib/runtime";
import { decideApproval } from "../actions";
import { Button, Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Approvals({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams; const pending = await getRuntime().listApprovals();
  return (
    <>
      <PageHeader title="Approvals" lead="Things an agent wants to do that need a person first. Nothing happens until you decide, and each approval works once, for that exact request." />
      {runtimeIsDemo() ? <p className="mb-4 text-xs text-muted">Sample request. Connect the Agent Runtime to see real ones.</p> : null}
      {sp.done ? <p role="status" className="mb-4 rounded-(--r-panel) border border-ok p-4 text-ok">{sp.done === "approved" ? "Approved. The agent can now repeat that exact request once." : "Rejected. The agent was told no."}</p> : null}
      {sp.error ? <p role="status" className="mb-4 rounded-(--r-panel) border border-warn p-4 text-warn">That request was already decided or has expired.</p> : null}
      {pending.length === 0 ? <Empty>Nothing is waiting for you.</Empty> : (
        <ul className="grid gap-3">
          {pending.map((a) => (
            <li key={a.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium"><code className="font-mono text-sm">{a.agentId}</code> wants to run <code className="font-mono text-sm">{a.tool}.{a.action}</code></p>
                  <p className="mt-1 text-xs text-muted">Asked {new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC. It expires 15 minutes after that.</p>
                </div>
                <form action={decideApproval} className="flex gap-2">
                  <input type="hidden" name="id" value={a.id} />
                  <Button name="decision" value="reject" variant="danger" aria-label={`Reject ${a.tool}.${a.action} for ${a.agentId}`}>Reject</Button>
                  <Button name="decision" value="approve" variant="primary" aria-label={`Approve ${a.tool}.${a.action} for ${a.agentId}`}>Approve</Button>
                </form>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
