"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Bot, Check, CircleAlert, FileCode2, GitMerge, Play, Plus, ShieldCheck, Square, UserRound } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ContractVersion, Integration, Member, ProjectState, RelayEvent, Task, Why } from "@/lib/types";
import { Button, Pill, SectionLabel, StatePill, timeAgo } from "./ui";

export type CoordTab = "tasks" | "contracts";

export function Coordination({
  state,
  onOpenFile,
  refresh,
  notify,
  tab,
  setTab,
  selected,
  setSelected,
  newTaskNonce,
  embedded = false,
}: {
  state: ProjectState;
  onOpenFile: (p: string) => void;
  refresh: () => void;
  notify: (msg: string, tone?: "ok" | "danger") => void;
  tab: CoordTab;
  setTab: (t: CoordTab) => void;
  selected: string | null;
  setSelected: (id: string | null) => void;
  newTaskNonce: number;
  /** When the surrounding side bar provides the tabs. */
  embedded?: boolean;
}) {
  const task = state.tasks.find((t) => t.id === selected) ?? null;

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) notify(done, "ok");
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      refresh();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className={`flex h-10 shrink-0 items-center gap-1 border-b border-rule px-3 ${embedded ? "hidden" : ""}`}>
        <span className="mr-auto pl-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Relay</span>
        {(["tasks", "contracts"] as CoordTab[]).map((t) => (
          <button
            key={t}
            onClick={() => (setTab(t), setSelected(null))}
            className={`relative h-7 rounded-sm px-3 text-[12.5px] font-medium capitalize transition-colors ${tab === t ? "text-ink" : "text-muted hover:text-ink"}`}
          >
            {tab === t && <motion.span layoutId="coord-tab" className="absolute inset-0 rounded-sm bg-sunken" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span className="relative">{t}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={task ? `t:${task.id}` : tab} initial={{ opacity: 0, x: task ? 12 : 0, y: task ? 0 : 4 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="p-3">
            {task ? (
              <TaskDetail task={task} state={state} onBack={() => setSelected(null)} onOpenFile={onOpenFile} act={act} />
            ) : tab === "tasks" ? (
              <TaskList state={state} onSelect={setSelected} act={act} newTaskNonce={newTaskNonce} />
            ) : (
              <Contracts state={state} act={act} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const run = task.runs.at(-1);
  const stale = run?.staleInputs.length ?? 0;
  return (
    <motion.button
      layout
      onClick={onClick}
      data-testid={`task-${task.id}`}
      className="group w-full border-b border-rule px-3 py-2 text-left hover:bg-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11.5px] text-muted">{task.id}</span>
        <StatePill state={task.state} />
      </div>
      <p className="mt-1.5 text-[14px] leading-snug text-ink">{task.objective}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {Object.entries(task.contracts).map(([c, v]) => (
          <Pill key={c} tone="neutral">
            {c} v{v}
          </Pill>
        ))}
        {run && (
          <Pill tone={run.status === "running" ? "accent" : run.status === "failed" ? "danger" : "neutral"}>
            <Bot size={11} /> Claude Code · {run.status}
          </Pill>
        )}
        {stale > 0 && (
          <Pill tone="attention">
            <CircleAlert size={11} /> stale input
          </Pill>
        )}
      </div>
    </motion.button>
  );
}

function TaskList({ state, onSelect, act, newTaskNonce }: { state: ProjectState; onSelect: (id: string) => void; act: Act; newTaskNonce: number }) {
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (newTaskNonce > 0) setCreating(true);
  }, [newTaskNonce]);
  const canEdit = state.me.role !== "viewer";
  const groups = useMemo(() => {
    const g = { needs: [] as Task[], moving: [] as Task[], done: [] as Task[] };
    for (const t of state.tasks) {
      if (t.state === "review_required" || t.state === "proposed" || t.state === "blocked") g.needs.push(t);
      else if (t.state === "queued" || t.state === "running") g.moving.push(t);
      else g.done.push(t);
    }
    return g;
  }, [state.tasks]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between px-1 pt-1">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted">Tasks</h2>
        {canEdit && (
          <Button tone="quiet" size="sm" onClick={() => setCreating((v) => !v)}>
            <Plus size={13} /> Task
          </Button>
        )}
      </div>
      <AnimatePresence>{creating && <NewTask state={state} act={act} onDone={() => setCreating(false)} />}</AnimatePresence>
      {state.tasks.length === 0 && !creating && (
        <div className="px-1 py-2">
          <p className="text-[13px] text-ink-2">No tasks yet.</p>
          <p className="mt-1 text-[13px] text-muted">Create a task, give it a scope and a contract, and hand it to a person or an agent.</p>
        </div>
      )}
      {(
        [
          ["Needs a person", groups.needs],
          ["Moving", groups.moving],
          ["Settled", groups.done],
        ] as const
      ).map(([label, list]) =>
        list.length ? (
          <section key={label}>
            <SectionLabel right={<span className="text-[11px] text-faint">{list.length}</span>}>{label}</SectionLabel>
            <div className="-mx-3 border-t border-rule">
              {list.map((t) => (
                <TaskCard key={t.id} task={t} onClick={() => onSelect(t.id)} />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
const inputCls = "h-[26px] w-full rounded-sm border border-rule bg-editor px-2 text-[13px] outline-none focus:border-accent";

function NewTask({ state, act, onDone }: { state: ProjectState; act: Act; onDone: () => void }) {
  const accepted = state.contracts.filter((c) => c.history.some((h) => h.status === "accepted"));
  return (
    <motion.form
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="space-y-3 overflow-hidden border border-rule bg-editor p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body = {
          id: String(f.get("id")).trim(),
          objective: String(f.get("objective")).trim(),
          scope: String(f.get("scope")).split(",").map((s) => s.trim()).filter(Boolean),
          contracts: f.getAll("contracts").map(String),
          ...(state.me.role === "owner" && String(f.get("verify")).trim() ? { verify: [String(f.get("verify")).trim()] } : {}),
        };
        void act(() => api("POST", "/tasks", body), `Created ${body.id}. An owner approves it before work starts.`).then(onDone);
      }}
    >
      <div className="grid grid-cols-[110px_1fr] gap-2">
        <Field label="Id">
          <input name="id" required placeholder="T-ui" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="Objective">
          <input name="objective" required placeholder="Greeting uses the new user shape" className={inputCls} />
        </Field>
      </div>
      <Field label="Scope (files or folders/, comma separated)">
        <input name="scope" required placeholder="src/ui.js" className={`${inputCls} font-mono`} />
      </Field>
      {accepted.length > 0 && (
        <fieldset>
          <span className="mb-1 block text-[11.5px] font-medium text-muted">Depends on contracts</span>
          <div className="flex flex-wrap gap-1.5">
            {accepted.map((c) => (
              <label key={c.id} className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-rule px-2.5 py-1 text-[12px] has-[:checked]:border-accent-line has-[:checked]:bg-accent-soft">
                <input type="checkbox" name="contracts" value={c.id} className="accent-[var(--accent)]" /> {c.id}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {state.me.role === "owner" && (
        <Field label="Verification command (runs on this machine; owners only)">
          <input name="verify" placeholder="npm test" className={`${inputCls} font-mono`} />
        </Field>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" tone="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" tone="primary" size="sm">
          Create task
        </Button>
      </div>
    </motion.form>
  );
}

function Ladder({ why }: { why: Why | null }) {
  const steps = [
    { label: "Agent or person says done", ok: why?.ladder.agentClaimed, note: "a claim, not proof" },
    { label: "Relay verified", ok: why?.ladder.relayVerified, note: "diff check + tests, run by Relay" },
    { label: "Approved by a person", ok: why?.ladder.humanApproved, note: "owner sign-off" },
  ];
  return (
    <ol className="relative space-y-3 pl-6">
      <span className="absolute bottom-2 left-[9px] top-2 w-px bg-rule" />
      {steps.map((s) => (
        <li key={s.label} className="relative">
          <span className={`absolute -left-6 top-0.5 grid size-[18px] place-items-center rounded-full ring-4 ring-panel ${s.ok ? "bg-ok text-panel" : "bg-sunken text-faint"}`}>
            {s.ok ? <Check size={11} strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-faint" />}
          </span>
          <p className={`text-[13px] font-medium ${s.ok ? "text-ink" : "text-muted"}`}>{s.label}</p>
          <p className="text-[11.5px] text-faint">{s.note}</p>
        </li>
      ))}
    </ol>
  );
}

function TaskDetail({ task, state, onBack, onOpenFile, act }: { task: Task; state: ProjectState; onBack: () => void; onOpenFile: (p: string) => void; act: Act }) {
  const [why, setWhy] = useState<Why | null>(null);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const me = state.me;
  const isOwner = me.role === "owner";
  const canEdit = me.role !== "viewer";
  const run = task.runs.at(-1);
  const agentTask = !!run;

  useEffect(() => {
    let live = true;
    api<Why>("GET", `/tasks/${encodeURIComponent(task.id)}/why`).then((w) => live && setWhy(w), () => live && setWhy(null));
    return () => {
      live = false;
    };
  }, [task.id, task.state, task.updatedAt, run?.status]);

  const partners = useMemo(() => {
    const ids = new Set<string>();
    for (const g of why?.gaps ?? []) {
      const m = /unfinished task\(s\) ([^;]+);/.exec(g);
      if (m) m[1]!.split(",").forEach((x) => ids.add(x.trim()));
    }
    return [...ids];
  }, [why]);
  const current = (cid: string) => state.contracts.find((c) => c.id === cid)?.history.filter((h) => h.status === "accepted").at(-1)?.version;
  const move = (to: string, done: string) => act(() => api("POST", `/tasks/${encodeURIComponent(task.id)}/transition`, { to }), done);

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink">
        <ArrowLeft size={13} /> All work
      </button>
      <div>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[12px] text-muted">{task.id}</span>
          <StatePill state={task.state} />
        </div>
        <h2 className="mt-1.5 text-[14px] font-medium leading-snug text-ink">{task.objective}</h2>
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
          {agentTask ? <Bot size={12} /> : <UserRound size={12} />}
          {agentTask ? "Claude Code" : (task.agent ?? task.owner ?? "unassigned")} · updated {timeAgo(task.updatedAt)}
        </p>
      </div>

      <div className="border-y border-rule py-3">
        <SectionLabel>How far it got</SectionLabel>
        <Ladder why={why} />
      </div>

      {why && visibleGaps(task, why).length > 0 && (
        <div className="border-l-2 border-danger bg-danger-soft/50 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-danger">
            <CircleAlert size={14} /> Why it can&apos;t be approved yet
          </p>
          <ul className="mt-2 space-y-1.5">
            {visibleGaps(task, why).map((g) => (
              <li key={g} className="text-[12.5px] leading-snug text-ink-2">
                {g}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <SectionLabel>Scope</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {task.scope.map((p) => (
            <button key={p} onClick={() => !p.endsWith("/") && onOpenFile(p)} className="inline-flex items-center gap-1.5 rounded-sm bg-sunken px-2 py-1 font-mono text-[12px] text-ink-2 hover:bg-accent-soft">
              <FileCode2 size={12} /> {p}
            </button>
          ))}
        </div>
      </div>

      {Object.keys(task.contracts).length > 0 && (
        <div>
          <SectionLabel>Contracts</SectionLabel>
          {Object.entries(task.contracts).map(([c, v]) => {
            const cur = current(c);
            const stale = cur !== undefined && cur > v;
            return (
              <div key={c} className="flex items-center justify-between rounded-sm px-1 py-1.5 text-[13px]">
                <span className="font-mono">{c}</span>
                <span className="flex items-center gap-1.5">
                  <Pill tone={stale ? "danger" : "ok"}>built on v{v}</Pill>
                  {stale && <Pill tone="neutral">current v{cur}</Pill>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {run && (
        <div className="border-y border-rule py-3">
          <SectionLabel right={<Pill tone={run.status === "running" ? "accent" : run.status === "failed" ? "danger" : "neutral"}>{run.status}</Pill>}>Agent run</SectionLabel>
          {run.staleInputs.map((s) => (
            <p key={s.path} className="mb-2 rounded-sm bg-attention-soft px-2.5 py-1.5 text-[12px] text-ink-2">
              <strong className="text-attention">{s.by}</strong> edited <span className="font-mono">{s.path}</span> after the agent started. Its copy is older.
            </p>
          ))}
          <ol className="max-h-56 space-y-1 overflow-y-auto font-mono text-[11.5px]">
            {run.activity.filter((a) => a.kind !== "text").map((a, i) => (
              <li key={i} className={`flex gap-2 ${a.kind === "denied" ? "text-danger" : a.kind === "error" ? "text-danger" : "text-ink-2"}`}>
                <span className="w-14 shrink-0 text-faint">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span className="truncate">{a.kind === "tool" ? `${a.tool} ${a.target ?? ""}` : (a.detail ?? a.kind)}</span>
              </li>
            ))}
          </ol>
          {run.changedFiles.length > 0 && <p className="mt-2 text-[12px] text-muted">Changed: {run.changedFiles.join(", ")}</p>}
          {run.costUsd !== null && <p className="mt-1 text-[11.5px] text-faint">Reported cost ${run.costUsd.toFixed(2)}</p>}
        </div>
      )}

      {integration && (
        <div className={`border-l-2 px-3 py-2 ${integration.status === "passed" ? "border-ok bg-ok-soft/50" : "border-danger bg-danger-soft/50"}`}>
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <GitMerge size={14} /> {integration.status === "passed" ? "Ready to approve together" : "Not ready to integrate"}
          </p>
          <ul className="mt-2 space-y-1 text-[12.5px] text-ink-2">
            {integration.gaps.map((g) => (
              <li key={g}>· {g}</li>
            ))}
            {integration.results.map((r) => (
              <li key={r.command} className="font-mono text-[11.5px]">
                {r.exitCode === 0 ? "✓" : "✕"} {r.command}
              </li>
            ))}
          </ul>
          {integration.status === "passed" && isOwner && (
            <Button
              tone="primary"
              size="sm"
              className="mt-3"
              onClick={() => act(() => api("POST", `/integrations/${integration.id}/approve`).then(() => setIntegration(null)), `Approved ${integration.tasks.join(" + ")} together.`)}
            >
              <ShieldCheck size={13} /> Approve all {integration.tasks.length}
            </Button>
          )}
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2 border-t border-rule pt-4">
          {task.state === "proposed" && isOwner && (
            <Button tone="primary" size="sm" onClick={() => move("queued", `${task.id} is ready to work on.`)}>
              <Check size={13} /> Approve plan
            </Button>
          )}
          {task.state === "queued" && (
            <>
              <Button tone="primary" size="sm" onClick={() => act(() => api("POST", `/tasks/${encodeURIComponent(task.id)}/run`), "Claude Code started in its own worktree.")}>
                <Play size={13} /> Run with Claude Code
              </Button>
              <Button tone="quiet" size="sm" onClick={() => move("running", `You're on ${task.id}.`)}>
                <UserRound size={13} /> I&apos;ll take it
              </Button>
            </>
          )}
          {task.state === "running" && !agentTask && (
            <Button tone="primary" size="sm" onClick={() => move("review_required", "Submitted for review.")}>
              Submit for review
            </Button>
          )}
          {run?.status === "running" && (
            <Button tone="danger" size="sm" onClick={() => act(() => api("POST", `/tasks/${encodeURIComponent(task.id)}/cancel-run`), "Agent stopped.")}>
              <Square size={12} /> Stop agent
            </Button>
          )}
          {task.state === "review_required" && !agentTask && (
            <Button tone="quiet" size="sm" onClick={() => act(() => api("POST", `/tasks/${encodeURIComponent(task.id)}/check`), "Relay ran its checks.")}>
              <ShieldCheck size={13} /> Run Relay checks
            </Button>
          )}
          {task.state === "review_required" && partners.length > 0 && (
            <Button
              tone="quiet"
              size="sm"
              onClick={() =>
                act(async () => setIntegration(await api<Integration>("POST", "/integrations/check", { tasks: [task.id, ...partners] })), undefined)
              }
            >
              <GitMerge size={13} /> Check with {partners.join(", ")}
            </Button>
          )}
          {task.state === "review_required" && isOwner && partners.length === 0 && (
            <Button
              tone="primary"
              size="sm"
              onClick={() =>
                agentTask
                  ? act(() => api("POST", `/tasks/${encodeURIComponent(task.id)}/apply`), "Approved. The agent's changes are now in the shared project.")
                  : move("completed", `${task.id} approved.`)
              }
            >
              <ShieldCheck size={13} /> {agentTask ? "Approve & apply" : "Approve"}
            </Button>
          )}
          {(task.state === "failed" || task.state === "blocked") && isOwner && (
            <Button tone="quiet" size="sm" onClick={() => move("queued", `${task.id} is back in the queue.`)}>
              Requeue
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Before review, only show what will block approval anyway (contracts, partners); evidence gaps are expected then. */
function visibleGaps(task: Task, why: Why): string[] {
  if (task.state === "completed" || task.state === "cancelled") return [];
  if (task.state === "review_required") return why.gaps;
  return why.gaps.filter((g) => /contract|partner/i.test(g));
}

function Contracts({ state, act }: { state: ProjectState; act: Act }) {
  const [proposing, setProposing] = useState<string | null>(null);
  const isOwner = state.me.role === "owner";
  const users = (cid: string) => state.tasks.filter((t) => cid in t.contracts && t.state !== "completed" && t.state !== "cancelled");
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between px-1 pt-1">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted">Contracts</h2>
        {state.me.role !== "viewer" && (
          <Button tone="quiet" size="sm" onClick={() => setProposing("")}>
            <Plus size={13} /> Contract
          </Button>
        )}
      </div>
      {proposing !== null && (
        <form
          className="space-y-2 border border-rule bg-editor p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(() => api("POST", "/contracts", { id: String(f.get("id")), definition: String(f.get("definition")), rationale: String(f.get("rationale") || "") }), "Proposed. It has no effect until an owner accepts it.").then(() => setProposing(null));
          }}
        >
          <input name="id" defaultValue={proposing} required placeholder="user-api" className={`${inputCls} font-mono`} />
          <textarea name="definition" required rows={3} placeholder="getUser(id) -> { id, fullName }" className={`${inputCls} h-auto py-2 font-mono`} />
          <input name="rationale" placeholder="Why it changes" className={inputCls} />
          <div className="flex justify-end gap-2">
            <Button type="button" tone="ghost" size="sm" onClick={() => setProposing(null)}>
              Cancel
            </Button>
            <Button type="submit" tone="primary" size="sm">
              Propose
            </Button>
          </div>
        </form>
      )}
      {state.contracts.map((c) => {
        const cur = c.history.filter((h) => h.status === "accepted").at(-1);
        return (
          <div key={c.id} className="border-b border-rule pb-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[13px] font-semibold">{c.id}</span>
              {cur && <Pill tone="ok">v{cur.version} accepted</Pill>}
            </div>
            {cur && <pre className="mt-2 whitespace-pre-wrap rounded-sm bg-sunken p-2.5 font-mono text-[12px] text-ink-2">{cur.definition}</pre>}
            <ol className="mt-3 space-y-1.5">
              {c.history
                .slice()
                .reverse()
                .map((h: ContractVersion) => (
                  <li key={h.version} className="flex items-center justify-between text-[12px]">
                    <span className="text-muted">
                      v{h.version} · {h.status} · {h.author.replace(/^\w+:/, "")}
                    </span>
                    {h.status === "proposed" && isOwner && (
                      <span className="flex gap-1">
                        <Button size="sm" tone="primary" onClick={() => act(() => api("POST", `/contracts/${c.id}/${h.version}/accept`), `Accepted ${c.id} v${h.version}.`)}>
                          Accept
                        </Button>
                        <Button size="sm" tone="ghost" onClick={() => act(() => api("POST", `/contracts/${c.id}/${h.version}/reject`), "Rejected.")}>
                          Reject
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
            </ol>
            {users(c.id).length > 0 && (
              <p className="mt-3 border-t border-rule pt-2.5 text-[12px] text-muted">
                Used by{" "}
                {users(c.id).map((t) => (
                  <span key={t.id} className={`mr-1.5 font-mono ${cur && t.contracts[c.id]! < cur.version ? "text-danger" : "text-ink-2"}`}>
                    {t.id} (v{t.contracts[c.id]})
                  </span>
                ))}
              </p>
            )}
            {state.me.role !== "viewer" && (
              <button onClick={() => setProposing(c.id)} className="mt-2 text-[12px] font-medium text-accent-ink hover:underline">
                Propose a new version
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function describe(e: RelayEvent, members: Member[]): string {
  const who = (a: string) => {
    const id = a.replace(/^\w+:/, "");
    return members.find((m) => m.id === id)?.name ?? (a.startsWith("agent:") ? "Claude Code" : a.startsWith("system:") ? "Relay" : id);
  };
  const d = e.data;
  switch (e.type) {
    case "task.created":
      return `${who(e.actor)} proposed ${e.taskId}`;
    case "task.transition":
      return `${who(e.actor)} moved ${e.taskId} → ${String(e.toState).replace("_", " ")}`;
    case "contract.proposed":
      return `${who(e.actor)} proposed ${d.contract} v${d.version}`;
    case "contract.accepted":
      return `${who(e.actor)} accepted ${d.contract} v${d.version}${(d.affectedTasks as string[])?.length ? ` · now stale: ${(d.affectedTasks as string[]).join(", ")}` : ""}`;
    case "task.contract_stale":
      return `${e.taskId} is built on an old ${d.contract}`;
    case "task.contract_acknowledged":
      return `${e.taskId} moved to ${d.contract} v${d.to}`;
    case "enforcement.decision":
      return `${d.decision === "deny" ? "Blocked" : "Allowed"} ${d.tool ?? ""} ${String(d.path ?? d.command ?? "").split("/").slice(-2).join("/")} for ${e.taskId ?? "?"}`;
    case "integration.checked":
      return `Integration check ${d.status}: ${(d.tasks as string[]).join(" + ")}`;
    case "integration.approved":
      return `${who(e.actor)} approved ${(d.tasks as string[]).join(" + ")} together`;
    case "task.input_changed":
      return `${d.by} edited ${d.path} while an agent works on ${e.taskId}`;
    case "agent.run_started":
      return `Claude Code started on ${e.taskId}`;
    case "agent.run_ended":
      return `Claude Code finished ${e.taskId} (${d.status})`;
    case "agent.tool":
      return `Claude Code · ${d.tool} ${String(d.target ?? "").slice(0, 40)}`;
    case "agent.denied":
      return `Relay blocked an agent action on ${e.taskId}`;
    case "agent.changes_applied":
      return `${who(e.actor)} applied agent changes: ${(d.applied as string[] | undefined)?.join(", ") ?? ""}`;
    case "doc.external_change_merged":
      return `Merged an outside edit to ${d.path}`;
    case "doc.external_change_conflict":
      return `Outside edit to ${d.path} conflicted; kept for review`;
    case "member.joined":
      return `${who(e.actor)} joined`;
    case "evidence.recorded":
      return `${d.verified ? "Relay recorded" : "Agent reported"} ${d.kind}${d.command ? `: ${d.command}` : ""}${d.exitCode !== null && d.exitCode !== undefined ? ` (exit ${d.exitCode})` : ""}`;
    default:
      return `${e.type} ${e.taskId ?? ""}`;
  }
}
