import { deleteAll } from "../actions";
import { Button, Card, PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Privacy({ searchParams }: { searchParams: Promise<{ error?: string; deleted?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <PageHeader title="Privacy and data controls" lead="Your data stays on this device unless you turn syncing on. You can take it with you or erase it." />
      <div className="grid gap-4">
        {sp.deleted ? <p role="status" className="rounded-(--r-panel) border border-ok p-4 text-ok">Everything was deleted. One line in History records that it happened.</p> : null}
        <Card>
          <h2 className="font-medium">Export everything</h2>
          <p className="mt-1 text-muted">A single JSON file with your objects, relationships, destinations, permissions and history.</p>
          <a href="/privacy/export" download className="mt-3 inline-flex h-8 items-center rounded-(--r-pill) border border-soft bg-raised px-4 text-xs font-medium hover:bg-sunken">Download JSON</a>
        </Card>
        <Card>
          <h2 className="font-medium">Delete everything</h2>
          <p className="mt-1 text-muted">Removes all objects, relationships, destinations and permissions. This cannot be undone.</p>
          <form action={deleteAll} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-muted">Type DELETE to confirm
              <input name="confirm" autoComplete="off" className="h-8 rounded-(--r-input) border border-line bg-raised px-3 text-sm text-ink" aria-describedby={sp.error ? "err" : undefined} aria-invalid={sp.error ? true : undefined} />
            </label>
            <Button variant="danger">Delete everything</Button>
          </form>
          {sp.error ? <p id="err" role="alert" className="mt-2 text-danger">Nothing was deleted. Type the word DELETE exactly.</p> : null}
        </Card>
      </div>
    </>
  );
}
