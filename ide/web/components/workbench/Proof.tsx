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
interface Share {
  id: string;
  kind: string;
  ref: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
  includesSource: boolean;
}

export function ProofPanel({ taskId, canEdit, isOwner, notify }: { taskId: string; canEdit: boolean; isOwner: boolean; notify: (m: string, tone?: "ok" | "danger") => void }) {
  const [cs, setCs] = useState<Changeset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repro, setRepro] = useState<Record<string, Repro>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const q = encodeURIComponent(taskId);
  const [shares, setShares] = useState<Share[]>([]);
  const [relevant, setRelevant] = useState<{ tests: { file: string; chain: string[] }[]; unreached: string[]; limits: string[]; where: string } | null>(null);
  const runRelevant = async () => {
    if (!relevant) return;
    setBusy("tests");
    try {
      await api("POST", "/tests/run", { files: relevant.tests.map((t) => t.file) });
      notify(`Running ${relevant.tests.length} test file${relevant.tests.length === 1 ? "" : "s"}; results are in the Tests panel.`);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
    }
  };
  const [link, setLink] = useState<string | null>(null);
  const [withSource, setWithSource] = useState(false);
  const loadShares = useCallback(() => {
    if (isOwner) void api<{ shares: Share[] }>("GET", "/shares").then((r) => setShares(r.shares.filter((x) => x.kind === "changeset" && x.ref === taskId)), () => {});
  }, [isOwner, taskId]);
  const share = async () => {
    setBusy("share");
    try {
      const r = await api<{ url: string }>("POST", "/shares", { kind: "changeset", ref: taskId, includeSource: withSource, days: 7 });
      setLink(`${location.origin}${r.url}`);
      notify("Link made. It's shown only now: copy it.");
      loadShares();
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (id: string) => {
    await api("POST", `/shares/${id}/revoke`).then(() => (notify("Link revoked. Anyone opening it now is told so."), loadShares()), (e) => notify(e instanceof ApiError ? e.message : String(e), "danger"));
  };

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
    <details data-testid="proof" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !cs && (load(), loadShares(), void api<NonNullable<typeof relevant>>("GET", `/tasks/${q}/relevant-tests`).then(setRelevant, () => {}))}>
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
            {relevant && (
              <div data-testid="relevant-tests">
                <p className="text-ink-2">
                  {relevant.tests.length ? `${relevant.tests.length} test file${relevant.tests.length === 1 ? "" : "s"} reach${relevant.tests.length === 1 ? "es" : ""} this change through imports:` : "No test reaches this change through imports."}
                </p>
                <ul className="mt-1 space-y-0.5 font-mono text-[11.5px] text-ink-2">
                  {relevant.tests.map((t) => (
                    <li key={t.file} title={t.chain.join(" → ")}>
                      {t.file} <span className="font-sans text-faint">{t.chain.length > 1 ? `via ${t.chain.slice(1).join(" → ")}` : "changed itself"}</span>
                    </li>
                  ))}
                </ul>
                {relevant.unreached.length > 0 && <p className="mt-1 text-[12px] text-warn">Changed code no test reaches: {relevant.unreached.join(", ")}</p>}
                {relevant.tests.length > 0 && (
                  <button
                    onClick={() => void runRelevant()}
                    disabled={!isOwner || relevant.where !== "shared-project" || busy !== null}
                    title={!isOwner ? "Tests run project code on this machine: owners only" : relevant.where !== "shared-project" ? "This change is in the agent's worktree, where Relay already ran its checks; Apply re-checks it on the project" : relevant.limits[0]}
                    className="mt-1.5 h-[26px] rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40"
                  >
                    Run these {relevant.tests.length} test file{relevant.tests.length === 1 ? "" : "s"}
                  </button>
                )}
              </div>
            )}
            <button onClick={() => void download()} disabled={busy !== null} className="inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
              <Download size={12} /> Download changeset
            </button>

            <div className="space-y-1.5" data-testid="share">
              <span className="flex flex-wrap items-center gap-2">
                <button onClick={() => void share()} disabled={!isOwner || busy !== null} title={isOwner ? "A read-only link to this report as it is now, for someone outside the project" : "Only owners share reports outside the project"} className="h-[26px] rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
                  Share a read-only link…
                </button>
                <label className="flex items-center gap-1 text-[12px] text-muted">
                  <input type="checkbox" checked={withSource} disabled={!isOwner} onChange={(e) => setWithSource(e.target.checked)} /> include source changes
                </label>
              </span>
              {!isOwner && <p className="text-[11.5px] text-faint">Only owners share reports outside the project.</p>}
              {link && (
                <p className="flex items-center gap-1.5">
                  <input readOnly value={link} aria-label="Share link" data-testid="share-link" onFocus={(e) => e.currentTarget.select()} className="h-[26px] min-w-0 flex-1 rounded-sm border border-rule bg-editor px-2 font-mono text-[11.5px]" />
                  <button onClick={() => void navigator.clipboard?.writeText(link).then(() => notify("Copied."), () => notify("Couldn't copy; select the link and copy it.", "danger"))} className="h-[26px] rounded-sm border border-rule px-2 text-[12px] text-ink-2">
                    Copy
                  </button>
                </p>
              )}
              {shares.map((x) => (
                <p key={x.id} className="flex items-center gap-2 text-[11.5px] text-faint" data-testid="share-row">
                  <span className="min-w-0 flex-1">
                    {x.createdBy} · {new Date(x.createdAt).toLocaleDateString()} · {x.views} view{x.views === 1 ? "" : "s"} · {x.includesSource ? "with source" : "no source"} · {x.revokedAt ? "revoked" : `expires ${new Date(x.expiresAt).toLocaleDateString()}`}
                  </span>
                  {!x.revokedAt && (
                    <button onClick={() => void revoke(x.id)} className="text-ink-2 hover:text-ink hover:underline">
                      Revoke
                    </button>
                  )}
                </p>
              ))}
            </div>

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
