"use client";

import { useMemo, useState } from "react";
import { Bot, FileCode2, FilePlus2, FolderOpen, GitBranch, Keyboard, Play, Search, ShieldCheck, Sparkles, UserPlus, Users } from "lucide-react";
import { availability, execute, fuzzy, keyLabel } from "@/lib/commands";
import type { Command } from "@/lib/commands";
import type { Theme } from "@/lib/theme";
import { CODE_FONTS, UI_FONTS } from "../Editor";
import type { EditorPrefs } from "../Editor";
import { Mark } from "../ui";

/**
 * Relay's own editor tabs, as VS Code has them: Welcome, Settings (a searchable settings editor) and Keyboard
 * Shortcuts. Every setting here changes real behaviour; nothing is listed that the IDE doesn't honour.
 */

export interface SpecialCtx {
  commands: Command[];
  recent: string[];
  open: (path: string) => void;
  prefs: EditorPrefs;
  setPrefs: (f: (p: EditorPrefs) => EditorPrefs) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  showAuthors: boolean;
  setShowAuthors: (b: boolean) => void;
  layout: { statusBar: boolean; breadcrumbs: boolean; centered: boolean; zoom: number };
  setLayout: (patch: Partial<{ statusBar: boolean; breadcrumbs: boolean; centered: boolean; zoom: number }>) => void;
}

export function SpecialEditor({ id, ctx }: { id: string; ctx: SpecialCtx }) {
  if (id === "relay:settings") return <SettingsEditor ctx={ctx} />;
  if (id === "relay:keybindings") return <KeybindingsEditor commands={ctx.commands} />;
  return <Welcome ctx={ctx} testId="welcome" />;
}

const run = (commands: Command[], id: string) => {
  const c = commands.find((x) => x.id === id);
  if (c && !availability(c)) execute(c);
};

function StartLink({ commands, id, icon, label }: { commands: Command[]; id: string; icon: React.ReactNode; label?: string }) {
  const c = commands.find((x) => x.id === id);
  if (!c) return null;
  const reason = availability(c);
  return (
    <button onClick={() => run(commands, id)} disabled={!!reason} title={reason ?? undefined} className="flex h-7 items-center gap-2.5 rounded-sm text-[13px] text-accent-ink hover:underline disabled:cursor-default disabled:text-faint disabled:no-underline">
      <span className="text-muted">{icon}</span>
      {label ?? c.title.replace(/…$/, "…")}
    </button>
  );
}

const WALKTHROUGH: { title: string; body: string; cmd: string; icon: React.ReactNode }[] = [
  { title: "Open a file and edit together", body: "Every file is shared live. Collaborators' carets and names appear as they type.", cmd: "palette.files", icon: <FileCode2 size={15} /> },
  { title: "Invite a collaborator", body: "Owners create one-time invite links with a role: editor or viewer.", cmd: "relay.invite", icon: <UserPlus size={15} /> },
  { title: "Ask an agent for a change", body: "A request becomes a scoped task; the agent works in its own copy until you approve.", cmd: "agent.focus", icon: <Bot size={15} /> },
  { title: "Review and approve", body: "See what changed, the real test results, and what approving will do.", cmd: "view.relay", icon: <ShieldCheck size={15} /> },
  { title: "Run the project's tests", body: "Per-test results with links to the failing line, rerun failed, out-of-date marking.", cmd: "tests.runAll", icon: <Play size={15} /> },
  { title: "Commit and push", body: "Stage, commit as yourself, branch, pull and push from Source Control.", cmd: "view.scm", icon: <GitBranch size={15} /> },
  { title: "Learn the keyboard shortcuts", body: "VS Code's shortcuts work here: Ctrl+P, Ctrl+Shift+P, Ctrl+`, Alt+↑/↓ and more.", cmd: "workbench.action.openGlobalKeybindings", icon: <Keyboard size={15} /> },
];

/** The Welcome page: Start, Recent and a walkthrough, in VS Code's two-column layout. */
export function Welcome({ ctx, testId }: { ctx: Pick<SpecialCtx, "commands" | "recent" | "open">; testId: string }) {
  const { commands, recent, open } = ctx;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid={testId}>
      <div className="mx-auto max-w-[1040px] px-10 pb-16 pt-14">
        <div className="flex items-center gap-4">
          <Mark size={40} />
          <div>
            <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.01em] text-ink">Relay</h1>
            <p className="mt-0.5 text-[15px] text-muted">One project. Any model. Humans and agents working in sync.</p>
          </div>
        </div>
        <div className="mt-12 grid gap-x-16 gap-y-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="space-y-9">
            <section>
              <h2 className="mb-2 text-[17px] font-medium text-ink">Start</h2>
              <StartLink commands={commands} id="file.newFile" icon={<FilePlus2 size={15} />} />
              <StartLink commands={commands} id="palette.files" icon={<FileCode2 size={15} />} label="Open File…" />
              <StartLink commands={commands} id="workbench.action.files.openFolder" icon={<FolderOpen size={15} />} />
              <StartLink commands={commands} id="search.inFiles" icon={<Search size={15} />} label="Search the Project…" />
              <StartLink commands={commands} id="relay.invite" icon={<Users size={15} />} />
              <StartLink commands={commands} id="agent.focus" icon={<Sparkles size={15} />} />
            </section>
            <section>
              <h2 className="mb-2 text-[17px] font-medium text-ink">Recent</h2>
              {recent.length === 0 ? (
                <p className="text-[13px] text-muted">Files you open appear here.</p>
              ) : (
                recent.slice(0, 8).map((p) => (
                  <button key={p} onClick={() => open(p)} className="flex h-7 w-full items-center gap-2 text-left text-[13px] hover:underline">
                    <span className="text-accent-ink">{p.split("/").pop()}</span>
                    <span className="truncate text-faint">{p.split("/").slice(0, -1).join("/")}</span>
                  </button>
                ))
              )}
              <button onClick={() => run(commands, "workbench.action.openRecent")} className="mt-1 text-[13px] text-accent-ink hover:underline">
                More…
              </button>
            </section>
          </div>
          <section>
            <h2 className="mb-2 text-[17px] font-medium text-ink">Walkthroughs</h2>
            <div className="divide-y divide-rule rounded-md border border-rule bg-sidebar">
              <p className="px-4 pb-2 pt-3 text-[14px] font-medium text-ink">Get started with Relay</p>
              {WALKTHROUGH.map((w) => {
                const c = commands.find((x) => x.id === w.cmd);
                const reason = c ? availability(c) : "Not available";
                return (
                  <button key={w.title} onClick={() => run(commands, w.cmd)} disabled={!!reason} title={reason ?? undefined} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover disabled:cursor-default disabled:opacity-60">
                    <span className="mt-0.5 text-accent">{w.icon}</span>
                    <span>
                      <span className="block text-[13px] font-medium text-ink">{w.title}</span>
                      <span className="block text-[12.5px] text-muted">{w.body}</span>
                      {c?.keybinding && <kbd className="mt-1 inline-block font-mono text-[11px] text-faint">{keyLabel(c.keybinding)}</kbd>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

type Setting = { key: string; group: string; title: string; description: string; control: React.ReactNode };

function SettingsEditor({ ctx }: { ctx: SpecialCtx }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const { prefs, setPrefs, layout, setLayout } = ctx;
  const sel = (value: string | number, options: [string | number, string][], onChange: (v: string) => void, testId: string) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className="h-[26px] min-w-44 rounded-sm border border-rule bg-editor px-2 text-[13px] text-ink">
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  const check = (on: boolean, onChange: (b: boolean) => void, label: string, testId: string) => (
    <label className="flex items-center gap-2 text-[13px] text-ink-2">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );
  const num = (value: number, min: number, max: number, step: number, onChange: (n: number) => void, testId: string) => (
    <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(Math.min(max, Math.max(min, e.target.valueAsNumber)))} data-testid={testId} className="h-[26px] w-28 rounded-sm border border-rule bg-editor px-2 font-mono text-[13px] text-ink" />
  );
  const all: Setting[] = [
    { key: "editor.fontSize", group: "Text Editor", title: "Font Size", description: "Controls the font size in pixels.", control: num(prefs.fontSize, 8, 32, 1, (n) => setPrefs((p) => ({ ...p, fontSize: n })), "set-fontSize") },
    { key: "editor.lineHeight", group: "Text Editor", title: "Line Height", description: "Line height as a multiple of the font size.", control: num(prefs.lineHeight, 1, 2.5, 0.05, (n) => setPrefs((p) => ({ ...p, lineHeight: n })), "set-lineHeight") },
    { key: "editor.fontFamily", group: "Text Editor", title: "Font Family", description: "The typeface for code, in the editor, diffs and the terminal.", control: sel(prefs.codeFont, Object.entries(CODE_FONTS).map(([k, f]) => [k, f.label]), (v) => setPrefs((p) => ({ ...p, codeFont: v as EditorPrefs["codeFont"] })), "set-codeFont") },
    { key: "editor.tabSize", group: "Text Editor", title: "Tab Size", description: "The number of spaces a tab is equal to.", control: sel(prefs.tabSize, [[2, "2"], [4, "4"], [8, "8"]], (v) => setPrefs((p) => ({ ...p, tabSize: Number(v) })), "set-tabSize") },
    { key: "editor.wordWrap", group: "Text Editor", title: "Word Wrap", description: "Controls how lines should wrap.", control: sel(prefs.wrap ? "on" : "off", [["off", "off"], ["on", "on"]], (v) => setPrefs((p) => ({ ...p, wrap: v === "on" })), "set-wrap") },
    { key: "editor.minimap.enabled", group: "Text Editor", title: "Minimap: Enabled", description: "Controls whether the minimap is shown.", control: check(prefs.minimap, (b) => setPrefs((p) => ({ ...p, minimap: b })), "Show the minimap", "set-minimap") },
    { key: "editor.guides.indentation", group: "Text Editor", title: "Guides: Indentation", description: "Controls whether the editor renders indent guides.", control: check(prefs.indentGuides, (b) => setPrefs((p) => ({ ...p, indentGuides: b })), "Render indent guides", "set-indentGuides") },
    { key: "editor.renderWhitespace", group: "Text Editor", title: "Render Whitespace", description: "Controls how the editor renders whitespace characters.", control: sel(prefs.whitespace, [["none", "none"], ["trailing", "trailing"], ["all", "all"]], (v) => setPrefs((p) => ({ ...p, whitespace: v as EditorPrefs["whitespace"] })), "set-whitespace") },
    { key: "editor.lineNumbers", group: "Text Editor", title: "Line Numbers", description: "Controls the display of line numbers.", control: sel(prefs.lineNumbers ? "on" : "off", [["on", "on"], ["off", "off"]], (v) => setPrefs((p) => ({ ...p, lineNumbers: v === "on" })), "set-lineNumbers") },
    { key: "editor.renderLineHighlight", group: "Text Editor", title: "Render Line Highlight", description: "Highlights the line the cursor is on.", control: check(prefs.highlightLine, (b) => setPrefs((p) => ({ ...p, highlightLine: b })), "Highlight the current line", "set-highlightLine") },
    { key: "workbench.colorTheme", group: "Workbench", title: "Color Theme", description: "Specifies the color theme used in the workbench.", control: sel(ctx.theme, [["dark", "Relay Dark"], ["light", "Relay Light"]], (v) => ctx.setTheme(v as Theme), "set-theme") },
    { key: "workbench.fontFamily", group: "Workbench", title: "Font Family", description: "The interface typeface.", control: sel(prefs.uiFont, Object.entries(UI_FONTS).map(([k, f]) => [k, f.label]), (v) => setPrefs((p) => ({ ...p, uiFont: v as EditorPrefs["uiFont"] })), "set-uiFont") },
    { key: "breadcrumbs.enabled", group: "Workbench", title: "Breadcrumbs: Enabled", description: "Show the file path and the symbol under the cursor above the editor.", control: check(layout.breadcrumbs, (b) => ctx.setLayout({ breadcrumbs: b }), "Show breadcrumbs", "set-breadcrumbs") },
    { key: "workbench.statusBar.visible", group: "Workbench", title: "Status Bar: Visible", description: "Controls the visibility of the status bar.", control: check(layout.statusBar, (b) => ctx.setLayout({ statusBar: b }), "Show the status bar", "set-statusBar") },
    { key: "workbench.editor.centeredLayout", group: "Workbench", title: "Centered Layout", description: "Center the editor with a comfortable maximum width.", control: check(layout.centered, (b) => ctx.setLayout({ centered: b }), "Center the editor", "set-centered") },
    { key: "window.zoomLevel", group: "Window", title: "Zoom", description: "The zoom of the whole window (Ctrl+= / Ctrl+-).", control: sel(layout.zoom, [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5].map((z) => [z, `${Math.round(z * 100)}%`]), (v) => ctx.setLayout({ zoom: Number(v) }), "set-zoom") },
    { key: "files.autoSave", group: "Files", title: "Auto Save", description: "Always on in Relay: shared edits are written to disk as you type, so every collaborator and tool sees the same file.", control: <span className="text-[13px] text-muted">afterDelay (fixed)</span> },
    { key: "relay.authorship", group: "Relay", title: "Line Authorship", description: "Show who wrote each line in a gutter beside the code (people, agents, shared lines).", control: check(ctx.showAuthors, ctx.setShowAuthors, "Show line authorship", "set-authors") },
  ];
  const groups = [...new Set(all.map((s) => s.group))];
  const shown = all.filter((s) => (!group || s.group === group) && (!q.trim() || fuzzy(q.trim(), `${s.group} ${s.title} ${s.key} ${s.description}`) !== null));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="settings-editor">
      <div className="shrink-0 border-b border-rule px-8 pb-3 pt-5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings" data-testid="settings-search" className="h-[30px] w-full max-w-[720px] rounded-sm border border-rule bg-sunken px-3 text-[13px] outline-none focus:border-accent" />
        <p className="mt-2 text-[12px] text-muted">User settings, saved in this browser · {shown.length} of {all.length}</p>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 overflow-y-auto px-3 py-4 text-[13px]" aria-label="Setting groups">
          {[null, ...groups].map((g) => (
            <button key={g ?? "all"} onClick={() => setGroup(g)} className={`block w-full rounded-sm px-2 py-1 text-left ${group === g ? "bg-hover text-ink" : "text-muted hover:text-ink"}`}>
              {g ?? "Commonly Used"}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-3">
          {shown.length === 0 && <p className="py-6 text-[13px] text-muted">No settings found.</p>}
          {shown.map((s) => (
            <div key={s.key} className="max-w-[760px] rounded-sm px-3 py-3 hover:bg-hover/40">
              <p className="text-[13px] text-ink">
                <span className="text-muted">{s.group}: </span>
                <span className="font-semibold">{s.title}</span>
              </p>
              <p className="mt-0.5 text-[12.5px] text-muted">{s.description}</p>
              <div className="mt-2">{s.control}</div>
              <p className="mt-1 font-mono text-[10.5px] text-faint">{s.key}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function KeybindingsEditor({ commands }: { commands: Command[] }) {
  const [q, setQ] = useState("");
  const rows = useMemo(
    () =>
      commands
        .filter((c) => c.palette !== false && !c.id.startsWith("editor:") && !c.id.startsWith("task:"))
        .filter((c) => !q.trim() || fuzzy(q.trim(), `${c.category} ${c.title} ${c.id} ${c.keybinding ?? ""} ${c.keybinding ? keyLabel(c.keybinding) : ""}`) !== null)
        .sort((a, b) => Number(!!b.keybinding) - Number(!!a.keybinding) || `${a.category}${a.title}`.localeCompare(`${b.category}${b.title}`)),
    [commands, q],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="keybindings-editor">
      <div className="shrink-0 border-b border-rule px-8 pb-3 pt-5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search in keybindings" aria-label="Search keybindings" className="h-[30px] w-full max-w-[720px] rounded-sm border border-rule bg-sunken px-3 text-[13px] outline-none focus:border-accent" />
        <p className="mt-2 text-[12px] text-muted">{rows.length} commands · VS Code's default shortcuts. Custom keybindings aren't supported yet.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-editor text-left text-[12px] text-muted">
            <tr className="border-b border-rule">
              <th className="w-[44%] px-8 py-1.5 font-medium">Command</th>
              <th className="w-[18%] px-3 py-1.5 font-medium">Keybinding</th>
              <th className="px-3 py-1.5 font-medium">Available</th>
              <th className="w-[12%] px-3 py-1.5 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const reason = availability(c);
              return (
                <tr key={c.id} className="border-b border-rule/50 hover:bg-hover/40">
                  <td className="px-8 py-1.5">
                    <span className="text-muted">{c.category}: </span>
                    <span className="text-ink">{c.title}</span>
                    <span className="ml-2 font-mono text-[10.5px] text-faint">{c.id}</span>
                  </td>
                  <td className="px-3 py-1.5">{c.keybinding ? <kbd className="rounded-sm border border-rule px-1.5 py-px font-mono text-[11px] text-ink-2">{keyLabel(c.keybinding)}</kbd> : <span className="text-faint">—</span>}</td>
                  <td className="truncate px-3 py-1.5 text-[12px] text-muted" title={reason ?? undefined}>
                    {reason ? <span className="text-faint">{reason}</span> : "yes"}
                  </td>
                  <td className="px-3 py-1.5 text-[12px] text-faint">Default</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
