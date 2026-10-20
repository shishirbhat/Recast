"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, Bot, ChevronDown, CircleAlert, FileCode2, Plus, ShieldCheck, Terminal, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fuzzy } from "@/lib/commands";
import type { ProjectState, Task } from "@/lib/types";
import { Mark, StatePill, timeAgo } from "../ui";

/**
 * The agent composer. In Relay a request is never an ungoverned chat: it becomes a scoped task (the @-mentioned
 * files), the agent runs in its own worktree under Relay's hooks, and nothing reaches the shared project until
 * Relay has checked it and a person approves.
 */

const MODELS = [
  { id: "claude-code", label: "Claude Code", available: true, reason: null as string | null },
  { id: "codex", label: "Codex CLI", available: false, reason: "Not connected yet: needs an OpenAI API key on the Relay host." },
];

function ActivityRow({ a }: { a: Task["runs"][number]["activity"][number] }) {
  if (a.kind === "text") return <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{a.detail}</p>;
  if (a.kind === "result") return <p className="whitespace-pre-wrap rounded-sm border border-rule bg-panel-2 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-2">{a.detail}</p>;
  const tone = a.kind === "denied" || a.kind === "error" ? "text-danger" : "text-muted";
  return (
    <p className={`flex items-center gap-1.5 font-mono text-[11.5px] ${tone}`}>
      {a.kind === "tool" ? <Terminal size={11} /> : <CircleAlert size={11} />}
      <span className="truncate">{a.kind === "tool" ? `${a.tool} ${a.target ?? ""}` : a.kind === "denied" ? `Relay blocked: ${a.detail}` : a.detail}</span>
    </p>
  );
}

function Thread({ task, me, onOpenTask, onOpenFile }: { task: Task; me: string; onOpenTask: (id: string) => void; onOpenFile: (p: string) => void }) {
  const run = task.runs.at(-1);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [run?.activity.length]);
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="ml-6 rounded-md bg-sunken px-3 py-2">
        <p className="whitespace-pre-wrap text-[13px] text-ink">{task.objective}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11.5px] text-muted">
          {task.owner === me ? "you" : task.owner} · scope
          {task.scope.map((p) => (
            <button key={p} onClick={() => onOpenFile(p)} className="rounded-sm bg-editor px-1 font-mono text-[11px] text-ink-2 hover:text-ink">
              {p}
            </button>
          ))}
        </p>
      </div>
      {!run && (
        <p className="text-[12.5px] text-muted">
          {task.state === "proposed" ? "Waiting for an owner to approve this task before an agent can start." : "Not started. Run it from the task."}
        </p>
      )}
      {run && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            <Bot size={12} /> Claude Code · {run.status}
            {run.costUsd !== null && <span className="text-faint">· ${run.costUsd.toFixed(2)}</span>}
          </p>
          {run.activity.map((a, i) => (
            <ActivityRow key={i} a={a} />
          ))}
          {run.staleInputs.map((s) => (
            <p key={s.path} className="flex items-center gap-1.5 text-[12px] text-attention">
              <CircleAlert size={12} /> {s.by} edited {s.path} after the agent started.
            </p>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-rule pt-2.5">
        <StatePill state={task.state} />
        <button onClick={() => onOpenTask(task.id)} className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent-ink hover:underline">
          <ShieldCheck size={12} /> {task.state === "review_required" ? "Review & approve" : "Open task"}
        </button>
      </div>
      <div ref={bottom} />
    </div>
  );
}

export function AgentPanel({ state, files, activeFile, onOpenTask, onOpenFile, notify, refresh, focusNonce }: { state: ProjectState; files: string[]; activeFile: string | null; onOpenTask: (id: string) => void; onOpenFile: (p: string) => void; notify: (m: string, tone?: "ok" | "danger") => void; refresh: () => void; focusNonce: number }) {
  const threads = useMemo(() => state.tasks.filter((t) => t.id.startsWith("A-")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.tasks]);
  const [current, setCurrent] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [mention, setMention] = useState<string | null>(null);
  const [mentionSel, setMentionSel] = useState(0);
  const [mode, setMode] = useState<"agent" | "plan">("agent");
  const [model, setModel] = useState("claude-code");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const canEdit = state.me.role !== "viewer";
  const isOwner = state.me.role === "owner";
  const task = threads.find((t) => t.id === current) ?? null;

  useEffect(() => {
    if (focusNonce > 0) box.current?.focus();
  }, [focusNonce]);
  // Start with the file you're looking at in scope; you can remove it.
  useEffect(() => {
    if (activeFile && scope.length === 0) setScope([activeFile]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  const suggestions = useMemo(() => {
    if (mention === null) return [];
    return files
      .filter((f) => !scope.includes(f))
      .map((f) => ({ f, s: fuzzy(mention, f) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => b.s! - a.s!)
      .slice(0, 8)
      .map((x) => x.f);
  }, [mention, files, scope]);

  const onChange = (v: string) => {
    setPrompt(v);
    const m = /(^|\s)@([\w./-]*)$/.exec(v.slice(0, box.current?.selectionStart ?? v.length));
    setMention(m ? m[2]! : null);
    setMentionSel(0);
  };
  const pick = (f: string) => {
    setScope((s) => [...new Set([...s, f])]);
    setPrompt((p) => p.replace(/(^|\s)@[\w./-]*$/, "$1"));
    setMention(null);
    box.current?.focus();
  };

  const send = async () => {
    if (!prompt.trim() || busy) return;
    if (!scope.length) return notify("Add at least one file with @ so Relay knows what the agent may change.", "danger");
    setBusy(true);
    try {
      const r = await api<{ task: Task; note: string }>("POST", "/agent", { prompt: prompt.trim(), files: scope, mode });
      setCurrent(r.task.id);
      setPrompt("");
      notify(r.note);
      refresh();
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const modelInfo = MODELS.find((m) => m.id === model)!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[30px] shrink-0 items-center gap-1 border-b border-rule px-3">
        <select value={current ?? ""} onChange={(e) => setCurrent(e.target.value || null)} aria-label="Agent conversations" className="h-[22px] min-w-0 max-w-[75%] truncate bg-transparent text-[12px] text-ink-2 outline-none">
          <option value="">New request</option>
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.objective.slice(0, 48)} · {timeAgo(t.createdAt)}
            </option>
          ))}
        </select>
        <button aria-label="New request" title="New request" onClick={() => setCurrent(null)} className="ml-auto grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {task ? (
          <Thread task={task} me={state.me.id} onOpenTask={onOpenTask} onOpenFile={onOpenFile} />
        ) : (
          <div className="flex h-full flex-col justify-end px-4 pb-4">
            <div className="mb-auto" />
            <div className="mb-4 flex items-center gap-2 text-ink">
              <Mark size={18} />
              <span className="text-[15px] font-medium">Relay agent</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted">Every request becomes a scoped task. The agent works in its own worktree under Relay&apos;s hooks; nothing reaches the shared project until Relay checks it and a person approves.</p>
            {threads.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Past requests</p>
                {threads.slice(0, 6).map((t) => (
                  <button key={t.id} onClick={() => setCurrent(t.id)} className="flex h-[24px] w-full items-center gap-2 rounded-sm px-1 text-left text-[12.5px] text-ink-2 hover:bg-hover">
                    <span className="truncate">{t.objective}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">{timeAgo(t.createdAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 p-3 pt-0">
        <div className="relative rounded-md border border-rule-strong bg-editor focus-within:border-accent">
          {suggestions.length > 0 && (
            <div role="listbox" aria-label="Files" className="absolute inset-x-0 bottom-full mb-1 max-h-56 overflow-y-auto rounded-md border border-rule-strong bg-panel-2 py-1 shadow-pop">
              {suggestions.map((f, i) => (
                <button key={f} role="option" aria-selected={i === mentionSel} onMouseDown={(e) => (e.preventDefault(), pick(f))} className={`flex h-[22px] w-full items-center gap-1.5 px-2.5 text-left text-[12.5px] ${i === mentionSel ? "bg-accent-soft text-ink" : "text-ink-2"}`}>
                  <FileCode2 size={12} className="text-faint" /> {f}
                </button>
              ))}
            </div>
          )}
          {scope.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 pt-2">
              {scope.map((f) => (
                <span key={f} className="inline-flex items-center gap-1 rounded-sm bg-sunken px-1.5 py-px font-mono text-[11px] text-ink-2">
                  {f}
                  <button aria-label={`Remove ${f} from scope`} onClick={() => setScope((s) => s.filter((x) => x !== f))} className="text-faint hover:text-ink">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={box}
            value={prompt}
            disabled={!canEdit}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (suggestions.length) {
                if (e.key === "ArrowDown") return (e.preventDefault(), setMentionSel((s) => Math.min(suggestions.length - 1, s + 1)));
                if (e.key === "ArrowUp") return (e.preventDefault(), setMentionSel((s) => Math.max(0, s - 1)));
                if (e.key === "Enter" || e.key === "Tab") return (e.preventDefault(), pick(suggestions[mentionSel]!));
                if (e.key === "Escape") return (e.preventDefault(), setMention(null));
              }
              if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), void send());
            }}
            rows={3}
            placeholder={canEdit ? "Ask the agent to change something. @ to add files to its scope" : "Viewers can't start agent work"}
            data-testid="agent-input"
            aria-label="Agent request"
            className="block w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-faint focus-visible:outline-none"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <button aria-label="Add file to scope" title="Add file to scope" onClick={() => (setPrompt((p) => (p && !p.endsWith(" ") ? p + " @" : p + "@")), setMention(""), box.current?.focus())} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
              <AtSign size={13} />
            </button>
            <label className="relative inline-flex items-center" title={modelInfo.reason ?? "Agent provider"}>
              <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Agent provider" className="h-[22px] max-w-36 appearance-none truncate rounded-sm bg-transparent pl-1.5 pr-4 text-[12px] text-muted hover:bg-hover">
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.label}
                    {m.available ? "" : " (not connected)"}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-1 text-faint" />
            </label>
            <label className="relative inline-flex items-center" title={mode === "agent" ? (isOwner ? "Create, approve and run now" : "Create a proposal for an owner to approve") : "Create a proposed task only"}>
              <select value={mode} onChange={(e) => setMode(e.target.value as "agent" | "plan")} aria-label="Mode" className="h-[22px] appearance-none rounded-sm bg-transparent pl-1.5 pr-4 text-[12px] text-muted hover:bg-hover">
                <option value="agent">Agent</option>
                <option value="plan">Plan</option>
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-1 text-faint" />
            </label>
            <button aria-label="Send" title="Send (Enter)" disabled={!canEdit || busy || !prompt.trim() || !modelInfo.available} onClick={() => void send()} className="ml-auto grid size-6 place-items-center rounded-sm bg-ink text-editor disabled:bg-sunken disabled:text-faint">
              <ArrowUp size={13} />
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-faint">{isOwner ? "Agent mode approves and starts the task. Review happens before anything is applied." : "Your requests become proposals; an owner approves them."}</p>
      </div>
    </div>
  );
}
