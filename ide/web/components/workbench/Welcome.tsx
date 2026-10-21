"use client";

import { availability, execute, keyLabel } from "@/lib/commands";
import type { Command } from "@/lib/commands";
import type { ProjectState } from "@/lib/types";
import { Mark, StatePill } from "../ui";
import type { AttentionItem } from "./Attention";

/** The Welcome editor, as VS Code opens on startup: start actions, recent files, and what needs you in this project. */
export function WelcomePage({ state, commands, recent, attention, showOnStartup, setShowOnStartup, onOpen, onTask }: { state: ProjectState; commands: Command[]; recent: string[]; attention: AttentionItem[]; showOnStartup: boolean; setShowOnStartup: (v: boolean) => void; onOpen: (p: string) => void; onTask: (id: string) => void }) {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const row = (id: string, label?: string) => {
    const c = byId.get(id);
    if (!c) return null;
    const reason = availability(c);
    return (
      <button key={id} onClick={() => execute(c)} disabled={!!reason} title={reason ?? undefined} className="flex h-7 w-full items-center gap-3 rounded-sm px-2 -mx-2 text-left text-[13px] text-accent-ink hover:bg-hover disabled:text-faint disabled:hover:bg-transparent">
        {label ?? c.title}
        {c.keybinding && <kbd className="ml-auto font-mono text-[11px] text-faint">{keyLabel(c.keybinding)}</kbd>}
      </button>
    );
  };
  const live = state.tasks.filter((t) => ["running", "review_required", "blocked", "queued", "proposed"].includes(t.state)).slice(0, 6);
  const heading = "mb-2 text-[13.5px] font-semibold text-ink";
  return (
    <div className="flex-1 overflow-y-auto" data-testid="welcome">
      <div className="mx-auto grid max-w-[980px] gap-x-16 gap-y-10 px-10 py-14 md:grid-cols-2">
        <header className="md:col-span-2">
          <div className="flex items-center gap-3">
            <Mark size={30} />
            <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-ink">Relay</h1>
          </div>
          <p className="mt-1.5 text-[14px] text-muted">One project, any model, every contributor in sync. You&apos;re in {state.project.name}.</p>
        </header>
        <div className="space-y-10">
          <section>
            <h2 className={heading}>Start</h2>
            {row("file.newFile")}
            {row("palette.files", "Open File…")}
            {row("search.inFiles")}
            {row("terminal.runTask")}
            {row("agent.focus", "Ask an Agent…")}
            {row("relay.newTask", "New Relay Task…")}
            {row("relay.invite")}
          </section>
          <section>
            <h2 className={heading}>Recent</h2>
            {recent.length === 0 && <p className="text-[13px] text-muted">Files you open appear here.</p>}
            {recent.slice(0, 8).map((p) => (
              <button key={p} onClick={() => onOpen(p)} className="-mx-2 flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] hover:bg-hover">
                <span className="text-accent-ink">{p.split("/").pop()}</span>
                <span className="truncate text-[12px] text-faint">{p.split("/").slice(0, -1).join("/")}</span>
              </button>
            ))}
          </section>
          <section>
            <h2 className={heading}>Help</h2>
            {row("palette.commands", "Show All Commands")}
            {row("help.shortcuts")}
            {row("view.testing", "Open the Testing View")}
            {row("view.extensions", "Browse Extensions")}
          </section>
        </div>
        <div className="space-y-10">
          <section>
            <h2 className={heading}>Needs you</h2>
            {attention.length === 0 && <p className="text-[13px] text-muted">All clear: nothing in this project is waiting on you.</p>}
            {attention.slice(0, 5).map((a) => (
              <div key={a.key} className="mb-2.5">
                <p className="flex items-start gap-2 text-[13px] text-ink">
                  <span className={`mt-[7px] size-1.5 shrink-0 rounded-full ${a.level === "block" ? "bg-danger" : a.level === "review" ? "bg-warn" : "bg-faint"}`} />
                  <span className="min-w-0 flex-1">{a.title}</span>
                  <button onClick={a.action.run} className="shrink-0 rounded-sm px-1.5 text-[12px] text-accent-ink hover:bg-hover">
                    {a.action.label}
                  </button>
                </p>
              </div>
            ))}
          </section>
          <section>
            <h2 className={heading}>In progress</h2>
            {live.length === 0 && <p className="text-[13px] text-muted">No tasks are moving. Create one, or ask an agent.</p>}
            {live.map((t) => (
              <button key={t.id} onClick={() => onTask(t.id)} className="-mx-2 flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] hover:bg-hover">
                <span className="font-mono text-[12px] text-muted">{t.id}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{t.objective}</span>
                <StatePill state={t.state} />
              </button>
            ))}
          </section>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-muted md:col-span-2">
          <input type="checkbox" checked={showOnStartup} onChange={(e) => setShowOnStartup(e.target.checked)} data-testid="welcome-on-startup" />
          Show welcome page on startup
        </label>
      </div>
    </div>
  );
}
