import { requireSession } from "@/lib/auth";
import { getRuntime, runtimeIsDemo } from "@/lib/runtime";
import { stopSpace } from "../actions";
import { Badge, Button, Card, Empty, PageHeader } from "@/components/ui/primitives";
import type { SpaceView } from "@recast/runtime-client";

export const dynamic = "force-dynamic";

const money = (minor: number, currency: string) => new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100);
const STATE: Record<SpaceView["state"], { label: string; tone: "ok" | "muted" | "warn" | "danger" }> = { active: { label: "Active", tone: "ok" }, stopped: { label: "Stopped", tone: "danger" }, expired: { label: "Expired", tone: "muted" }, exhausted: { label: "Budget used up", tone: "warn" } };

export default async function Agents({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  await requireSession();
  const sp = await searchParams; const runtime = getRuntime();
  const [agents, spaces] = await Promise.all([runtime.listAgents(), runtime.listSpaces().catch(() => [] as SpaceView[])]);
  return (
    <>
      <PageHeader title="Agents" lead="Every AI agent that can act for you, what each one may do, and how much of that is left. Each has its own key, so none of them shares yours." />
      {runtimeIsDemo() ? <p className="mb-4 text-xs text-muted">Sample agents. Connect the Agent Runtime to see yours.</p> : null}
      {sp.done ? <p role="status" className="mb-4 rounded-(--r-panel) border border-ok p-4 text-ok-ink">Stopped. That Space cannot act again; create a new one if you need it.</p> : null}
      {sp.error ? <p role="status" className="mb-4 rounded-(--r-panel) border border-warn p-4 text-warn-ink">That Space had already stopped.</p> : null}
      <h2 className="mb-2 mt-2 text-sm font-medium">Spaces</h2>
      <p className="mb-3 text-sm text-muted">What an agent may do, for how long, and how much it may spend. Stopping a Space takes effect on the agent&apos;s next call.</p>
      {spaces.length === 0 ? <Empty>No Spaces.</Empty> : (
        <ul className="mb-8 grid gap-3">
          {spaces.map((s) => (
            <li key={s.id}>
              <Card className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">{s.name} <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge></p>
                  {s.purpose ? <p className="mt-1 text-sm text-muted">{s.purpose}</p> : null}
                  <p className="mt-2 text-sm">Agent <code className="font-mono text-xs">{s.agentId}</code> may use {s.tools.map((t, i) => <span key={`${t.tool}.${t.action}`}>{i ? ", " : ""}<code className="font-mono text-xs">{t.tool}.{t.action}</code>{t.approval === "always" ? " (asks you first)" : ""}</span>)}.</p>
                  <p className="mt-1 text-sm text-muted">{s.maxCalls - s.calls} of {s.maxCalls} calls left{s.spend ? `, ${money(s.spend.limitMinor - s.spend.spentMinor, s.spend.currency)} of ${money(s.spend.limitMinor, s.spend.currency)} to spend` : ", no spending"}, until {s.expiresAt.replace("T", " ").slice(0, 16)} UTC{s.stoppedBy ? `. Stopped by ${s.stoppedBy}` : ""}.</p>
                </div>
                {s.state === "active" ? (
                  <form action={stopSpace}><input type="hidden" name="id" value={s.id} /><Button type="submit" variant="danger" aria-label={`Stop ${s.name}`}>Stop</Button></form>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mb-2 text-sm font-medium">Agents</h2>
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
