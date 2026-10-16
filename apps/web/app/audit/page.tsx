import { getRuntime, runtimeIsDemo } from "@/lib/runtime";
import { Badge, Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";
const tone = (r: string) => (r === "success" || r === "allowed" ? "ok" : r === "denied" || r === "failure" ? "danger" : "warn") as "ok" | "danger" | "warn";

export default async function Audit() {
  const report = await getRuntime().audit(100); const v = report.verification;
  return (
    <>
      <PageHeader title="Audit chain" lead="Everything every agent did or was refused, in order. Each line is signed and linked to the one before, so a changed or missing line shows." />
      {runtimeIsDemo() ? <p className="mb-4 text-xs text-muted">Sample log.</p> : null}
      <p role="status" className={`mb-4 rounded-(--r-panel) border p-4 ${v.ok ? "border-ok text-ok-ink" : "border-danger text-danger-ink"}`}>
        {v.ok ? `Verified: ${v.entries} entries, every link and signature checks out.` : `Broken at entry ${v.brokenAt}: ${v.reason}. Treat this log as tampered with.`}
      </p>
      {report.entries.length === 0 ? <Empty>Nothing has happened yet.</Empty> : (
        <Card>
          <ol className="grid gap-3">
            {[...report.entries].reverse().map((e) => (
              <li key={e.seq} className="grid gap-1 border-b border-soft pb-3 last:border-0 last:pb-0">
                <p className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted">#{e.seq}</span><time dateTime={e.at} className="text-xs text-muted">{e.at.replace("T", " ").slice(0, 19)}</time><Badge tone={tone(e.result)}>{e.result.replace("_", " ")}</Badge>{e.humanApproved ? <Badge tone="ok">person approved</Badge> : null}</p>
                <p><code className="font-mono text-sm">{e.agentId}</code> · <code className="font-mono text-sm">{e.tool}.{e.action}</code></p>
                {e.reason ? <p className="text-sm text-muted">{e.reason}</p> : null}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
