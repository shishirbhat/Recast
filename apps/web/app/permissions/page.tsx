import { getRepo } from "@/lib/repo";
import { revokeGrant } from "../actions";
import { Badge, Button, Card, Empty, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Permissions() {
  const repo = await getRepo();
  const [grants, ints] = await Promise.all([repo.listGrants(), repo.listIntegrations()]);
  const app = (d: string) => ints.find((i) => i.destination === d)?.app ?? d;
  return (
    <>
      <PageHeader title="Permissions" lead="What each app has been allowed to do. Revoke any of them at any time." />
      {grants.length === 0 ? <Empty>Nothing has been allowed.</Empty> : (
        <ul className="grid gap-3">
          {grants.map((g) => (
            <li key={g.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-medium">{app(g.destination)} {g.revokedAt ? <Badge tone="danger">Revoked</Badge> : <Badge tone="ok">Allowed</Badge>}</p>
                  <p className="mt-1 text-muted">{g.scope}</p>
                </div>
                {g.revokedAt ? null : <form action={revokeGrant}><input type="hidden" name="id" value={g.id} /><Button variant="danger" aria-label={`Revoke ${app(g.destination)}: ${g.scope}`}>Revoke</Button></form>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
