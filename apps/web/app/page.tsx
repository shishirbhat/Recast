import { getRepo } from "@/lib/repo";
import { deleteObject } from "./actions";
import { Badge, Button, Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Objects() {
  const objects = await (await getRepo()).listObjects();
  return (
    <>
      <PageHeader title="Objects" lead="Things Recast has understood. Each one keeps where it came from. The originals are never changed." />
      {objects.length === 0 ? <Empty>Nothing here yet. Lift something and it will appear.</Empty> : (
        <ul className="grid gap-3">
          {objects.map((o) => (
            <li key={o.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-medium">{o.title} <Badge>{o.kind}</Badge></p>
                  <p className="mt-1 text-muted">{Object.values(o.data).join(" · ")}</p>
                  {o.source ? <p className="mt-1 text-xs text-muted">From: {o.source}</p> : null}
                </div>
                <form action={deleteObject}><input type="hidden" name="id" value={o.id} /><Button variant="danger" aria-label={`Forget ${o.title}`}>Forget</Button></form>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
