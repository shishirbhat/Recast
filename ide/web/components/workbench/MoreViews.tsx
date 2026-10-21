"use client";

import { useEffect, useState } from "react";
import { Check, CircleSlash, Copy, LogOut, Play, Puzzle, RefreshCw, SquareTerminal, UserPlus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { keyLabel } from "@/lib/commands";
import type { Command } from "@/lib/commands";
import { CODE_FONTS, UI_FONTS } from "../Editor";
import type { CodeFont, EditorPrefs, UiFont } from "../Editor";
import type { Member, ProjectState } from "@/lib/types";
import type { Theme } from "@/lib/theme";
import { Avatar } from "../ui";
import { Section, ViewHeader } from "./Views";
import type { TerminalAvailability } from "./Terminal";

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-2 text-[12.5px] leading-relaxed text-muted">{children}</p>;
}

const rowBtn = "flex h-[22px] w-full items-center gap-2 pl-5 pr-3 text-left text-[13px] text-ink-2 hover:bg-hover";

/* ---------- Run ---------- */

export function RunView({ terminal, onRunInTerminal }: { terminal: TerminalAvailability | null; onRunInTerminal: (command: string) => void }) {
  const [scripts, setScripts] = useState<{ name: string; command: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api<{ scripts: { name: string; command: string }[] }>("GET", "/scripts").then(
      (r) => setScripts(r.scripts),
      (e) => setError(e instanceof ApiError ? e.message : String(e)),
    );
  };
  useEffect(load, []);
  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Run"
        actions={
          <button aria-label="Refresh scripts" title="Refresh scripts" onClick={load} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
            <RefreshCw size={13} />
          </button>
        }
      />
      <Section title="package.json scripts" count={scripts?.length}>
        {error && <Empty>Couldn&apos;t read scripts: {error}</Empty>}
        {!error && scripts === null && <Empty>Loading…</Empty>}
        {scripts?.length === 0 && <Empty>No package.json scripts in this project.</Empty>}
        {scripts?.map((s) => (
          <div key={s.name} className="group flex h-[22px] items-center gap-2 pl-5 pr-2 text-[13px] hover:bg-hover">
            <span className="text-ink">{s.name}</span>
            <span className="truncate font-mono text-[11.5px] text-faint">{s.command}</span>
            <button
              aria-label={`Run ${s.name} in the terminal`}
              title={terminal?.available ? `Run "npm run ${s.name}" in the terminal` : (terminal?.reason ?? "Terminal unavailable")}
              disabled={!terminal?.available}
              onClick={() => onRunInTerminal(`npm run ${s.name}`)}
              className="ml-auto grid size-5 shrink-0 place-items-center rounded-sm text-ok hover:bg-sunken disabled:text-faint"
            >
              <Play size={12} />
            </button>
          </div>
        ))}
        {!terminal?.available && terminal && <Empty>Scripts run in the integrated terminal. {terminal.reason}</Empty>}
      </Section>
      <Section title="Debug" defaultOpen={false}>
        <Empty>
          <CircleSlash size={12} className="mr-1 inline" />
          Breakpoint debugging isn&apos;t available yet: Relay has no debug adapter. Use the terminal for <code className="font-mono">node --inspect</code> in the meantime.
        </Empty>
      </Section>
    </div>
  );
}

/* ---------- Extensions ---------- */

const BUILT_IN = [
  { id: "javascript", name: "JavaScript & TypeScript", detail: "Syntax, folding, bracket matching", files: ".js .jsx .ts .tsx .mjs .cjs" },
  { id: "json", name: "JSON", detail: "Syntax and folding", files: ".json" },
  { id: "markdown", name: "Markdown", detail: "Syntax", files: ".md .mdx" },
  { id: "css", name: "CSS", detail: "Syntax", files: ".css" },
  { id: "html", name: "HTML", detail: "Syntax", files: ".html" },
  { id: "python", name: "Python", detail: "Syntax", files: ".py" },
  { id: "collab", name: "Relay collaboration", detail: "Live editing, cursors and presence", files: "all text files" },
];

export function ExtensionsView() {
  return (
    <div className="flex h-full flex-col">
      <ViewHeader title="Extensions" />
      <div className="px-3 pb-2">
        <input disabled placeholder="Search the marketplace" title="The extension marketplace isn't available yet" className="h-[26px] w-full cursor-not-allowed rounded-sm border border-rule bg-editor px-2 text-[13px] text-faint" />
      </div>
      <Section title="Built in" count={BUILT_IN.length}>
        {BUILT_IN.map((x) => (
          <div key={x.id} className="flex gap-2.5 px-5 py-1.5 hover:bg-hover">
            <Puzzle size={26} strokeWidth={1.3} className="mt-0.5 shrink-0 text-faint" />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[13px] text-ink">
                {x.name} <Check size={12} className="text-ok" aria-label="enabled" />
              </p>
              <p className="truncate text-[12px] text-muted">{x.detail}</p>
              <p className="truncate font-mono text-[11px] text-faint">{x.files}</p>
            </div>
          </div>
        ))}
      </Section>
      <Section title="Marketplace">
        <Empty>Not available yet. Relay runs CodeMirror in the browser, so VS Code extensions can&apos;t load here; an extension host and a registry are planned. Language intelligence (LSP) is the next step.</Empty>
      </Section>
    </div>
  );
}

/* ---------- Community ---------- */

export function CommunityView({ state, online, where, onInvite }: { state: ProjectState; online: Set<string>; where: (id: string) => string | undefined; onInvite: () => void }) {
  const isOwner = state.me.role === "owner";
  const sorted = [...state.members].sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.name.localeCompare(b.name));
  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Community"
        actions={
          isOwner && (
            <button aria-label="Invite collaborator" title="Invite collaborator" onClick={onInvite} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
              <UserPlus size={13} />
            </button>
          )
        }
      />
      <Section title="People in this project" count={state.members.length}>
        {sorted.map((m) => (
          <div key={m.id} className="flex items-center gap-2.5 px-5 py-1 text-[13px] leading-[18px] hover:bg-hover">
            <span className="relative">
              <Avatar name={m.name} color={m.color} size={20} />
              <span className={`absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-sidebar ${online.has(m.id) ? "bg-ok" : "bg-faint"}`} aria-label={online.has(m.id) ? "online" : "offline"} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">
                {m.name}
                {m.id === state.me.id ? " (you)" : ""}
              </span>
              <span className="block truncate text-[11.5px] leading-[16px] text-faint">{online.has(m.id) ? (where(m.id) ?? "online") : "offline"}</span>
            </span>
            <span className="text-[11px] text-muted">{m.role}</span>
          </div>
        ))}
        {isOwner && (
          <button onClick={onInvite} className={rowBtn}>
            <UserPlus size={13} className="text-muted" /> Invite someone…
          </button>
        )}
      </Section>
      <Section title="Shared resources" defaultOpen={false}>
        <Empty>A public community hub (shared workflows, templates, discussions) isn&apos;t built yet. Project-level collaboration, presence and invites above are live.</Empty>
      </Section>
    </div>
  );
}

/* ---------- Accounts & settings ---------- */

export function AccountView({ me, onSignOut }: { me: Member; onSignOut: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <ViewHeader title="Account" />
      <div className="flex items-center gap-3 px-5 py-3">
        <Avatar name={me.name} color={me.color} size={36} />
        <div>
          <p className="text-[14px] text-ink">{me.name}</p>
          <p className="text-[12px] text-muted">
            {me.role} · id <span className="font-mono">{me.id}</span>
          </p>
        </div>
      </div>
      <Section title="Session">
        <Empty>Signed in with a one-time project invite. Sessions last 7 days; an owner can revoke access at any time.</Empty>
        <button onClick={onSignOut} className={rowBtn} data-testid="sign-out">
          <LogOut size={13} className="text-muted" /> Sign out
        </button>
      </Section>
      <Section title="What your role can do">
        <ul className="space-y-0.5 px-5 pb-1 text-[12.5px] text-muted">
          <li>Read files, tasks and contracts: yes</li>
          <li>Edit files, create and run tasks: {me.role === "viewer" ? "no" : "yes"}</li>
          <li>Approve tasks, contracts and integrations: {me.role === "owner" ? "yes" : "no"}</li>
          <li>Terminal, verification commands, invites: {me.role === "owner" ? "yes" : "no"}</li>
        </ul>
      </Section>
    </div>
  );
}

export function SettingsView({ theme, setTheme, commands, terminal, onResetLayout, prefs, setPrefs, showAuthors, setShowAuthors }: { theme: Theme; setTheme: (t: Theme) => void; commands: Command[]; terminal: TerminalAvailability | null; onResetLayout: () => void; prefs: EditorPrefs; setPrefs: (p: EditorPrefs) => void; showAuthors: boolean; setShowAuthors: (b: boolean) => void }) {
  const [filter, setFilter] = useState("");
  const bound = commands.filter((c) => c.keybinding && `${c.category} ${c.title}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex h-full flex-col">
      <ViewHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Appearance">
          <div className="flex items-center justify-between px-5 py-1 text-[13px]">
            <span className="text-ink-2">Color theme</span>
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} className="h-[24px] rounded-sm border border-rule bg-editor px-1.5 text-[12.5px] text-ink" aria-label="Color theme">
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <button onClick={onResetLayout} className={rowBtn}>
            <RefreshCw size={12} className="text-muted" /> Reset layout
          </button>
        </Section>
        <Section title="Typefaces">
          <label className="flex items-center justify-between px-5 py-1 text-[13px]">
            <span className="text-ink-2">Interface</span>
            <select value={prefs.uiFont} onChange={(e) => setPrefs({ ...prefs, uiFont: e.target.value as UiFont })} className="h-[24px] rounded-sm border border-rule bg-editor px-1.5 text-[12.5px] text-ink" aria-label="Interface font" data-testid="pref-uiFont">
              {Object.entries(UI_FONTS).map(([k, f]) => (
                <option key={k} value={k}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between px-5 py-1 text-[13px]">
            <span className="text-ink-2">Code</span>
            <select value={prefs.codeFont} onChange={(e) => setPrefs({ ...prefs, codeFont: e.target.value as CodeFont })} className="h-[24px] rounded-sm border border-rule bg-editor px-1.5 text-[12.5px] text-ink" aria-label="Code font" data-testid="pref-codeFont">
              {Object.entries(CODE_FONTS).map(([k, f]) => (
                <option key={k} value={k}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </Section>
        <Section title="Editor">
          {(
            [
              ["Font size", "fontSize", [11, 12, 13, 14, 15, 16, 18, 20]],
              ["Line height", "lineHeight", [1.4, 1.5, 1.6, 1.65, 1.7, 1.8]],
              ["Tab size", "tabSize", [1, 2, 3, 4, 5, 6, 7, 8]],
            ] as const
          ).map(([label, key, opts]) => (
            <label key={key} className="flex items-center justify-between px-5 py-1 text-[13px]">
              <span className="text-ink-2">{label}</span>
              <select value={prefs[key]} onChange={(e) => setPrefs({ ...prefs, [key]: Number(e.target.value) })} className="h-[24px] rounded-sm border border-rule bg-editor px-1.5 font-mono text-[12px] text-ink" aria-label={label} data-testid={`pref-${key}`}>
                {opts.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(
            [
              ["Word wrap", "wrap"],
              ["Minimap", "minimap"],
              ["Indent guides", "indentGuides"],
              ["Line numbers", "lineNumbers"],
            ] as const
          ).map(([label, key]) => (
            <label key={key} className="flex items-center justify-between px-5 py-1 text-[13px]">
              <span className="text-ink-2">{label}</span>
              <input type="checkbox" checked={prefs[key]} onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })} data-testid={`pref-${key}`} />
            </label>
          ))}
          <label className="flex items-center justify-between px-5 py-1 text-[13px]">
            <span className="text-ink-2">Render whitespace</span>
            <select value={prefs.whitespace} onChange={(e) => setPrefs({ ...prefs, whitespace: e.target.value as EditorPrefs["whitespace"] })} className="h-[24px] rounded-sm border border-rule bg-editor px-1.5 text-[12.5px] text-ink" aria-label="Render whitespace" data-testid="pref-whitespace">
              <option value="none">None</option>
              <option value="trailing">Trailing</option>
              <option value="all">All</option>
            </select>
          </label>
          <label className="flex items-center justify-between px-5 py-1 text-[13px]">
            <span className="text-ink-2">Show line authorship</span>
            <input type="checkbox" checked={showAuthors} onChange={(e) => setShowAuthors(e.target.checked)} data-testid="pref-authors" />
          </label>
        </Section>
        <Section title="Terminal">
          <p className="flex items-start gap-2 px-5 py-1 text-[12.5px] text-muted">
            <SquareTerminal size={13} className="mt-0.5 shrink-0" />
            {terminal === null ? "Checking…" : terminal.available ? "Available: shells run on the Relay host, in the project folder." : terminal.reason}
          </p>
        </Section>
        <Section title="Keyboard shortcuts" count={bound.length}>
          <div className="px-3 pb-1.5">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter shortcuts" className="h-[24px] w-full rounded-sm border border-rule bg-editor px-2 text-[12.5px] outline-none focus:border-accent" />
          </div>
          {bound.map((c) => (
            <div key={c.id} className="flex h-[22px] items-center gap-2 pl-5 pr-3 text-[12.5px]">
              <span className="truncate text-ink-2">
                <span className="text-muted">{c.category}:</span> {c.title}
              </span>
              <kbd className="ml-auto shrink-0 rounded-sm border border-rule px-1 font-sans text-[11px] text-muted">{keyLabel(c.keybinding!)}</kbd>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

/* ---------- Output panel ---------- */

interface OutputData {
  evidence: { id: string; task_id: string; kind: string; command: string | null; exit_code: number | null; output: string; created_at: string }[];
  integrations: { id: string; tasks: string[]; status: string; results: { command: string; exitCode: number | null; output: string }[]; created_at: string }[];
}

export function OutputPanel({ tick }: { tick: number }) {
  const [data, setData] = useState<OutputData | null>(null);
  useEffect(() => {
    void api<OutputData>("GET", "/output").then(setData, () => setData(null));
  }, [tick]);
  if (!data) return <p className="p-3 text-[12.5px] text-muted">Loading…</p>;
  const rows = [
    ...data.integrations.flatMap((i) => i.results.map((r) => ({ key: `${i.id}:${r.command}`, at: i.created_at, label: `integration ${i.tasks.join(" + ")}`, command: r.command, exit: r.exitCode, output: r.output }))),
    ...data.evidence.filter((e) => e.kind === "command").map((e) => ({ key: e.id, at: e.created_at, label: e.task_id, command: e.command ?? "", exit: e.exit_code, output: e.output })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!rows.length) return <p className="p-3 text-[12.5px] text-muted">Nothing yet. Output from checks Relay runs (verification, integration tests) appears here.</p>;
  return (
    <div className="py-1 font-mono text-[12px]">
      {rows.map((r) => (
        <details key={r.key} className="border-b border-rule px-4 py-1">
          <summary className="cursor-pointer text-ink-2">
            <span className={r.exit === 0 ? "text-ok" : "text-danger"}>{r.exit === 0 ? "passed" : r.exit === null ? "timed out" : `exit ${r.exit}`}</span> <span className="text-muted">[{r.label}]</span> {r.command} <span className="text-faint">{new Date(r.at).toLocaleTimeString([], { hour12: false })}</span>
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11.5px] text-muted">{r.output || "(no output)"}</pre>
        </details>
      ))}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button aria-label={label} title={label} onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))} className="grid size-5 place-items-center text-muted hover:text-ink">
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
