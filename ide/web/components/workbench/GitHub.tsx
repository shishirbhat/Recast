"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Check, GitMerge, GitPullRequest, Minus, RefreshCw, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";

interface PullRequest {
  number: number;
  url: string;
  title: string;
  branch: string;
  base: string;
  mergeable: boolean | null;
  mergeableState: string | null;
}
interface CheckRow {
  id: string;
  ok: boolean;
  blocking: boolean;
  label: string;
  detail?: string;
}
interface Status {
  connected: boolean;
  reason?: string;
  repo?: { owner: string; name: string; url: string; defaultBranch: string; mergeMethods: string[] };
  branch: string | null;
  changes: { files: number; ahead: number | null };
  pr: PullRequest | null;
  checks: CheckRow[];
}

/**
 * Ship the shared workspace to GitHub. One click ships and merges; or open a pull request and merge it after review.
 * Everything here is decided by the server: the ship gate, the owner-only rule, and the token, which never reaches the browser.
 */
export function GitHubPanel({ canShip, tick, notify }: { canShip: boolean; tick: number; notify: (msg: string, tone?: "ok" | "danger") => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<null | "ship" | "pr" | "merge" | "check">(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api<Status>("GET", "/github").then(setSt, (e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);
  useEffect(load, [load, tick]);

  const fail = (e: unknown) => {
    const msg = e instanceof ApiError ? e.message : String(e);
    setError(msg);
    notify(msg, "danger");
  };

  const ship = async (merge: boolean) => {
    setBusy(merge ? "ship" : "pr");
    setError(null);
    try {
      const r = await api<{ pr: PullRequest; merged?: { sha: string; local: string }; mergeError?: string; secrets: string[] }>("POST", "/github/ship", { title: title.trim() || defaultTitle, merge });
      if (r.merged) notify(`Merged #${r.pr.number} into ${st?.repo?.defaultBranch}. ${r.merged.local}`);
      else if (r.mergeError) (setError(r.mergeError), notify(`Opened #${r.pr.number}, but it didn't merge: ${r.mergeError}`, "danger"));
      else notify(`Opened pull request #${r.pr.number}.`);
      setTitle("");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      load();
    }
  };
  const merge = async () => {
    setBusy("merge");
    setError(null);
    try {
      const r = await api<{ pr: PullRequest; local: string }>("POST", "/github/merge", { number: st?.pr?.number });
      notify(`Merged #${r.pr.number} into ${r.pr.base}. ${r.local}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      load();
    }
  };
  const recheck = async () => {
    setBusy("check");
    await api("POST", "/github/refresh").catch(() => {});
    setBusy(null);
    load();
  };

  if (!st) return <div className="mx-3 my-2 h-[88px] animate-pulse rounded-sm border border-rule bg-sunken/40" aria-label="Loading GitHub status" />;

  const defaultTitle = `Update ${st.changes.files} file${st.changes.files === 1 ? "" : "s"} from Relay`;
  const blocked = st.checks.filter((c) => c.blocking && !c.ok && c.id !== "connected");
  const why = !canShip ? "Only project owners can ship" : blocked.length ? (blocked[0]!.detail ?? blocked[0]!.label) : null;

  return (
    <section aria-label="GitHub" className="mx-3 mb-3 border border-rule bg-editor" data-testid="github-panel">
      <header className="flex h-8 items-center gap-2 border-b border-rule px-2.5">
        <span className={`size-1.5 rounded-full ${st.connected ? "bg-ok" : "bg-faint"}`} />
        <span className="micro text-muted">GitHub</span>
        {st.repo && (
          <a href={st.repo.url} target="_blank" rel="noreferrer" className="ml-auto flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-ink-2 hover:text-accent-ink">
            {st.repo.owner}/{st.repo.name}
            <ArrowUpRight size={11} className="shrink-0" />
          </a>
        )}
      </header>

      {!st.connected ? (
        <div className="space-y-2.5 p-2.5">
          <p className="text-[12px] leading-snug text-muted">{st.reason}</p>
          <p className="font-mono text-[11px] text-faint">export GITHUB_TOKEN=… &nbsp;or&nbsp; gh auth login</p>
          {canShip && (
            <button onClick={recheck} disabled={busy === "check"} className="inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-rule bg-sunken px-2.5 text-[12px] text-ink hover:border-rule-strong hover:bg-hover active:translate-y-px disabled:opacity-50">
              <RefreshCw size={12} className={busy === "check" ? "animate-spin" : ""} /> Check again
            </button>
          )}
        </div>
      ) : st.pr ? (
        <div className="space-y-2.5 p-2.5">
          <a href={st.pr.url} target="_blank" rel="noreferrer" className="group flex items-start gap-2">
            <GitPullRequest size={14} className="mt-px shrink-0 text-ok" />
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] text-ink group-hover:text-accent-ink">{st.pr.title}</span>
              <span className="block truncate font-mono text-[10.5px] text-faint">
                #{st.pr.number} · {st.pr.branch} → {st.pr.base}
              </span>
            </span>
          </a>
          <p className="font-mono text-[10.5px] text-muted">{st.pr.mergeable === false ? `conflicts with ${st.pr.base}` : st.pr.mergeable === null ? "github is checking mergeability" : "ready to merge"}</p>
          <PrimaryButton onClick={merge} disabled={!canShip || busy !== null} title={canShip ? undefined : "Only project owners can merge"} testId="github-merge">
            <GitMerge size={13} /> {busy === "merge" ? "Merging…" : `Merge into ${st.pr.base}`}
          </PrimaryButton>
        </div>
      ) : (
        <div className="space-y-2.5 p-2.5">
          <ul className="space-y-1" aria-label="Ship checks">
            {st.checks
              .filter((c) => c.id !== "connected")
              .map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-[12px]" title={c.detail}>
                  <span className={`mt-[3px] grid size-3 shrink-0 place-items-center rounded-[2px] ${c.ok ? "text-ok" : c.blocking ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}`}>
                    {c.ok ? <Check size={10} strokeWidth={2.5} /> : c.blocking ? <X size={9} strokeWidth={2.5} /> : <Minus size={9} strokeWidth={2.5} />}
                  </span>
                  <span className="min-w-0">
                    <span className={c.ok ? "text-muted" : "text-ink-2"}>{c.label}</span>
                    {!c.ok && c.detail && <span className="block text-[11px] leading-snug text-faint">{c.detail}</span>}
                  </span>
                </li>
              ))}
          </ul>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={defaultTitle}
            aria-label="Pull request title"
            disabled={!canShip}
            className="h-[26px] w-full rounded-sm border border-rule bg-sunken px-2 text-[12.5px] text-ink outline-none placeholder:text-faint focus:border-accent-line disabled:opacity-50"
          />
          <PrimaryButton onClick={() => ship(true)} disabled={!!why || busy !== null} title={why ?? undefined} testId="github-ship-merge">
            <GitMerge size={13} /> {busy === "ship" ? "Shipping and merging…" : `Ship to ${st.repo?.defaultBranch}`}
          </PrimaryButton>
          <button onClick={() => ship(false)} disabled={!!why || busy !== null} title={why ?? undefined} data-testid="github-open-pr" className="flex h-[26px] w-full items-center justify-center gap-1.5 rounded-sm border border-rule text-[12px] text-ink-2 transition-colors hover:border-rule-strong hover:bg-hover hover:text-ink active:translate-y-px disabled:pointer-events-none disabled:opacity-45">
            <GitPullRequest size={12} /> {busy === "pr" ? "Opening…" : "Open pull request for review"}
          </button>
          {why && <p className="font-mono text-[10.5px] text-faint">{why}</p>}
        </div>
      )}
      <AnimatePresence>
        {error && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} role="alert" className="border-t border-rule bg-danger-soft px-2.5 py-1.5 text-[11.5px] leading-snug text-danger">
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </section>
  );
}

function PrimaryButton({ children, onClick, disabled, title, testId }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string; testId?: string }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} data-testid={testId} className="flex h-[28px] w-full items-center justify-center gap-1.5 rounded-sm bg-accent text-[12.5px] font-medium text-accent-fg transition-[filter,transform] hover:brightness-110 active:translate-y-px disabled:pointer-events-none disabled:opacity-40">
      {children}
    </button>
  );
}
