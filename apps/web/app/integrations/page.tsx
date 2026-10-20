import { getRepo, reliabilityLabel } from "@/lib/repo";
import { setIntegration } from "../actions";
import { Badge, Button, Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Integrations() {
  const list = await (await getRepo()).listIntegrations();
  return (
    <>
      <PageHeader title="Integrations and reliability" lead="Where Recast can place things, and how it does it. We say plainly how dependable each way is." />
      {list.length === 0 ? <Empty>No destinations yet.</Empty> : (
        <ul className="grid gap-3">
          {list.map((i) => {
            const rel = reliabilityLabel[i.reliability]!;
            return (
              <li key={i.destination}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 font-medium">{i.app} <Badge tone={i.reliability === "official-api" ? "ok" : "warn"}>{rel.label}</Badge> {i.enabled ? null : <Badge>Off</Badge>}</p>
                    <p className="mt-1 text-muted">{rel.hint}</p>
                  </div>
                  <form action={setIntegration}>
                    <input type="hidden" name="destination" value={i.destination} /><input type="hidden" name="enabled" value={String(!i.enabled)} />
                    <Button aria-label={`${i.enabled ? "Turn off" : "Turn on"} ${i.app}`}>{i.enabled ? "Turn off" : "Turn on"}</Button>
                  </form>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
