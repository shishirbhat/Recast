"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CircleAlert, Radar as RadarIcon, TriangleAlert, Info } from "lucide-react";
import { api, ApiError } from "@/lib/api";

/** Mirrors src/analysis/radar.ts. Alerts are computed on the server from evidence only; nothing here changes a task. */
type AlertAction = { kind: "check-together"; tasks: string[] } | { kind: "open-diff"; task: string; path: string } | { kind: "open-task"; task: string } | { kind: "open-file"; path: string } | { kind: "run-checks"; task: string } | { kind: "apply"; task: string };
export interface RadarAlert {
  id: string;
  kind: string;
  certainty: "known" | "suspected";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  tasks: string[];
  files: string[];
  evidence: { at: string | null; source: "git" | "engine" | "agent-run" | "editing" | "static-analysis"; text: string }[];
  since: string | null;
  options: { label: string; action: AlertAction; disabled?: string }[];
}
export interface RadarData {
  computedAt: string;
  alerts: RadarAlert[];
  limits: string[];
}
interface OwnedFile {
  path: string;
  scopeOwners: string[];
  changes: { task: string | null; by: string; where: "agent-worktree" | "shared-project"; worktree?: string; at: string | null }[];
  contested: boolean;
}

const SOURCE: Record<RadarAlert["evidence"][number]["source"], string> = {
  git: "git",
  engine: "Relay's records",
  "agent-run": "agent run",
  editing: "live editing",
  "static-analysis": "static analysis",
};
const CERTAINTY = {
  known: "Known: Relay can show this fact (a diff, a merge, a record).",
  suspected: "Suspected: evidence points to a problem, but nothing has run to prove it (for example static analysis, or edits that merge as text but haven't been tested together).",
};
const SEVERITY = {
  high: { label: "High", icon: CircleAlert, cls: "text-danger" },
  medium: { label: "Medium", icon: TriangleAlert, cls: "text-warn" },
  low: { label: "Low", icon: Info, cls: "text-muted" },
};

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

/**
 * Conflict Radar and the changed-file ownership map, inside the Coordination tab. Collapsed to one line per alert; the
 * evidence opens on request. Every action is an existing endpoint or navigation; checks the server would refuse are
 * shown disabled with the reason it gives.
 */
export function RadarPanel({ tick, role, chip, onOpenTask, onOpenFile, onOpenDiff, notify, onChanged }: { tick: number; role: "owner" | "editor" | "viewer"; chip: (id: string) => React.ReactNode; onOpenTask: (id: string) => void; onOpenFile: (p: string) => void; onOpenDiff: (task: string, path: string) => void; notify: (m: string, tone?: "ok" | "danger" | "attention") => void; onChanged: () => void }) {
  const [data, setData] = useState<RadarData | null>(null);
  const [files, setFiles] = useState<OwnedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api<RadarData>("GET", "/radar").then(
      (d) => (setData(d), setError(null)),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
    api<{ files: OwnedFile[] }>("GET", "/ownership").then((d) => setFiles(d.files), () => setFiles(null));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [tick, load]);

  const run = async (a: RadarAlert, o: RadarAlert["options"][number]) => {
    const act = o.action;
    if (act.kind === "open-diff") return onOpenDiff(act.task, act.path);
    if (act.kind === "open-task") return onOpenTask(act.task);
    if (act.kind === "open-file") return onOpenFile(act.path);
    setBusy(`${a.id}:${o.label}`);
    try {
      if (act.kind === "check-together") {
        const r = await api<{ status: string; report: string }>("POST", "/integrations/check", { tasks: act.tasks });
        notify(r.status === "passed" ? `${act.tasks.join(" and ")} passed together. Nothing was applied; an owner approves it from the task.` : `${act.tasks.join(" and ")} are blocked together. ${r.report.split("\n").find((l) => l.trim() && !/^#/.test(l)) ?? ""}`, r.status === "passed" ? "ok" : "danger");
      } else if (act.kind === "run-checks") {
        const r = await api<{ verification: { exitCode: number | null }[] }>("POST", `/tasks/${encodeURIComponent(act.task)}/check`);
        const failed = r.verification.filter((v) => v.exitCode !== 0).length;
        notify(failed ? `${act.task}: ${failed} check${failed === 1 ? "" : "s"} failed.` : `${act.task}: checks passed on the current files.`, failed ? "danger" : "ok");
      }
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
      load();
      onChanged();
    }
  };
  const viewerReason = (o: RadarAlert["options"][number]) => (role === "viewer" && (o.action.kind === "check-together" || o.action.kind === "run-checks") ? "Viewers can't run checks" : o.disabled);

  const high = data?.alerts.filter((a) => a.severity === "high").length ?? 0;
  const contested = files?.filter((f) => f.contested).length ?? 0;
  return (
    <section aria-label="Conflict radar" className="mt-5" data-testid="radar">
      <h2 className="flex flex-wrap items-baseline gap-2 text-[13px] font-semibold text-ink">
        <RadarIcon size={13} className="self-center text-muted" aria-hidden />
        Conflict radar
        {data && (
          <span className="text-[12px] font-normal text-faint">
            {data.alerts.length ? `${data.alerts.length} ${data.alerts.length === 1 ? "alert" : "alerts"}${high ? `, ${high} high` : ""}` : "nothing to warn about"} · checked {ago(data.computedAt)}
          </span>
        )}
      </h2>
      {error && !data && <p className="mt-2 text-[12.5px] text-danger">Couldn&apos;t load the radar: {error}</p>}
      {!data && !error && <p className="mt-2 text-[12.5px] text-muted">Comparing the work in progress…</p>}
      {data && data.alerts.length > 0 && (
        <ul className="mt-2 divide-y divide-rule overflow-hidden rounded-md border border-rule" data-testid="radar-alerts">
          {data.alerts.map((a) => {
            const sev = SEVERITY[a.severity];
            const Icon = sev.icon;
            return (
              <li key={a.id} className="bg-editor" data-testid="radar-alert" data-kind={a.kind} data-certainty={a.certainty}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-start gap-2.5 px-3.5 py-2.5 hover:bg-hover [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={13} className="mt-[3px] shrink-0 text-faint transition-transform group-open:rotate-90" aria-hidden />
                    <Icon size={14} className={`mt-[2px] shrink-0 ${sev.cls}`} aria-label={`${sev.label} severity`} />
                    <span className="min-w-0 flex-1">
                      <span className="text-[13px] text-ink">{a.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
                        <span title={CERTAINTY[a.certainty]} className={`rounded-sm border px-1 py-px font-medium ${a.certainty === "known" ? "border-rule-strong text-ink-2" : "border-dashed border-rule-strong text-muted"}`}>
                          {a.certainty === "known" ? "Known" : "Suspected"}
                        </span>
                        <span>{sev.label}</span>
                        {a.since && <span>since {ago(a.since)}</span>}
                      </span>
                    </span>
                  </summary>
                  <div className="space-y-2.5 px-3.5 pb-3 pl-[52px]">
                    <p className="text-[12.5px] leading-relaxed text-ink-2">{a.detail}</p>
                    <span className="flex flex-wrap gap-1">{a.tasks.map(chip)}</span>
                    <div>
                      <span className="text-[11.5px] font-medium text-muted">Evidence</span>
                      <ul className="mt-1 space-y-1" data-testid="radar-evidence">
                        {a.evidence.map((e, i) => (
                          <li key={i} className="flex gap-2 text-[12px] text-ink-2">
                            <span className="w-[104px] shrink-0 text-faint">{SOURCE[e.source]}</span>
                            <span className="min-w-0 flex-1 break-words font-mono text-[11.5px]">{e.text}</span>
                            {e.at && <span className="shrink-0 text-faint" title={e.at}>{ago(e.at)}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {a.options.map((o) => {
                        const reason = viewerReason(o);
                        return (
                          <button key={o.label} onClick={() => void run(a, o)} disabled={!!reason || busy !== null} title={reason ?? o.label} className="h-[26px] rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
                            {busy === `${a.id}:${o.label}` ? "Working…" : o.label}
                          </button>
                        );
                      })}
                    </div>
                    {a.options.some((o) => viewerReason(o)) && (
                      <p className="text-[11.5px] text-faint">{a.options.map(viewerReason).filter(Boolean).join(" · ")}</p>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {data && (
        <details className="mt-2 text-[11.5px] text-faint">
          <summary className="cursor-pointer">What the radar can&apos;t see</summary>
          <ul className="mt-1 list-disc pl-5">
            {data.limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      )}

      {files && files.length > 0 && (
        <details className="mt-4" data-testid="ownership">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink">
            Changed files and who owns them <span className="font-normal text-faint">{files.length}{contested ? `, ${contested} contested` : ""}</span>
          </summary>
          <table className="mt-2 w-full border-collapse overflow-hidden rounded-md border border-rule text-left text-[12px]">
            <thead className="bg-panel text-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">File</th>
                <th className="px-3 py-1.5 font-medium">Owned by (scope)</th>
                <th className="px-3 py-1.5 font-medium">Changed by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {files.map((f) => (
                <tr key={f.path} className="bg-editor align-top" data-testid={`owned-${f.path}`}>
                  <td className="px-3 py-1.5">
                    <button onClick={() => onOpenFile(f.path)} className="font-mono text-[11.5px] text-ink-2 hover:text-ink hover:underline">
                      {f.path}
                    </button>
                    {f.contested && <span className="ml-2 rounded-sm border border-warn px-1 text-[11px] text-warn">contested</span>}
                  </td>
                  <td className="px-3 py-1.5">{f.scopeOwners.length ? <span className="flex flex-wrap gap-1">{f.scopeOwners.map(chip)}</span> : <span className="text-faint">no task</span>}</td>
                  <td className="space-y-0.5 px-3 py-1.5 text-ink-2">
                    {f.changes.map((c, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-1.5">
                        {c.task && chip(c.task)}
                        <span>{c.by.replace(/^agent:/, "agent ")}</span>
                        <span className="text-faint">{c.where === "agent-worktree" ? `in ${c.worktree ?? "its worktree"}` : "in the shared project"}</span>
                        {c.at && <span className="text-faint">{ago(c.at)}</span>}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
