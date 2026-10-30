"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, ChevronRight } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { Member } from "@/lib/types";

/** Mirrors src/knowledge/handoff.ts (the parts shown here). */
interface Handoff {
  id: string;
  taskId: string;
  from: { id: string; name: string };
  to: string;
  toName: string;
  status: "open" | "acknowledged" | "declined" | "withdrawn" | "delivered";
  createdAt: string;
  response: string | null;
}

/**
 * Handing a task over, and receiving one. The packet is built by the server from evidence and frozen; what the giver
 * types is kept apart as their words. The recipient acknowledges (and owns the task) or declines with a reason.
 */
export function HandoffPanel({ taskId, me, members, closed, notify }: { taskId: string; me: Member; members: Member[]; closed: boolean; notify: (m: string, tone?: "ok" | "danger") => void }) {
  const [list, setList] = useState<Handoff[]>([]);
  const [text, setText] = useState<Record<string, string>>({});
  const [form, setForm] = useState(false);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [questions, setQuestions] = useState("");
  const [steps, setSteps] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ handoffs: Handoff[] }>("GET", `/handoffs?task=${encodeURIComponent(taskId)}`).then((r) => {
      setList(r.handoffs);
      for (const h of r.handoffs.filter((x) => x.status === "open")) void api<{ text: string }>("GET", `/handoffs/${h.id}`).then((d) => setText((m) => ({ ...m, [h.id]: d.text })), () => {});
    }, () => {});
  }, [taskId]);
  useEffect(load, [load]);

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      notify(ok);
      load();
      return true;
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const open = list.find((h) => h.status === "open");
  const forMe = open && open.to === me.id;
  const canEdit = me.role !== "viewer";
  const targets = members.filter((m) => m.id !== me.id && m.role !== "viewer");
  const why = !canEdit ? "Viewers can't hand work over" : closed ? "The task is finished" : open ? `${open.from.name} already handed it to ${open.toName}; that has to be answered or withdrawn first` : null;

  return (
    <details data-testid="handoff" open={!!forMe}>
      <summary className="micro flex cursor-pointer list-none items-center gap-1 text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform [details[open]>summary>&]:rotate-90" />
        Handoff{open ? ` · ${forMe ? "handed to you" : `open, to ${open.toName}`}` : ""}
      </summary>
      <div className="mt-2 space-y-3 text-[12.5px]">
        {open && (
          <div className="rounded-sm border border-rule px-2.5 py-2" data-testid="handoff-open">
            <p className="text-ink-2">
              {open.from.name} handed this to {open.to === me.id ? "you" : open.toName}.
            </p>
            {text[open.id] && <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-ink-2" data-testid="handoff-packet">{text[open.id]}</pre>}
            {forMe && (
              <div className="mt-2 space-y-1.5">
                <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply (needed to decline)" aria-label="Reply" className="h-[26px] w-full rounded-sm border border-rule bg-editor px-2 text-[12.5px] outline-none focus:border-accent" />
                <span className="flex gap-1.5">
                  <button disabled={busy} onClick={() => void call(() => api("POST", `/handoffs/${open.id}/respond`, { status: "acknowledged", reply }), `You own ${taskId} now.`)} className="h-[26px] rounded-sm bg-accent px-2.5 text-[12px] font-medium text-accent-fg disabled:opacity-40">
                    Acknowledge and take over
                  </button>
                  <button disabled={busy || !reply.trim()} title={reply.trim() ? undefined : "Say why, so the person handing over knows"} onClick={() => void call(() => api("POST", `/handoffs/${open.id}/respond`, { status: "declined", reply }), "Declined; they'll see your reason.")} className="h-[26px] rounded-sm border border-rule px-2.5 text-[12px] text-ink-2 disabled:opacity-40">
                    Decline
                  </button>
                </span>
              </div>
            )}
            {open.from.id === me.id && (
              <button disabled={busy} onClick={() => void call(() => api("POST", `/handoffs/${open.id}/withdraw`), "Handoff withdrawn.")} className="mt-2 h-[26px] rounded-sm border border-rule px-2 text-[12px] text-ink-2 disabled:opacity-40">
                Withdraw
              </button>
            )}
          </div>
        )}
        {!form ? (
          <button disabled={!!why} title={why ?? "Pass this task on with what is known"} onClick={() => setForm(true)} className="inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:text-ink disabled:opacity-40">
            <ArrowRightLeft size={12} /> Hand over…
          </button>
        ) : (
          <form
            className="space-y-1.5"
            data-testid="handoff-form"
            onSubmit={(e) => {
              e.preventDefault();
              void call(() => api("POST", "/handoffs", { task: taskId, to, note, questions: lines(questions), nextSteps: lines(steps) }), `Handed ${taskId} over.`).then((ok) => ok && (setForm(false), setNote(""), setQuestions(""), setSteps("")));
            }}
          >
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hand to" required className="h-[26px] w-full rounded-sm border border-rule bg-editor px-1.5 text-[12.5px]">
              <option value="">Hand to…</option>
              {targets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.role})
                </option>
              ))}
              <option value="next-agent">The next agent run on this task</option>
            </select>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} required placeholder="Where things stand, in a sentence or two" aria-label="Note" rows={2} className="w-full rounded-sm border border-rule bg-editor px-2 py-1 text-[12.5px] outline-none focus:border-accent" />
            <textarea value={questions} onChange={(e) => setQuestions(e.target.value)} placeholder="Open questions, one per line (optional)" aria-label="Open questions" rows={2} className="w-full rounded-sm border border-rule bg-editor px-2 py-1 text-[12.5px] outline-none focus:border-accent" />
            <textarea value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="Next steps, one per line (optional)" aria-label="Next steps" rows={2} className="w-full rounded-sm border border-rule bg-editor px-2 py-1 text-[12.5px] outline-none focus:border-accent" />
            <p className="text-[11.5px] text-faint">Relay adds what it knows: the change, which checks ran on it, failures, decisions, contracts and radar alerts.</p>
            <span className="flex gap-1.5">
              <button type="submit" disabled={busy} className="h-[26px] rounded-sm bg-accent px-2.5 text-[12px] font-medium text-accent-fg disabled:opacity-40">
                Hand over
              </button>
              <button type="button" onClick={() => setForm(false)} className="h-[26px] rounded-sm border border-rule px-2.5 text-[12px] text-ink-2">
                Cancel
              </button>
            </span>
          </form>
        )}
        {list.filter((h) => h.status !== "open").slice(0, 5).map((h) => (
          <p key={h.id} className="text-[11.5px] text-faint">
            {h.from.name} → {h.toName}: {h.status}
            {h.response ? ` (${h.response})` : ""} · {new Date(h.createdAt).toLocaleString()}
          </p>
        ))}
      </div>
    </details>
  );
}
