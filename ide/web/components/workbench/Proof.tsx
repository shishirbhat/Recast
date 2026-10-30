"use client";

import { useCallback, useState } from "react";
import { ChevronRight, Download, FlaskConical, RotateCcw, Search } from "lucide-react";
import { api, ApiError } from "@/lib/api";

/** Mirrors src/analysis/changeset.ts (the parts shown here). */
interface Changeset {
  source: "agent-worktree" | "shared-project";
  base: { commit: string; kind: "commit" | "relay-snapshot" };
  change: { tree: string; files: { path: string; status: string; inScope: boolean }[] };
  evidence: { id: string; kind: string; command: string | null; exitCode: number | null; source: "system" | "agent"; recordedAt: string; coversThisChange: boolean }[];
  task: { verify: string[] };
  warnings: string[];
  digest: string;
}
interface Repro {
  reproducibility: "not-attempted" | "reproduced" | "different-failure" | "did-not-reproduce";
  rebuildable: { ok: boolean; reason: string | null };
  failingTests: { name: string }[];
  attempts: { at: string; outcome: string }[];
}

const OUTCOME: Record<Repro["reproducibility"], string> = {
  "not-attempted": "not rerun yet",
  reproduced: "reproduced on the same files",
  "different-failure": "fails again, but with different tests",
  "did-not-reproduce": "passed when rerun on the same files (flaky, or depends on something outside the files)",
};

/**
 * Proof and failures for one task, on request: the proof-carrying changeset (download it, see which checks ran on
 * exactly this change) and, for each failing check, a rerun on the exact files it saw and an investigation started
 * from it. Everything is computed by the server; buttons the person can't use say why.
 */
export function ProofPanel({ taskId, canEdit, notify }: { taskId: string; canEdit: boolean; notify: (m: string, tone?: "ok" | "danger") => void }) {
  const [cs, setCs] = useState<Changeset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repro, setRepro] = useState<Record<string, Repro>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const q = encodeURIComponent(taskId);

  const load = useCallback(() => {
    api<Changeset>("GET", `/tasks/${q}/changeset`).then(
      (c) => {
        setCs(c);
        setError(null);
        for (const e of failing(c)) void api<Repro>("GET", `/repro?evidence=${encodeURIComponent(e.id)}`).then((r) => setRepro((m) => ({ ...m, [e.id]: r })), () => {});
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [q]);

  const download = async () => {
    setBusy("download");
    try {
      const c = await api<Changeset>("GET", `/tasks/${q}/changeset`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(c, null, 2) + "\n"], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `${taskId}.changeset.json` });
      a.click();
      URL.revokeObjectURL(url);
      notify(`Saved ${taskId}.changeset.json. Anyone with a clone can check it: relay changeset verify ${taskId}.changeset.json`);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
    }
  };
  const rerun = async (id: string) => {
    setBusy(`run:${id}`);
    try {
      const r = await api<{ outcome: Repro["reproducibility"] }>("POST", "/repro/run", { evidence: id });
      notify(`Rerun on the same files: ${OUTCOME[r.outcome]}.`, r.outcome === "did-not-reproduce" ? "ok" : "danger");
      setRepro((m) => ({ ...m, [id]: { ...m[id]!, reproducibility: r.outcome } }));
      void api<Repro>("GET", `/repro?evidence=${encodeURIComponent(id)}`).then((x) => setRepro((m) => ({ ...m, [id]: x })), () => {});
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
    }
  };
  const investigate = async (id: string) => {
    setBusy(`inv:${id}`);
    try {
      const inv = await api<{ id: string }>("POST", "/repro/investigate", { evidence: id });
      notify(`Started investigation ${inv.id} with the reproduction, failing tests and log. Find it in Records.`);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const viewerWhy = canEdit ? undefined : "Viewers can't run checks or start investigations";
  return (
    <details data-testid="proof" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !cs && load()}>
      <summary className="micro flex cursor-pointer list-none items-center gap-1 text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform [details[open]>summary>&]:rotate-90" />
        Proof and failures
      </summary>
      <div className="mt-2 space-y-3 text-[12.5px]">
        {error && <p className="text-danger">Couldn&apos;t build the changeset: {error}</p>}
        {!cs && !error && <p className="text-muted">Rebuilding the change and matching every check to the files it ran on…</p>}
        {cs && (
          <>
            <div>
              <p className="text-ink-2">
                {cs.change.files.length} {cs.change.files.length === 1 ? "file" : "files"} on {cs.base.kind === "relay-snapshot" ? "a snapshot of the shared project" : `commit ${cs.base.commit.slice(0, 7)}`} · tree <span className="font-mono">{cs.change.tree.slice(0, 10)}</span>
              </p>
              <ul className="mt-1.5 space-y-0.5 font-mono text-[11.5px]" data-testid="proof-checks">
                {cs.task.verify.map((cmd) => {
                  const e = cs.evidence.filter((x) => x.command === cmd && x.source === "system").at(-1);
                  return (
                    <li key={cmd} className={!e ? "text-muted" : e.exitCode === 0 && e.coversThisChange ? "text-ok" : "text-danger"}>
                      {!e ? "·" : e.exitCode === 0 ? "✓" : "✕"} {cmd} <span className="font-sans text-faint">{!e ? "never run" : e.coversThisChange ? "on exactly this change" : "on other files"}</span>
                    </li>
                  );
                })}
                {!cs.task.verify.length && <li className="font-sans text-muted">No verification commands: nothing proves this change works.</li>}
              </ul>
            </div>
            {cs.warnings.length > 0 && (
              <ul className="space-y-0.5 text-ink-2" data-testid="proof-warnings">
                {cs.warnings.map((w) => (
                  <li key={w}>· {w}</li>
                ))}
              </ul>
            )}
            <button onClick={() => void download()} disabled={busy !== null} className="inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
              <Download size={12} /> Download changeset
            </button>

            {failing(cs).map((e) => {
              const r = repro[e.id];
              return (
                <div key={e.id} className="rounded-sm border border-rule px-2.5 py-2" data-testid="failure">
                  <p className="flex items-center gap-1.5 font-mono text-[11.5px] text-danger">
                    <FlaskConical size={12} /> {e.command} <span className="font-sans text-faint">exit {e.exitCode ?? "timeout"} · {new Date(e.recordedAt).toLocaleString()}</span>
                  </p>
                  {r && (
                    <p className="mt-1 text-ink-2" data-testid="reproducibility">
                      {r.failingTests.length > 0 && <>Failing: {r.failingTests.map((t) => t.name).join(", ")}. </>}
                      {r.rebuildable.ok ? <>Reproducibility: {OUTCOME[r.reproducibility]}.</> : <>Can&apos;t be rebuilt: {r.rebuildable.reason}</>}
                    </p>
                  )}
                  <span className="mt-1.5 flex flex-wrap gap-1.5">
                    <button onClick={() => void rerun(e.id)} disabled={!!viewerWhy || busy !== null || (r && !r.rebuildable.ok)} title={viewerWhy ?? (r && !r.rebuildable.ok ? (r.rebuildable.reason ?? undefined) : "Rebuild exactly the files it ran on and run it again")} className="inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
                      <RotateCcw size={12} /> {busy === `run:${e.id}` ? "Running…" : "Rerun on the same files"}
                    </button>
                    <button onClick={() => void investigate(e.id)} disabled={!!viewerWhy || busy !== null} title={viewerWhy ?? "Open an investigation with the reproduction, failing tests and log"} className="inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
                      <Search size={12} /> {busy === `inv:${e.id}` ? "Starting…" : "Start investigation"}
                    </button>
                  </span>
                  {viewerWhy && <p className="mt-1 text-[11.5px] text-faint">{viewerWhy}</p>}
                </div>
              );
            })}
          </>
        )}
      </div>
    </details>
  );
}

/** The latest failing result of each command Relay ran for the task. */
function failing(cs: Changeset) {
  const last = new Map<string, Changeset["evidence"][number]>();
  for (const e of cs.evidence) if (e.kind === "command" && e.source === "system" && e.command) last.set(e.command, e);
  return [...last.values()].filter((e) => e.exitCode !== 0);
}
