"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  CircleAlert,
  Eye,
  Files,
  GitBranch,
  ListChecks,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Search,
  Sun,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { DocSession } from "@/lib/collab";
import { applyTheme, initialTheme } from "@/lib/theme";
import type { Theme } from "@/lib/theme";
import type { Member, ProjectState } from "@/lib/types";
import { useProject } from "@/lib/useProject";
import { Coordination } from "../Coordination";
import type { CoordTab } from "../Coordination";
import { Editor } from "../Editor";
import { FileTree } from "../FileTree";
import { Avatar, Mark } from "../ui";
import { CommandPalette, keyLabel, mod } from "./CommandPalette";
import type { Command } from "./CommandPalette";
import { BottomPanel, Section, SearchView, SourceControlView, ViewHeader, problemsOf } from "./Views";
import type { PanelTab } from "./Views";

type View = "explorer" | "search" | "scm";

/* ---------- layout persistence ---------- */

interface Layout {
  view: View;
  sidebar: boolean;
  panel: boolean;
  relay: boolean;
  sidebarW: number;
  relayW: number;
  panelH: number;
}
const DEFAULT_LAYOUT: Layout = { view: "explorer", sidebar: true, panel: false, relay: true, sidebarW: 256, relayW: 380, panelH: 220 };
const LAYOUT_KEY = "relay.layout";
function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** A drag handle between two areas, like VS Code's sashes. */
function Sash({ dir, onDrag }: { dir: "x" | "y"; onDrag: (delta: number) => void }) {
  const start = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation={dir === "x" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        start.current = dir === "x" ? e.clientX : e.clientY;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const p = dir === "x" ? e.clientX : e.clientY;
        onDrag(p - start.current);
        start.current = p;
      }}
      className={`group relative z-20 shrink-0 ${dir === "x" ? "w-0 cursor-col-resize" : "h-0 cursor-row-resize"}`}
    >
      <span className={`absolute transition-colors group-hover:bg-accent/60 ${dir === "x" ? "-left-[2px] inset-y-0 w-[4px]" : "-top-[2px] inset-x-0 h-[4px]"}`} />
    </div>
  );
}

function useSession(session: DocSession | null) {
  const sub = useCallback(
    (fn: () => void) => {
      if (!session) return () => {};
      const off = session.subscribe(fn);
      session.provider.awareness.on("change", fn);
      return () => {
        off();
        session.provider.awareness.off("change", fn);
      };
    },
    [session],
  );
  const snap = useCallback(() => (session ? `${session.status}|${session.peers().map((p) => `${p.clientId}`).join(",")}` : "none"), [session]);
  useSyncExternalStore(sub, snap, () => "none");
  return session ? { status: session.status, peers: session.peers() } : { status: "offline" as const, peers: [] };
}

const LANG: Record<string, string> = { js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript JSX", ts: "TypeScript", tsx: "TypeScript JSX", json: "JSON", md: "Markdown", css: "CSS", html: "HTML", py: "Python" };

interface Toast {
  id: number;
  msg: string;
  tone: "ok" | "danger";
}

export function Workbench() {
  const { load, events, files, live, refresh, refreshFiles } = useProject();
  const [theme, setTheme] = useState<Theme>("light");
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [palette, setPalette] = useState<{ open: boolean; mode: "files" | "commands" }>({ open: false, mode: "files" });
  const [panelTab, setPanelTab] = useState<PanelTab>("problems");
  const [coordTab, setCoordTab] = useState<CoordTab>("tasks");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [newTaskNonce, setNewTaskNonce] = useState(0);
  const [searchNonce, setSearchNonce] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sessions = useRef(new Map<string, DocSession>());

  useEffect(() => {
    setTheme(initialTheme());
    setLayout(loadLayout());
    document.body.classList.add("workbench");
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {}
  }, [layout]);
  const set = useCallback((patch: Partial<Layout>) => setLayout((l) => ({ ...l, ...patch })), []);

  const notify = useCallback((msg: string, tone: "ok" | "danger" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "danger" ? 7000 : 3800);
  }, []);

  const me = load.kind === "ready" ? load.state.me : null;
  const sessionFor = useCallback((path: string, member: Member) => {
    let s = sessions.current.get(path);
    if (!s) {
      s = new DocSession(path, member);
      sessions.current.set(path, s);
    }
    return s;
  }, []);

  const open = useCallback((path: string, line?: number) => {
    setTabs((t) => (t.includes(path) ? t : [...t, path]));
    setActive(path);
    setRecent((r) => [path, ...r.filter((x) => x !== path)].slice(0, 12));
    if (line) setReveal({ line, nonce: Date.now() });
  }, []);
  const closeTab = useCallback(
    (path: string) => {
      sessions.current.get(path)?.destroy();
      sessions.current.delete(path);
      setTabs((t) => {
        const next = t.filter((x) => x !== path);
        setActive((a) => (a === path ? (next.at(-1) ?? null) : a));
        return next;
      });
    },
    [],
  );
  useEffect(() => () => sessions.current.forEach((s) => s.destroy()), []);

  const session = me && active ? sessionFor(active, me) : null;
  const { status, peers } = useSession(session);
  const onCursor = useCallback((l: number, c: number) => setCursor([l, c]), []);

  const showTask = useCallback(
    (id: string) => {
      set({ relay: true });
      setCoordTab("tasks");
      setSelectedTask(id);
    },
    [set],
  );
  const showView = useCallback((v: View) => {
    setLayout((l) => ({ ...l, view: v, sidebar: l.view === v ? !l.sidebar : true }));
    if (v === "search") setSearchNonce((n) => n + 1);
  }, []);

  const state = load.kind === "ready" ? load.state : null;
  const commands: Command[] = useMemo(() => {
    if (!state || !me) return [];
    const canEdit = me.role !== "viewer";
    const isOwner = me.role === "owner";
    const cmds: Command[] = [
      { id: "files", category: "Go", title: "Go to File…", keybinding: "Mod+P", run: () => setPalette({ open: true, mode: "files" }) },
      { id: "explorer", category: "View", title: "Show Explorer", keybinding: "Mod+Shift+E", run: () => set({ view: "explorer", sidebar: true }) },
      { id: "search", category: "View", title: "Search in Project", keybinding: "Mod+Shift+F", run: () => (set({ view: "search", sidebar: true }), setSearchNonce((n) => n + 1)) },
      { id: "scm", category: "View", title: "Show Source Control", keybinding: "Mod+Shift+G", run: () => set({ view: "scm", sidebar: true }) },
      { id: "sidebar", category: "View", title: "Toggle Primary Side Bar", keybinding: "Mod+B", run: () => setLayout((l) => ({ ...l, sidebar: !l.sidebar })) },
      { id: "panel", category: "View", title: "Toggle Panel", keybinding: "Mod+J", run: () => setLayout((l) => ({ ...l, panel: !l.panel })) },
      { id: "relay", category: "View", title: "Toggle Relay Side Bar", keybinding: "Mod+Alt+B", run: () => setLayout((l) => ({ ...l, relay: !l.relay })) },
      { id: "problems", category: "View", title: "Show Problems", keybinding: "Mod+Shift+M", run: () => (set({ panel: true }), setPanelTab("problems")) },
      { id: "agents", category: "View", title: "Show Agent Runs", run: () => (set({ panel: true }), setPanelTab("agents")) },
      { id: "activity", category: "View", title: "Show Activity", run: () => (set({ panel: true }), setPanelTab("activity")) },
      { id: "theme", category: "Preferences", title: theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme", keybinding: "Mod+Alt+T", run: () => setTheme((t) => (t === "dark" ? "light" : "dark")) },
      { id: "contracts", category: "Relay", title: "Show Contracts", run: () => (set({ relay: true }), setCoordTab("contracts"), setSelectedTask(null)) },
      ...(active ? [{ id: "close", category: "View", title: "Close Editor", keybinding: "Mod+W", run: () => closeTab(active) }] : []),
      ...state.tasks.map((t) => ({ id: `task:${t.id}`, category: "Relay", title: `Open Task ${t.id} — ${t.objective}`, run: () => showTask(t.id) })),
    ];
    if (canEdit) {
      cmds.push({ id: "new-task", category: "Relay", title: "New Task…", run: () => (set({ relay: true }), setCoordTab("tasks"), setSelectedTask(null), setNewTaskNonce((n) => n + 1)) });
      for (const t of state.tasks.filter((x) => x.state === "queued"))
        cmds.push({ id: `run:${t.id}`, category: "Relay", title: `Run with Claude Code: ${t.id}`, run: () => void api("POST", `/tasks/${encodeURIComponent(t.id)}/run`).then(() => (notify(`Claude Code started on ${t.id} in its own worktree.`), refresh(), showTask(t.id)), (e) => notify(e instanceof ApiError ? e.message : String(e), "danger")) });
    }
    if (isOwner)
      cmds.push({
        id: "invite",
        category: "Relay",
        title: "Invite Collaborator…",
        run: () => {
          const name = prompt("Collaborator's name");
          if (!name) return;
          const role = (prompt("Role: editor, viewer or owner", "editor") ?? "editor").trim();
          void api<{ joinPath: string }>("POST", "/members", { name, role }).then(
            (r) => {
              const link = `${location.origin}${r.joinPath}`;
              void navigator.clipboard?.writeText(link).catch(() => {});
              notify(`One-time invite for ${name} copied to the clipboard (valid 72 hours).`);
            },
            (e) => notify(e instanceof ApiError ? e.message : String(e), "danger"),
          );
        },
      });
    return cmds;
  }, [state, me, theme, active, set, closeTab, showTask, notify, refresh]);

  // Keyboard shortcuts, from the same command list the palette shows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modKey = e.metaKey || e.ctrlKey;
      if (!modKey) return;
      const k = e.key.toLowerCase();
      const combo = `Mod+${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${k.toUpperCase()}`;
      if (combo === "Mod+Shift+P") {
        e.preventDefault();
        return setPalette({ open: true, mode: "commands" });
      }
      const cmd = commands.find((c) => c.keybinding === combo);
      if (cmd) {
        e.preventDefault();
        cmd.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commands]);

  if (load.kind === "loading") return <Splash />;
  if (load.kind === "signed-out") return <SignedOut />;
  if (load.kind === "error") return <Splash message={load.message} />;
  const s: ProjectState = load.state;

  const presence = new Map(s.presence.map((p) => [p.path, p.members]));
  if (active) presence.set(active, [...new Set([...(presence.get(active) ?? []), me!.id, ...peers.map((p) => p.id)])]);
  const online = new Set([...presence.values()].flat());
  const membersById = new Map(s.members.map((m) => [m.id, m]));
  const where = (id: string) => [...presence.entries()].find(([, ms]) => ms.includes(id))?.[0];
  const problems = problemsOf(s);
  const needsPerson = s.tasks.filter((t) => t.state === "review_required" || t.state === "proposed" || t.state === "blocked").length;
  const runningAgents = s.tasks.flatMap((t) => t.runs).filter((r) => r.status === "running").length;
  const ext = active?.split(".").pop() ?? "";

  const activity: { id: View | "relay"; icon: React.ReactNode; label: string; badge?: number }[] = [
    { id: "explorer", icon: <Files size={21} strokeWidth={1.6} />, label: `Explorer (${keyLabel("Mod+Shift+E")})` },
    { id: "search", icon: <Search size={21} strokeWidth={1.6} />, label: `Search (${keyLabel("Mod+Shift+F")})` },
    { id: "scm", icon: <GitBranch size={21} strokeWidth={1.6} />, label: `Source Control (${keyLabel("Mod+Shift+G")})` },
    { id: "relay", icon: <ListChecks size={21} strokeWidth={1.6} />, label: `Relay (${keyLabel("Mod+Alt+B")})`, badge: needsPerson },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-chrome text-ink">
      {/* ---------- Title bar ---------- */}
      <header className="grid h-[38px] shrink-0 grid-cols-[1fr_minmax(280px,560px)_1fr] items-center border-b border-rule bg-chrome px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Mark size={18} />
          <span className="text-[13px] font-semibold tracking-tight">Relay</span>
          <span className="truncate text-[12.5px] text-chrome-ink">
            <span className="serif-em text-[15px] text-ink">{s.project.name}</span>
          </span>
        </div>
        <button
          onClick={() => setPalette({ open: true, mode: "files" })}
          data-testid="command-center"
          className="group mx-auto flex h-[26px] w-full items-center justify-center gap-2 rounded-md border border-rule bg-editor/70 px-3 text-[12.5px] text-muted transition-colors hover:border-rule-strong hover:bg-editor"
        >
          <Search size={13} />
          <span className="truncate">{s.project.name}</span>
          <kbd className="ml-auto hidden rounded border border-rule px-1 font-sans text-[10.5px] text-faint sm:inline">{mod}P</kbd>
        </button>
        <div className="flex items-center justify-end gap-1">
          <div className="mr-2 flex items-center gap-1" aria-label="People in this project">
            <AnimatePresence>
              {s.members
                .filter((m) => online.has(m.id) || m.id === me!.id)
                .map((m) => (
                  <Avatar key={m.id} name={m.name} color={m.color} size={22} ring={m.id !== me!.id} title={`${m.name}${m.id === me!.id ? " (you)" : ""}${where(m.id) ? ` · ${where(m.id)}` : ""}`} />
                ))}
            </AnimatePresence>
          </div>
          {[
            { on: layout.sidebar, label: `Toggle Primary Side Bar (${keyLabel("Mod+B")})`, icon: <PanelLeft size={15} />, run: () => set({ sidebar: !layout.sidebar }) },
            { on: layout.panel, label: `Toggle Panel (${keyLabel("Mod+J")})`, icon: <PanelBottom size={15} />, run: () => set({ panel: !layout.panel }) },
            { on: layout.relay, label: `Toggle Relay Side Bar (${keyLabel("Mod+Alt+B")})`, icon: <PanelRight size={15} />, run: () => set({ relay: !layout.relay }) },
          ].map((b) => (
            <button key={b.label} aria-label={b.label} title={b.label} aria-pressed={b.on} onClick={b.run} className={`grid size-[26px] place-items-center rounded-md hover:bg-hover ${b.on ? "text-ink" : "text-faint"}`}>
              {b.icon}
            </button>
          ))}
          <button aria-label="Toggle theme" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="grid size-[26px] place-items-center rounded-md text-chrome-ink hover:bg-hover hover:text-ink">
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------- Activity bar ---------- */}
        <nav aria-label="Views" className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-rule bg-chrome pt-1">
          {activity.map((a) => {
            const on = a.id === "relay" ? layout.relay : layout.sidebar && layout.view === a.id;
            return (
              <button
                key={a.id}
                aria-label={a.label}
                title={a.label}
                onClick={() => (a.id === "relay" ? set({ relay: !layout.relay }) : showView(a.id))}
                className={`relative grid h-11 w-12 place-items-center transition-colors ${on ? "text-ink" : "text-faint hover:text-ink-2"}`}
              >
                {on && <motion.span layoutId={a.id === "relay" ? undefined : "activity-indicator"} className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-accent" />}
                {a.icon}
                {!!a.badge && <span className="absolute right-2 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-attention px-1 text-[10px] font-bold text-white">{a.badge}</span>}
              </button>
            );
          })}
          <div className="mt-auto mb-2 flex flex-col items-center gap-0.5">
            <button aria-label="Agent runs" title="Agent runs" onClick={() => (set({ panel: true }), setPanelTab("agents"))} className="relative grid h-10 w-12 place-items-center text-faint hover:text-ink-2">
              <Bot size={20} strokeWidth={1.6} />
              {runningAgents > 0 && <span className="absolute right-3 top-2 size-2 animate-pulse rounded-full bg-accent" />}
            </button>
            <span title={`${online.size} people here`} className="relative grid h-10 w-12 place-items-center text-faint">
              <Users size={20} strokeWidth={1.6} />
              <span className="absolute right-2.5 top-2 text-[10px] font-bold text-muted">{online.size}</span>
            </span>
          </div>
        </nav>

        {/* ---------- Primary side bar ---------- */}
        {layout.sidebar && (
          <>
            <aside style={{ width: layout.sidebarW }} className="flex shrink-0 flex-col overflow-hidden border-r border-rule bg-sidebar">
              {layout.view === "explorer" && (
                <div className="flex h-full flex-col">
                  <ViewHeader title="Explorer" />
                  {tabs.length > 0 && (
                    <Section title="Open Editors" count={tabs.length}>
                      {tabs.map((t) => (
                        <div key={t} className={`group flex h-6 items-center gap-1.5 pl-5 pr-2 text-[13px] ${t === active ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-hover"}`}>
                          <button onClick={() => open(t)} className="truncate text-left">
                            {t.split("/").pop()} <span className="text-[11.5px] text-faint">{t.split("/").slice(0, -1).join("/")}</span>
                          </button>
                          <button aria-label={`Close ${t}`} onClick={() => closeTab(t)} className="ml-auto opacity-0 group-hover:opacity-100">
                            <X size={12} className="text-muted" />
                          </button>
                        </div>
                      ))}
                    </Section>
                  )}
                  <div className="min-h-0 flex-1 border-t border-rule">
                    <FileTree
                      files={files}
                      active={active}
                      presence={presence}
                      members={s.members}
                      me={me!}
                      canEdit={me!.role !== "viewer"}
                      onOpen={open}
                      onCreate={(p) =>
                        void api("POST", "/files", { path: p })
                          .then(() => (refreshFiles(), open(p)))
                          .catch((e) => notify(e instanceof ApiError ? e.message : String(e), "danger"))
                      }
                    />
                  </div>
                </div>
              )}
              {layout.view === "search" && <SearchView onOpen={open} focusNonce={searchNonce} />}
              {layout.view === "scm" && <SourceControlView onOpen={open} tick={events.length} />}
            </aside>
            <Sash dir="x" onDrag={(d) => setLayout((l) => ({ ...l, sidebarW: Math.min(560, Math.max(180, l.sidebarW + d)) }))} />
          </>
        )}

        {/* ---------- Editor group + panel ---------- */}
        <div className="flex min-w-0 flex-1 flex-col bg-editor">
          <div className="flex min-h-0 flex-1 flex-col">
            {tabs.length > 0 && (
              <div className="flex h-[35px] shrink-0 items-stretch overflow-x-auto border-b border-rule bg-sidebar" role="tablist">
                {tabs.map((t) => {
                  const on = t === active;
                  const here = (presence.get(t) ?? []).filter((id) => id !== me!.id);
                  return (
                    <div key={t} role="tab" aria-selected={on} onMouseDown={(e) => e.button === 1 && closeTab(t)} className={`group relative flex min-w-0 items-center gap-2 border-r border-rule pl-3 pr-1.5 text-[13px] ${on ? "bg-editor text-ink" : "text-muted hover:bg-hover hover:text-ink"}`}>
                      {on && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
                      <button onClick={() => setActive(t)} className="max-w-48 truncate">
                        {t.split("/").pop()}
                      </button>
                      {here.length > 0 && (
                        <span className="flex gap-0.5">
                          {here.slice(0, 3).map((id) => (
                            <span key={id} title={membersById.get(id)?.name} className="size-1.5 rounded-full" style={{ background: membersById.get(id)?.color }} />
                          ))}
                        </span>
                      )}
                      <button aria-label={`Close ${t}`} onClick={() => closeTab(t)} className={`grid size-5 place-items-center rounded hover:bg-hover ${on ? "text-muted" : "text-transparent group-hover:text-muted"}`}>
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {session ? (
              <>
                <div className="flex h-[26px] shrink-0 items-center justify-between px-4 text-[12px] text-muted">
                  <span className="truncate">
                    {active!.split("/").map((seg, i, all) => (
                      <span key={i}>
                        <span className={i === all.length - 1 ? "text-ink-2" : ""}>{seg}</span>
                        {i < all.length - 1 && <span className="px-1.5 text-faint">›</span>}
                      </span>
                    ))}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <AnimatePresence>
                      {peers.map((p) => (
                        <motion.span key={p.clientId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="inline-flex items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold" style={{ background: p.color + "22", color: p.color }}>
                          <span className="size-1.5 rounded-full" style={{ background: p.color }} /> {p.name}
                        </motion.span>
                      ))}
                    </AnimatePresence>
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <Editor key={session.path} session={session} readOnly={me!.role === "viewer"} onCursor={onCursor} reveal={reveal} />
                </div>
              </>
            ) : (
              <Welcome name={me!.name} onPalette={(m) => setPalette({ open: true, mode: m })} />
            )}
          </div>
          {layout.panel && (
            <>
              <Sash dir="y" onDrag={(d) => setLayout((l) => ({ ...l, panelH: Math.min(600, Math.max(120, l.panelH - d)) }))} />
              <div style={{ height: layout.panelH }} className="shrink-0 border-t border-rule">
                <BottomPanel tab={panelTab} setTab={setPanelTab} state={s} events={events} members={s.members} onTask={showTask} onOpen={open} onClose={() => set({ panel: false })} />
              </div>
            </>
          )}
        </div>

        {/* ---------- Secondary side bar: Relay ---------- */}
        {layout.relay && (
          <>
            <Sash dir="x" onDrag={(d) => setLayout((l) => ({ ...l, relayW: Math.min(640, Math.max(300, l.relayW - d)) }))} />
            <aside style={{ width: layout.relayW }} className="shrink-0 overflow-hidden border-l border-rule bg-sidebar">
              <Coordination state={s} onOpenFile={open} refresh={refresh} notify={notify} tab={coordTab} setTab={setCoordTab} selected={selectedTask} setSelected={setSelectedTask} newTaskNonce={newTaskNonce} />
            </aside>
          </>
        )}
      </div>

      {/* ---------- Status bar ---------- */}
      <footer className="flex h-[24px] shrink-0 items-center gap-0.5 bg-status-bg px-1 text-[12px] text-status-fg">
        <StatusItem title="Branch">
          <GitBranch size={12} /> {s.project.head ?? "–"}
        </StatusItem>
        <StatusItem title="Collaboration sync" testId="sync-status">
          <span className={`size-1.5 rounded-full ${session ? (status === "synced" ? "bg-[#7ee2b0]" : status === "connecting" ? "animate-pulse bg-[#ffd27a]" : "bg-[#ff9aa8]") : live ? "bg-[#7ee2b0]" : "bg-[#ff9aa8]"}`} />
          {session ? (status === "synced" ? "Synced" : status === "connecting" ? "Connecting…" : "Offline · edits kept") : live ? "Live" : "Reconnecting…"}
        </StatusItem>
        <StatusItem title="Coordination problems" onClick={() => (set({ panel: true }), setPanelTab("problems"))}>
          <CircleAlert size={12} /> {problems.filter((p) => p.severity === "error").length} <TriangleAlert size={12} className="ml-1" /> {problems.filter((p) => p.severity === "warning").length}
        </StatusItem>
        {runningAgents > 0 && (
          <StatusItem title="Agent runs" onClick={() => (set({ panel: true }), setPanelTab("agents"))}>
            <Bot size={12} /> {runningAgents} working
          </StatusItem>
        )}
        <span className="ml-auto" />
        {session && <StatusItem title="Cursor position">Ln {cursor[0]}, Col {cursor[1]}</StatusItem>}
        {session && <StatusItem title="Encoding">UTF-8</StatusItem>}
        {session && <StatusItem title="Language">{LANG[ext] ?? "Plain Text"}</StatusItem>}
        <StatusItem title="People here">
          <Users size={12} /> {online.size}
        </StatusItem>
        <StatusItem title="Signed in as">
          {me!.role === "viewer" && <Eye size={12} />}
          {me!.name} · {me!.role}
        </StatusItem>
      </footer>

      <CommandPalette open={palette.open} mode={palette.mode} files={files} commands={commands} recent={recent} onClose={() => setPalette((p) => ({ ...p, open: false }))} onOpenFile={(p) => open(p)} />

      <div className="pointer-events-none fixed bottom-9 right-4 z-50 flex flex-col items-end gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 12 }} role="status" className={`pointer-events-auto max-w-md rounded-lg border px-3.5 py-2.5 text-[13px] shadow-pop ${t.tone === "danger" ? "border-danger/30 bg-danger-soft text-danger" : "border-rule bg-panel text-ink"}`}>
              {t.msg}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function StatusItem({ children, title, onClick, testId }: { children: React.ReactNode; title: string; onClick?: () => void; testId?: string }) {
  const cls = "inline-flex h-full items-center gap-1 rounded-sm px-2 whitespace-nowrap";
  return onClick ? (
    <button title={title} onClick={onClick} data-testid={testId} className={`${cls} hover:bg-white/15`}>
      {children}
    </button>
  ) : (
    <span title={title} data-testid={testId} className={cls}>
      {children}
    </span>
  );
}

function Welcome({ name, onPalette }: { name: string; onPalette: (m: "files" | "commands") => void }) {
  const rows: [string, string, () => void][] = [
    ["Go to file", "Mod+P", () => onPalette("files")],
    ["Show all commands", "Mod+Shift+P", () => onPalette("commands")],
  ];
  return (
    <div className="grid flex-1 place-items-center p-10">
      <div className="w-full max-w-md">
        <Mark size={40} />
        <h1 className="mt-6 text-[40px] leading-[1.04] tracking-[-0.01em]">
          Good to see you, {name.split(" ")[0]}.
          <br />
          <span className="serif-em text-accent-ink">Everyone here is live.</span>
        </h1>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-2">Edits, cursors and selections sync as you type. Agents work in their own copies and land here only after Relay checks them and a person approves.</p>
        <div className="mt-7 space-y-1">
          {rows.map(([label, k, run]) => (
            <button key={label} onClick={run} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13.5px] text-ink-2 hover:bg-hover">
              {label}
              <kbd className="rounded border border-rule bg-panel-2 px-1.5 font-sans text-[11.5px] text-muted">{keyLabel(k)}</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Splash({ message }: { message?: string }) {
  return (
    <div className="grid h-screen place-items-center bg-chrome">
      <div className="flex flex-col items-center gap-3 text-center">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2.4, ease: "linear" }}>
          <Mark size={30} />
        </motion.div>
        <p className="text-[13px] text-muted">{message ?? "Opening the project…"}</p>
      </div>
    </div>
  );
}

function SignedOut() {
  return (
    <div className="relative z-10 grid h-screen place-items-center p-6">
      <div className="max-w-sm rounded-[24px] border border-rule bg-panel p-8 text-center shadow-panel">
        <div className="flex justify-center">
          <Mark size={30} />
        </div>
        <h1 className="mt-4 text-[34px] leading-none">
          You&apos;re <span className="serif-em">not signed in.</span>
        </h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">Ask the project owner for an invite. They can create one with</p>
        <code className="mt-2 inline-block rounded-lg bg-sunken px-2 py-1 font-mono text-[12px]">relay ide invite &lt;your name&gt;</code>
      </div>
    </div>
  );
}
