import { getRepo } from "@/lib/repo";
import { Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

const words: Record<string, string> = {
  "object.created": "Learned", "object.updated": "Updated", "object.deleted": "Forgot", "relationship.placed": "Connected",
  "integration.enabled": "Turned on", "integration.disabled": "Turned off", "grant.created": "Allowed", "grant.revoked": "Revoked", "data.deleted": "Deleted all data",
};

export default async function History() {
  const events = [...(await (await getRepo()).listAudit())].reverse();
  return (
    <>
      <PageHeader title="History and audit" lead="Everything Recast did, newest first. This log can be added to but never edited." />
      {events.length === 0 ? <Empty>Nothing has happened yet.</Empty> : (
        <Card>
          <ol className="grid gap-2">
            {events.map((e) => (
              <li key={e.seq} className="flex flex-wrap gap-x-3 border-b border-soft pb-2 last:border-0 last:pb-0">
                <time dateTime={e.at} className="text-xs text-muted">{e.at.replace("T", " ").slice(0, 19)}</time>
                <span className="font-medium">{words[e.action] ?? e.action}</span>
                {e.subject ? <span className="text-muted">{e.subject}</span> : null}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
