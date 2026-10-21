"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, FileCode2, GitBranch, RefreshCw, TriangleAlert, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Member, ProjectState, RelayEvent } from "@/lib/types";
import { describe } from "../Coordination";
import { GitHubPanel } from "./GitHub";
import { ImpactPanel } from "./Impact";

/* ---------- small shared pieces ---------- */

export function ViewHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center justify-between pl-4 pr-2">
      <span className="text-[13px] font-semibold text-ink">{title}</span>
      <span className="flex items-center">{actions}</span>
    </div>
  );
}

export function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="pt-1 first:pt-0">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="micro flex h-7 w-full items-center gap-1 px-2 text-muted hover:text-ink">
        <span className={`inline-block w-3 text-center text-faint transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        {title}
        {count !== undefined && count > 0 && <span className="tnum ml-auto mr-2 text-[11.5px] font-normal text-faint">{count}</span>}
      </button>
      {open && <div className="pb-1.5">{children}</div>}
    </div>
  );
}

/* ---------- Search ---------- */

interface Hit {
  path: string;
  line: number;
  text: string;
}

interface SearchOpts {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** The client-side twin of the server's matcher, only for highlighting result lines. */
function matcher(q: string, o: SearchOpts): RegExp | null {
  if (!q) return null;
  const body = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(o.wholeWord ? `(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])` : body, o.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

function highlight(text: string, re: RegExp | null, replacement: string | null, regex: boolean) {
  if (!re) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    out.push(text.slice(last, m.index));
    out.push(
      replacement === null ? (
        <mark key={m.index} className="rounded-[3px] bg-attention-soft px-px text-ink ring-1 ring-attention/30">
          {m[0]}
        </mark>
      ) : (
        // Replace preview, as VS Code shows it: the old text struck through, the new text after it.
        <span key={m.index}>
          <del className="bg-danger-soft text-danger decoration-danger/60">{m[0]}</del>
          <ins className="bg-ok-soft text-ok no-underline">{regex ? m[0].replace(new RegExp(re.source, re.flags.replace("g", "")), replacement) : replacement}</ins>
        </span>
      ),
    );
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function Toggle({ on, set, label, children, testId }: { on: boolean; set: (v: boolean) => void; label: string; children: React.ReactNode; testId: string }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={on} data-testid={testId} onClick={() => set(!on)} className={`grid h-[20px] min-w-[22px] place-items-center rounded-sm px-0.5 font-mono text-[11px] ${on ? "bg-accent-soft text-accent-ink ring-1 ring-accent-line" : "text-muted hover:bg-hover hover:text-ink"}`}>
      {children}
    </button>
  );
}

/** Find and Replace in Files, as VS Code's Search view: match case, whole word and regex toggles; replace per file or all. */
export function SearchView({ onOpen, focusNonce, canEdit, notify, replaceNonce = 0 }: { onOpen: (path: string, line?: number) => void; focusNonce: number; canEdit: boolean; notify: (msg: string, tone?: "ok" | "danger" | "attention") => void; replaceNonce?: number }) {
  const [q, setQ] = useState("");
  const [rep, setRep] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [opts, setOpts] = useState<SearchOpts>({ matchCase: false, wholeWord: false, regex: false });
  const [res, setRes] = useState<{ hits: Hit[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const repInput = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [focusNonce]);
  useEffect(() => {
    if (!replaceNonce) return;
    setShowReplace(true);
    requestAnimationFrame(() => repInput.current?.focus());
  }, [replaceNonce]);
  useEffect(() => {
    setDismissed(new Set());
    if (!q.trim()) return (setRes(null), setError(null));
    setBusy(true);
    const t = setTimeout(() => {
      const flags = `${opts.matchCase ? "&case=1" : ""}${opts.wholeWord ? "&word=1" : ""}${opts.regex ? "&regex=1" : ""}`;
      api<{ hits: Hit[]; truncated: boolean }>("GET", `/search?q=${encodeURIComponent(q)}${flags}`)
        .then((r) => (setRes(r), setError(null)), (e) => (setRes(null), setError(e instanceof Error ? e.message : String(e))))
        .finally(() => setBusy(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q, opts, tick]);
  const groups = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of res?.hits ?? []) if (!dismissed.has(h.path)) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m.entries()];
  }, [res, dismissed]);
  const re = useMemo(() => matcher(q, opts), [q, opts]);
  const replaceReason = !canEdit ? "Viewers can't change files" : !groups.length ? "Nothing to replace" : res?.truncated ? "Too many results to replace at once; narrow the search" : null;

  /** Replace in the given files: counted first, confirmed, then applied to the shared documents. */
  const replaceIn = async (paths: string[]) => {
    const body = { query: q, replacement: rep, paths, ...opts };
    try {
      const dry = await api<{ files: { path: string }[]; replacements: number }>("POST", "/replace", { ...body, dryRun: true });
      if (!dry.replacements) return notify("Nothing left to replace: the files changed since the search.", "attention");
      const n = dry.files.length;
      if (!confirm(`Replace ${dry.replacements} ${dry.replacements === 1 ? "occurrence" : "occurrences"} across ${n} ${n === 1 ? "file" : "files"} with "${rep}"?\n\nOpen editors update for everyone, and the change is credited to you.`)) return;
      const done = await api<{ replacements: number; files: { path: string }[] }>("POST", "/replace", body);
      notify(`Replaced ${done.replacements} ${done.replacements === 1 ? "occurrence" : "occurrences"} in ${done.files.length} ${done.files.length === 1 ? "file" : "files"}.`);
      setTick((t) => t + 1);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "danger");
    }
  };

  const toggles = (
    <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
      <Toggle on={opts.matchCase} set={(v) => setOpts((o) => ({ ...o, matchCase: v }))} label="Match Case" testId="search-case">
        Aa
      </Toggle>
      <Toggle on={opts.wholeWord} set={(v) => setOpts((o) => ({ ...o, wholeWord: v }))} label="Match Whole Word" testId="search-word">
        <span className="underline decoration-1 underline-offset-2">ab</span>
      </Toggle>
      <Toggle on={opts.regex} set={(v) => setOpts((o) => ({ ...o, regex: v }))} label="Use Regular Expression" testId="search-regex">
        .*
      </Toggle>
    </span>
  );
  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Search"
        actions={
          <button aria-label="Refresh results" title="Refresh results" onClick={() => setTick((t) => t + 1)} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
            <RefreshCw size={13} />
          </button>
        }
      />
      <div className="flex gap-1 pb-2 pl-1 pr-3">
        <button aria-label={showReplace ? "Hide replace" : "Toggle Replace"} title="Toggle Replace" aria-expanded={showReplace} data-testid="search-toggle-replace" onClick={() => setShowReplace((v) => !v)} className="grid w-5 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
          <span className={`inline-block transition-transform ${showReplace ? "rotate-90" : ""}`}>›</span>
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="relative">
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              data-testid="search-input"
              className="h-7.5 w-full rounded-md border border-rule bg-editor pl-2.5 pr-[78px] text-[13px] outline-none focus:border-accent focus-visible:outline-none"
            />
            {toggles}
          </div>
          {showReplace && (
            <div className="flex items-center gap-1">
              <input
                ref={repInput}
                value={rep}
                onChange={(e) => setRep(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && !replaceReason && void replaceIn(groups.map(([p]) => p))}
                placeholder="Replace"
                data-testid="replace-input"
                className="h-7.5 min-w-0 flex-1 rounded-md border border-rule bg-editor px-2.5 text-[13px] outline-none focus:border-accent focus-visible:outline-none"
              />
              <button
                aria-label="Replace All"
                title={replaceReason ?? "Replace All (Ctrl+Enter)"}
                disabled={!!replaceReason}
                data-testid="replace-all"
                onClick={() => void replaceIn(groups.map(([p]) => p))}
                className="h-7.5 shrink-0 rounded-md px-2 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink disabled:text-faint disabled:hover:bg-transparent"
              >
                Replace All
              </button>
            </div>
          )}
          <p className={`text-[11.5px] ${error ? "text-danger" : "text-muted"}`}>
            {error ?? (busy ? "Searching…" : res ? `${groups.reduce((n, [, h]) => n + h.length, 0)}${res.truncated ? "+" : ""} results in ${groups.length} files` : "Searches the shared files everyone sees")}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groups.map(([path, hits]) => (
          <div key={path}>
            <div className="group flex h-6 items-center hover:bg-hover">
              <button onClick={() => onOpen(path)} className="flex min-w-0 flex-1 items-center gap-1.5 pl-3 text-[13px]">
                <FileCode2 size={13} className="shrink-0 text-faint" />
                <span className="font-medium text-ink">{path.split("/").pop()}</span>
                <span className="truncate text-[11.5px] text-faint">{path.split("/").slice(0, -1).join("/")}</span>
              </button>
              {showReplace && (
                <button aria-label={`Replace in ${path}`} title={replaceReason ?? `Replace in ${path}`} disabled={!!replaceReason} onClick={() => void replaceIn([path])} className="hidden h-5 rounded-sm px-1 text-[11px] text-muted hover:bg-sunken hover:text-ink group-hover:block disabled:text-faint">
                  Replace
                </button>
              )}
              <button aria-label={`Dismiss ${path}`} title="Dismiss (leave this file out)" onClick={() => setDismissed((d) => new Set(d).add(path))} className="hidden size-5 place-items-center rounded-sm text-muted hover:bg-sunken hover:text-ink group-hover:grid">
                <X size={12} />
              </button>
              <span className="tnum mx-2 rounded-sm border border-rule px-1 text-[10px] text-muted">{hits.length}</span>
            </div>
            {hits.map((h) => (
              <button key={h.line} onClick={() => onOpen(h.path, h.line)} className="flex h-6 w-full items-center gap-2 pl-8 pr-3 text-left font-mono text-[12px] text-ink-2 hover:bg-hover">
                <span className="w-7 shrink-0 text-right text-faint">{h.line}</span>
                <span className="truncate">{highlight(h.text.trimStart(), re, showReplace && rep !== "" ? rep : showReplace ? "" : null, opts.regex)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Source control ---------- */

interface GitFile {
  path: string;
  staged: string | null;
  unstaged: string | null;
}
interface GitStateResp {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFile[];
  conflicted: string[];
  hasRemote: boolean;
  branches: { name: string; current: boolean }[];
  log: { sha: string; author: string; date: string; subject: string }[];
}
const LETTER_CLS: Record<string, string> = { M: "text-warn", A: "text-ok", "?": "text-ok", D: "text-danger", R: "text-accent-ink", U: "text-danger" };

/** Source control: real git status, staged and unstaged diffs, stage/unstage, commit, branches, pull/push, history. */
export function SourceControlView({ onOpen, onDiff, tick, canShip, canEdit, notify }: { onOpen: (path: string) => void; onDiff: (path: string, staged: boolean) => void; tick: number; canShip: boolean; canEdit: boolean; notify: (msg: string, tone?: "ok" | "danger") => void }) {
  const [st, setSt] = useState<GitStateResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const load = () => void api<GitStateResp>("GET", "/git/state").then((x) => (setSt(x), setErr(null)), (e) => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(load, [tick]);
  const run = async (label: string, method: "POST", path: string, body?: unknown, done?: string) => {
    setBusy(label);
    try {
      const r = await api<{ message?: string; sha?: string }>(method, path, body);
      notify(done ?? r.message ?? `${label} done.`);
      return r;
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "danger");
      return null;
    } finally {
      setBusy(null);
      load();
    }
  };
  const staged = st?.files.filter((f) => f.staged && f.staged !== "U") ?? [];
  const changes = st?.files.filter((f) => f.unstaged && f.staged !== "U") ?? [];
  const commit = async () => {
    const r = await run("Commit", "POST", "/git/commit", { message: msg });
    if (r?.sha) (notify(`Committed ${r.sha}.`), setMsg(""));
  };
  const row = (f: GitFile, side: "staged" | "unstaged") => {
    const letter = side === "staged" ? f.staged! : f.unstaged === "?" ? "U" : f.unstaged!;
    return (
      <div key={`${side}:${f.path}`} className="group flex h-6 items-center gap-1.5 pl-5 pr-2 text-[13px] hover:bg-hover" data-testid={`scm-${side}-${f.path}`}>
        <button onClick={() => (f.unstaged === "?" && side === "unstaged" ? onOpen(f.path) : onDiff(f.path, side === "staged"))} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={side === "staged" ? "Show staged diff" : "Show working-tree diff"}>
          <FileCode2 size={13} className="shrink-0 text-faint" />
          <span className={letter === "D" ? "text-muted line-through" : "text-ink"}>{f.path.split("/").pop()}</span>
          <span className="truncate text-[11.5px] text-faint">{f.path.split("/").slice(0, -1).join("/")}</span>
        </button>
        {canEdit && (
          <button aria-label={side === "staged" ? `Unstage ${f.path}` : `Stage ${f.path}`} title={side === "staged" ? "Unstage" : "Stage"} onClick={() => void run(side === "staged" ? "Unstage" : "Stage", "POST", `/git/${side === "staged" ? "unstage" : "stage"}`, { paths: [f.path] }, `${side === "staged" ? "Unstaged" : "Staged"} ${f.path}.`)} className="grid size-5 place-items-center rounded-sm font-mono text-[13px] text-muted opacity-0 hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover:opacity-100">
            {side === "staged" ? "−" : "+"}
          </button>
        )}
        <span className={`w-3 text-center font-mono text-[11.5px] font-bold ${LETTER_CLS[letter] ?? "text-muted"}`} title={letter === "U" && f.unstaged === "?" ? "untracked" : undefined}>
          {f.unstaged === "?" && side === "unstaged" ? "U" : letter}
        </span>
      </div>
    );
  };
  return (
    <div className="flex h-full flex-col" data-testid="scm-view">
      <ViewHeader
        title="Source Control"
        actions={
          <button aria-label="Refresh" title="Refresh" onClick={load} className="grid size-6 place-items-center rounded text-muted hover:bg-hover hover:text-ink">
            <RefreshCw size={13} />
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {err && <p className="px-4 pb-2 text-[12px] text-danger">{err}</p>}
        <div className="space-y-2 px-3 pb-3">
          <div className="flex items-center gap-1.5 text-[12px]">
            <GitBranch size={12} className="text-muted" />
            <select
              aria-label="Branch"
              value={st?.branch ?? ""}
              disabled={!canShip || !st || busy !== null}
              title={canShip ? "Switch branch" : "Only project owners can switch branches (it changes files for everyone)"}
              onChange={(e) => void run("Switch", "POST", "/git/switch", { name: e.target.value })}
              className="h-[24px] min-w-0 flex-1 rounded-sm border border-rule bg-editor px-1 font-mono text-[12px] text-ink disabled:opacity-60"
              data-testid="branch-select"
            >
              {!st?.branch && <option value="">detached {st?.head}</option>}
              {st?.branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            {canEdit && (
              <button onClick={() => setNewBranch(newBranch === null ? "" : null)} className="h-[24px] shrink-0 rounded-sm border border-rule px-2 text-[11.5px] text-ink-2 hover:bg-hover">
                New
              </button>
            )}
          </div>
          {newBranch !== null && (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void run("Branch", "POST", "/git/branch", { name: newBranch, switch: canShip }, canShip ? `Created and switched to ${newBranch}.` : `Created ${newBranch}.`).then(() => setNewBranch(null));
              }}
            >
              <input autoFocus value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="feature/name" aria-label="New branch name" className="h-[24px] min-w-0 flex-1 rounded-sm border border-rule bg-sunken px-2 font-mono text-[12px] outline-none focus:border-accent" />
              <button disabled={!newBranch.trim()} className="h-[24px] rounded-sm bg-accent px-2 text-[11.5px] text-accent-fg disabled:opacity-40">
                {canShip ? "Create + switch" : "Create"}
              </button>
            </form>
          )}
          {st?.upstream && (
            <p className="tnum font-mono text-[10.5px] text-faint">
              {st.upstream} · ↑{st.ahead ?? 0} ↓{st.behind ?? 0}
            </p>
          )}
          {canEdit && (
            <>
              <textarea
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && staged.length && msg.trim()) (e.preventDefault(), void commit());
                }}
                rows={2}
                placeholder={staged.length ? "Commit message (Ctrl+Enter)" : "Stage changes to commit"}
                aria-label="Commit message"
                className="w-full resize-none rounded-sm border border-rule bg-sunken px-2 py-1 text-[12.5px] outline-none focus:border-accent"
                data-testid="commit-message"
              />
              <button onClick={() => void commit()} disabled={!staged.length || !msg.trim() || busy !== null} className="flex h-[26px] w-full items-center justify-center rounded-sm bg-accent text-[12.5px] font-medium text-accent-fg hover:brightness-110 active:translate-y-px disabled:opacity-40" data-testid="commit">
                {busy === "Commit" ? "Committing…" : `Commit ${staged.length ? `${staged.length} staged file${staged.length > 1 ? "s" : ""}` : ""}`}
              </button>
            </>
          )}
          {st?.hasRemote && canShip && (
            <div className="flex gap-1.5">
              <button onClick={() => void run("Pull", "POST", "/git/pull")} disabled={busy !== null} className="h-[24px] flex-1 rounded-sm border border-rule text-[11.5px] text-ink-2 hover:bg-hover disabled:opacity-40">
                {busy === "Pull" ? "Pulling…" : "Pull"}
              </button>
              <button onClick={() => void run("Push", "POST", "/git/push")} disabled={busy !== null} className="h-[24px] flex-1 rounded-sm border border-rule text-[11.5px] text-ink-2 hover:bg-hover disabled:opacity-40">
                {busy === "Push" ? "Pushing…" : "Push"}
              </button>
            </div>
          )}
        </div>
        {st && st.conflicted.length > 0 && (
          <Section title="Merge conflicts" count={st.conflicted.length}>
            {st.conflicted.map((p) => (
              <button key={p} onClick={() => onOpen(p)} className="flex h-6 w-full items-center gap-1.5 pl-5 pr-3 text-[13px] text-danger hover:bg-hover">
                <TriangleAlert size={12} /> {p}
              </button>
            ))}
          </Section>
        )}
        <Section title="Staged changes" count={staged.length}>
          {staged.length === 0 && <p className="px-5 py-1 text-[12px] text-muted">Nothing staged.</p>}
          {staged.map((f) => row(f, "staged"))}
        </Section>
        <Section title="Changes" count={changes.length}>
          {changes.length === 0 && <p className="px-5 py-1 text-[12px] text-muted">Working tree clean.</p>}
          {changes.length > 1 && canEdit && (
            <button onClick={() => void run("Stage", "POST", "/git/stage", { paths: changes.map((f) => f.path) }, `Staged ${changes.length} files.`)} className="ml-5 text-[11.5px] text-accent-ink hover:underline">
              Stage all
            </button>
          )}
          {changes.map((f) => row(f, "unstaged"))}
        </Section>
        <GitHubPanel canShip={canShip} tick={tick} notify={notify} />
        <Section title="Recent commits" count={st?.log.length} defaultOpen={false}>
          {st?.log.map((c) => (
            <div key={c.sha} className="px-5 py-1">
              <p className="truncate text-[12.5px] text-ink-2">{c.subject}</p>
              <p className="font-mono text-[10.5px] text-faint">
                {c.sha} · {c.author} · {new Date(c.date).toLocaleDateString()}
              </p>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

/* ---------- Problems: Relay's coordination problems, in the place IDEs show diagnostics ---------- */

export interface Problem {
  severity: "error" | "warning";
  text: string;
  taskId?: string;
  path?: string;
}

export function problemsOf(state: ProjectState): Problem[] {
  const out: Problem[] = [];
  const current = new Map(state.contracts.map((c) => [c.id, c.history.filter((h) => h.status === "accepted").at(-1)?.version]));
  for (const t of state.tasks) {
    if (t.state === "completed" || t.state === "cancelled") continue;
    for (const [cid, v] of Object.entries(t.contracts)) {
      const cur = current.get(cid);
      if (cur !== undefined && cur > v) out.push({ severity: "error", text: `${t.id} is built on ${cid} v${v}; the accepted contract is v${cur}`, taskId: t.id });
    }
    if (t.state === "blocked") out.push({ severity: "error", text: `${t.id} is blocked`, taskId: t.id });
    if (t.state === "failed") out.push({ severity: "warning", text: `${t.id} failed and can be requeued`, taskId: t.id });
    for (const r of t.runs) for (const s of r.staleInputs) out.push({ severity: "warning", text: `${s.by} edited ${s.path} after the agent on ${t.id} started`, taskId: t.id, path: s.path });
  }
  for (const c of state.conflicts) out.push({ severity: "error", text: `An outside edit to ${c.doc.replace(/^file:/, "")} conflicted with the shared copy and was kept for review`, path: c.doc.replace(/^file:/, "") });
  for (const c of state.contracts) for (const h of c.history) if (h.status === "proposed") out.push({ severity: "warning", text: `${c.id} v${h.version} is proposed and waiting for an owner`, taskId: undefined });
  return out;
}

export type PanelTab = "terminal" | "problems" | "tests" | "impact" | "output" | "activity";

export function BottomPanel({ tab, setTab, state, events, members, onTask, onOpen, onClose, terminal, output, tests, testFailures = 0, syntax = [] }: { tab: PanelTab; setTab: (t: PanelTab) => void; state: ProjectState; events: RelayEvent[]; members: Member[]; onTask: (id: string) => void; onOpen: (p: string, line?: number) => void; onClose: () => void; terminal: React.ReactNode; output: React.ReactNode; tests: React.ReactNode; testFailures?: number; syntax?: { path: string; line: number; col: number; message: string }[] }) {
  const problems = [...syntax.map((p) => ({ severity: "error" as const, text: `${p.path}:${p.line}:${p.col} ${p.message}`, path: p.path, line: p.line, taskId: undefined as string | undefined })), ...problemsOf(state)];
  const tabs: [PanelTab, string, number?][] = [
    ["terminal", "Terminal"],
    ["problems", "Problems", problems.length],
    ["tests", "Tests", testFailures],
    ["impact", "Impact"],
    ["output", "Output"],
    ["activity", "Activity"],
  ];
  return (
    <div className="flex h-full flex-col bg-editor">
      <div role="tablist" aria-label="Panel" className="flex h-[34px] shrink-0 items-center gap-5 pl-4 pr-2">
        {tabs.map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} data-testid={`panel-tab-${id}`} onClick={() => setTab(id)} className={`micro relative flex h-full items-center gap-1.5 transition-colors ${tab === id ? "text-ink" : "text-faint hover:text-ink-2"}`}>
            {label}
            {!!n && <span className={`tnum rounded-sm px-1 font-mono text-[10px] ${id === "problems" || id === "tests" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-ink"}`}>{n}</span>}
            {tab === id && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" />}
          </button>
        ))}
        <button aria-label="Close panel" title="Close panel" onClick={onClose} className="ml-auto grid size-6 place-items-center rounded text-muted hover:bg-hover hover:text-ink">
          <X size={14} />
        </button>
      </div>
      {/* The terminal stays mounted while other tabs are shown, so its sessions keep running. */}
      <div className={`min-h-0 flex-1 ${tab === "terminal" ? "" : "hidden"}`}>{terminal}</div>
      {tab === "tests" && <div className="min-h-0 flex-1">{tests}</div>}
      {tab === "output" && <div className="min-h-0 flex-1 overflow-y-auto">{output}</div>}
      {tab === "impact" && (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <ImpactPanel tick={events.length} onOpen={onOpen} onTask={onTask} />
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto py-1 font-mono text-[12.5px] ${tab === "terminal" || tab === "output" || tab === "impact" || tab === "tests" ? "hidden" : ""}`}>
        {tab === "problems" &&
          (problems.length === 0 ? (
            <p className="px-4 py-2 font-sans text-[13px] text-muted">No problems. The open file parses, and contracts, tasks and shared files agree.</p>
          ) : (
            problems.map((p, i) => (
              <button key={i} onClick={() => (p.taskId ? onTask(p.taskId) : p.path && onOpen(p.path, "line" in p ? (p.line as number) : undefined))} className="flex w-full items-center gap-2 px-4 py-1 text-left hover:bg-hover">
                {p.severity === "error" ? <CircleAlert size={13} className="shrink-0 text-danger" /> : <TriangleAlert size={13} className="shrink-0 text-warn" />}
                <span className="font-sans text-[13px] text-ink-2">{p.text}</span>
                {p.taskId && <span className="ml-auto text-[11.5px] text-faint">{p.taskId}</span>}
              </button>
            ))
          ))}
        {tab === "activity" &&
          events
            .slice(-200)
            .reverse()
            .map((e) => (
              <div key={e.id} className="flex gap-3 px-4 py-0.5 hover:bg-hover">
                <span className="w-16 shrink-0 text-faint">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className={`font-sans text-[13px] ${e.type === "enforcement.decision" && e.data.decision === "deny" ? "text-danger" : "text-ink-2"}`}>{describe(e, members)}</span>
              </div>
            ))}
      </div>
    </div>
  );
}
