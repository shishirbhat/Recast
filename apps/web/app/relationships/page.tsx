import { getRepo } from "@/lib/repo";
import { Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Relationships() {
  const repo = await getRepo();
  const [rels, objects] = await Promise.all([repo.listRelationships(), repo.listObjects()]);
  const name = (id: string) => objects.find((o) => o.id === id)?.title ?? id;
  return (
    <>
      <PageHeader title="Relationships" lead="How things were connected, in words: not 'pasted', but 'Meera is an attendee of Launch dinner'." />
      {rels.length === 0 ? <Empty>No relationships yet.</Empty> : (
        <ul className="grid gap-3">
          {rels.map((r) => (
            <li key={r.id}><Card><p><strong className="font-medium">{name(r.fromId)}</strong> <span className="text-muted">is {/^[aeiou]/i.test(r.relation) ? "an" : "a"}</span> <strong className="font-medium text-accent">{r.relation}</strong> <span className="text-muted">of</span> <strong className="font-medium">{name(r.toId)}</strong></p></Card></li>
          ))}
        </ul>
      )}
    </>
  );
}
