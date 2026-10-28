"use client";

import { Bot, FilePlus2, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { availability, execute, keyLabel } from "@/lib/commands";
import type { Command } from "@/lib/commands";
import type { ProjectState } from "@/lib/types";
import { Mark } from "../ui";
import type { AttentionItem } from "./Attention";

/**
 * The Welcome editor, kept quiet in the manner of Cursor's: the mark, three ways to start, recent files, and only when
 * something is actually waiting on you, a short "Needs you" list. Pure black in the dark themes. Everything else lives in
 * the Command Palette, which the footer points to.
 */
export function WelcomePage({ state, commands, recent, attention, showOnStartup, setShowOnStartup, onOpen }: { state: ProjectState; commands: Command[]; recent: string[]; attention: AttentionItem[]; showOnStartup: boolean; setShowOnStartup: (v: boolean) => void; onOpen: (p: string) => void; onTask: (id: string) => void }) {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const tile = (id: string, label: string, icon: ReactNode) => {
    const c = byId.get(id);
    if (!c) return null;
    const reason = availability(c);
    return (
      <button
        key={id}
        onClick={() => execute(c)}
        disabled={!!reason}
        title={reason ?? (c.keybinding ? `${label} (${keyLabel(c.keybinding)})` : label)}
        className="group flex h-[84px] flex-col justify-between rounded-md border border-rule bg-transparent p-3 text-left transition-colors hover:border-rule-strong hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent dark:border-white/[0.07] dark:hover:border-white/[0.14] dark:hover:bg-white/[0.03]"
      >
        <span className="text-muted group-hover:text-ink-2">{icon}</span>
        <span className="flex w-full items-baseline justify-between gap-2">
          <span className="text-[13px] text-ink-2 group-hover:text-ink">{label}</span>
          {c.keybinding && <kbd className="font-mono text-[10.5px] text-faint">{keyLabel(c.keybinding)}</kbd>}
        </span>
      </button>
    );
  };
  const palette = byId.get("palette.commands");
  const label = "mb-2 text-[11.5px] font-medium text-faint";
  return (
    <div className="flex flex-1 overflow-y-auto bg-editor dark:bg-black" data-testid="welcome">
      <div className="m-auto w-full max-w-[520px] px-6 py-16">
        <header className="mb-10 flex flex-col items-center text-center">
          <Mark size={40} />
          <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.02em] text-ink">Relay</h1>
          <p className="mt-1 text-[13px] text-faint">{state.project.name}</p>
        </header>

        <div className="grid grid-cols-3 gap-2.5">
          {tile("palette.files", "Open File", <FolderOpen size={17} strokeWidth={1.6} />)}
          {tile("file.newFile", "New File", <FilePlus2 size={17} strokeWidth={1.6} />)}
          {tile("agent.focus", "Ask an Agent", <Bot size={17} strokeWidth={1.6} />)}
        </div>

        {attention.length > 0 && (
          <section className="mt-10" data-testid="welcome-needs-you">
            <h2 className={label}>Needs you</h2>
            {attention.slice(0, 3).map((a) => (
              <button key={a.key} onClick={a.action.run} className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-sm px-2 text-left text-[13px] hover:bg-hover dark:hover:bg-white/[0.04]">
                <span className={`size-1.5 shrink-0 rounded-full ${a.level === "block" ? "bg-danger" : a.level === "review" ? "bg-warn" : "bg-faint"}`} />
                <span className="min-w-0 flex-1 truncate text-ink-2">{a.title}</span>
                <span className="shrink-0 text-[12px] text-faint">{a.action.label}</span>
              </button>
            ))}
            {attention.length > 3 && <p className="mt-1 text-[12px] text-faint">and {attention.length - 3} more in Coordination</p>}
          </section>
        )}

        <section className="mt-10">
          <h2 className={label}>Recent</h2>
          {recent.length === 0 && <p className="text-[13px] text-faint">Files you open appear here.</p>}
          {recent.slice(0, 5).map((p) => (
            <button key={p} onClick={() => onOpen(p)} className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-3 rounded-sm px-2 text-left text-[13px] hover:bg-hover dark:hover:bg-white/[0.04]">
              <span className="text-ink-2">{p.split("/").pop()}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[12px] text-faint">{p.split("/").slice(0, -1).join("/")}</span>
            </button>
          ))}
        </section>

        <footer className="mt-14 flex items-center justify-between text-[12px] text-faint">
          {palette ? (
            <button onClick={() => execute(palette)} className="hover:text-muted">
              Show all commands {palette.keybinding && <kbd className="ml-1 font-mono text-[10.5px]">{keyLabel(palette.keybinding)}</kbd>}
            </button>
          ) : (
            <span />
          )}
          <label className="flex cursor-pointer items-center gap-2 hover:text-muted">
            <input type="checkbox" checked={showOnStartup} onChange={(e) => setShowOnStartup(e.target.checked)} data-testid="welcome-on-startup" className="accent-[var(--accent)]" />
            Show on startup
          </label>
        </footer>
      </div>
    </div>
  );
}
