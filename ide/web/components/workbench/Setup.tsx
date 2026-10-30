"use client";

import { useCallback, useEffect, useState } from "react";
import { Play } from "lucide-react";
import { api, ApiError } from "@/lib/api";

/** Mirrors src/analysis/onboarding.ts. */
interface Proposal {
  id: string;
  kind: "verify-command" | "install" | "runtime" | "scope-area" | "note";
  title: string;
  value: string;
  evidence: { file: string; line: number | null; text: string }[];
  status: "proposed" | "accepted" | "dismissed";
  decidedBy: string | null;
  trial: { at: string; by: string; exitCode: number | null; ms: number; output: string } | null;
}

const GROUPS: { kind: Proposal["kind"]; title: string; hint: string }[] = [
  { kind: "verify-command", title: "How to check a change", hint: "Accepted ones become the default checks for new tasks" },
  { kind: "install", title: "Dependencies", hint: "How the project installs what it needs" },
  { kind: "runtime", title: "Runtime", hint: "" },
  { kind: "scope-area", title: "Areas", hint: "Folders that make natural task scopes" },
  { kind: "note", title: "Worth knowing", hint: "" },
];

/**
 * Project setup: what Relay found in the repository, as proposals with the file and line each came from. Commands can
 * be tried on a copy of the current files before anyone relies on them; owners accept or dismiss. Nothing is changed
 * by looking.
 */
export function SetupView({ role, onOpenFile, notify }: { role: "owner" | "editor" | "viewer"; onOpenFile: (p: string) => void; notify: (m: string, tone?: "ok" | "danger") => void }) {
  const [data, setData] = useState<{ proposals: Proposal[]; defaultVerify: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => void api<{ proposals: Proposal[]; defaultVerify: string[] }>("GET", "/onboarding").then(setData, (e) => notify(e instanceof ApiError ? e.message : String(e), "danger")), [notify]);
  useEffect(load, [load]);
  const act = async (key: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) notify(ok(r));
      load();
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
    }
  };
  const isOwner = role === "owner";
  const canTry = role !== "viewer";
  const id = (p: Proposal) => encodeURIComponent(p.id);

  return (
    <div className="flex-1 overflow-y-auto" data-testid="setup">
      <div className="mx-auto max-w-[900px] px-6 pb-16 pt-5">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Project setup</h1>
        <p className="mt-1 text-[12.5px] text-muted">What Relay found in this repository. Each item cites where it came from; nothing is applied until an owner accepts it.</p>
        {!data && <p className="mt-4 text-[13px] text-muted">Reading the repository…</p>}
        {data &&
          GROUPS.map((g) => {
            const items = data.proposals.filter((p) => p.kind === g.kind);
            if (!items.length) return null;
            return (
              <section key={g.kind} className="mt-6" aria-label={g.title}>
                <h2 className="text-[13px] font-semibold text-ink">
                  {g.title} {g.hint && <span className="font-normal text-faint">· {g.hint}</span>}
                </h2>
                <ul className="mt-2 divide-y divide-rule overflow-hidden rounded-md border border-rule">
                  {items.map((p) => (
                    <li key={p.id} className={`bg-editor px-3.5 py-2.5 ${p.status === "dismissed" ? "opacity-50" : ""}`} data-testid="proposal" data-status={p.status}>
                      <div className="flex flex-wrap items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="text-[13px] text-ink">{p.title}</span>
                          {p.status !== "proposed" && <span className="ml-2 text-[11.5px] text-muted">{p.status} by {p.decidedBy}</span>}
                          <span className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
                            {p.evidence.map((e, i) => (
                              <button key={i} onClick={() => !e.file.endsWith("/") && onOpenFile(e.file)} className="font-mono hover:text-ink hover:underline" title={e.text}>
                                {e.file}
                                {e.line ? `:${e.line}` : ""}
                              </button>
                            ))}
                          </span>
                        </span>
                        {(p.kind === "verify-command" || p.kind === "install") && (
                          <button disabled={!canTry || busy !== null} title={canTry ? "Run it on a copy of the current files" : "Viewers can't run commands"} onClick={() => void act(`try:${p.id}`, () => api<Proposal>("POST", `/onboarding/${id(p)}/try`), (r) => `${p.value}: exit ${(r as Proposal).trial?.exitCode ?? "timeout"}`)} className="inline-flex h-[26px] items-center gap-1 rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
                            <Play size={11} /> {busy === `try:${p.id}` ? "Running…" : "Try it"}
                          </button>
                        )}
                        {p.kind !== "note" && p.kind !== "runtime" && p.kind !== "scope-area" && p.status !== "accepted" && (
                          <button disabled={!isOwner || busy !== null} title={isOwner ? undefined : "Owners decide the project's setup"} onClick={() => void act(`a:${p.id}`, () => api("POST", `/onboarding/${id(p)}/decide`, { status: "accepted" }))} className="h-[26px] rounded-sm bg-accent px-2 text-[12px] font-medium text-accent-fg disabled:opacity-40">
                            Accept
                          </button>
                        )}
                        <button disabled={!isOwner || busy !== null} title={isOwner ? undefined : "Owners decide the project's setup"} onClick={() => void act(`d:${p.id}`, () => api("POST", `/onboarding/${id(p)}/decide`, { status: p.status === "proposed" ? "dismissed" : "proposed" }))} className="h-[26px] rounded-sm border border-rule px-2 text-[12px] text-ink-2 disabled:opacity-40">
                          {p.status === "proposed" ? "Dismiss" : "Undo"}
                        </button>
                      </div>
                      {p.trial && (
                        <details className="mt-1.5" data-testid="trial">
                          <summary className={`cursor-pointer text-[12px] ${p.trial.exitCode === 0 ? "text-ok" : "text-danger"}`}>
                            Tried by {p.trial.by}: {p.trial.exitCode === 0 ? "worked" : `exit ${p.trial.exitCode ?? "timeout"}`} in {(p.trial.ms / 1000).toFixed(1)} s on the files as they were then
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-ink-2">{p.trial.output || "(no output)"}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        {data && !isOwner && <p className="mt-4 text-[12px] text-faint">Owners accept or dismiss; anyone who edits can try a command.</p>}
      </div>
    </div>
  );
}
