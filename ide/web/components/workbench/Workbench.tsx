"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell, Blocks, Bot, CircleAlert, CircleUserRound, Files, GitBranch, Menu, PanelBottom, PanelLeft, PanelRight, Play, Search, Settings, TriangleAlert, Users, X } from "lucide-react";
import { EditorView } from "@codemirror/view";
import { selectAll, selectLine, selectParentSyntax, cursorDocStart } from "@codemirror/commands";
import { openSearchPanel, gotoLine, selectNextOccurrence } from "@codemirror/search";
import { api, ApiError } from "@/lib/api";
import { DocSession } from "@/lib/collab";
import { availability, chordOf, execute, isMac, keyLabel, matches } from "@/lib/commands";
import type { Command } from "@/lib/commands";
import { applyTheme, initialTheme } from "@/lib/theme";
import type { Theme } from "@/lib/theme";
import type { Member, ProjectState, Task } from "@/lib/types";
import { useProject } from "@/lib/useProject";
import { Coordination } from "../Coordination";
import type { CoordTab } from "../Coordination";
import { DEFAULT_PREFS, Editor } from "../Editor";
import type { EditorPrefs, LineMark, SyntaxProblem } from "../Editor";
import { FileTree } from "../FileTree";
import { Avatar, Mark, StatePill } from "../ui";
import { AgentPanel } from "./AgentPanel";
import { PeopleView } from "./People";
import { DiffView, diffTabId, diffTabLabel, parseDiffTab } from "./DiffView";
import type { DiffSpec } from "./DiffView";
import { RecordsPanel } from "./Records";
import { CommandPalette } from "./CommandPalette";
import { AccountView, ExtensionsView, OutputPanel, RunView, SettingsView } from "./MoreViews";
import { TerminalPanel } from "./Terminal";
import type { TerminalAvailability } from "./Terminal";
import { TestsPanel, failedNames, rerunFailed, runTests, stopTests } from "./Tests";
import { BottomPanel, Section, SearchView, SourceControlView, ViewHeader, problemsOf } from "./Views";
import type { PanelTab } from "./Views";

/* ===================================================================================================
   Layout model
   =================================================================================================== */

type View = "explorer" | "search" | "scm" | "run" | "extensions" | "community" | "relay" | "account" | "settings";
type RightTab = "agent" | CoordTab | "records";

interface Layout {
  view: View;
  sidebar: boolean;
  secondary: boolean;
  panel: boolean;
  sidebarW: number;
  secondaryW: number;
  panelH: number;
  rightTab: RightTab;
}
const DEFAULT_LAYOUT: Layout = { view: "explorer", sidebar: true, secondary: true, panel: false, sidebarW: 260, secondaryW: 380, panelH: 240, rightTab: "agent" };
const LAYOUT_KEY = "relay.layout.v2";
const ACTIVITY_W = 48;
const SIDEBAR = { min: 180, max: 600 };
const SECONDARY = { min: 300, max: 720 };
const PANEL = { min: 100 };
const TITLE_H = 35;
const STATUS_H = 22;

function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function useWindowSize() {
  const [size, setSize] = useState({ w: 1440, h: 900 });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

/**
 * What actually fits. The user's choices (visibility, widths) are preferences; this decides the effective layout
 * for the current window so the editor never drops below a usable width. Preferences are never overwritten by it.
 */
function allocate(l: Layout, w: number, h: number, lastOpened: "sidebar" | "secondary") {
  const minEditor = w < 900 ? 300 : 420;
  const avail = w - ACTIVITY_W;
  let sidebar = l.sidebar;
  let secondary = l.secondary;
  let sw = Math.min(Math.max(l.sidebarW, SIDEBAR.min), SIDEBAR.max);
  let rw = Math.min(Math.max(l.secondaryW, SECONDARY.min), SECONDARY.max);
  const need = () => (sidebar ? sw : 0) + (secondary ? rw : 0) + minEditor;
  // 1) shrink towards minimums, 2) hide the pane the user didn't open most recently, 3) hide the other.
  if (need() > avail) {
    const over = need() - avail;
    const sCut = sidebar ? Math.min(sw - SIDEBAR.min, over) : 0;
    sw -= sCut;
    const rCut = secondary ? Math.min(rw - SECONDARY.min, over - sCut) : 0;
    rw -= rCut;
  }
  let autoHidden: "sidebar" | "secondary" | null = null;
  if (need() > avail && sidebar && secondary) {
    if (lastOpened === "secondary") sidebar = false;
    else secondary = false;
    autoHidden = sidebar ? "secondary" : "sidebar";
  }
  if (need() > avail && secondary) {
    secondary = false;
    autoHidden = "secondary";
  }
  if (need() > avail && sidebar) {
    sidebar = false;
    autoHidden = "sidebar";
  }
  const maxPanel = Math.max(PANEL.min, h - TITLE_H - STATUS_H - 160);
  return { sidebar, secondary, sw, rw, panelH: Math.min(Math.max(l.panelH, PANEL.min), maxPanel), maxPanel, autoHidden, compactMenu: w < 960 };
}

/** A resize handle between two regions; drag with the pointer or focus it and use the arrow keys. */
function Sash({ dir, value, min, max, onChange, label }: { dir: "x" | "y"; value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  const start = useRef<{ p: number; v: number } | null>(null);
  const sign = label.includes("Secondary") || dir === "y" ? -1 : 1;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={dir === "x" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={(e) => {
        start.current = { p: dir === "x" ? e.clientX : e.clientY, v: value };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const d = (dir === "x" ? e.clientX : e.clientY) - start.current.p;
        onChange(Math.min(max, Math.max(min, start.current.v + sign * d)));
      }}
      onPointerUp={() => (start.current = null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const inc = dir === "x" ? ["ArrowRight", "ArrowLeft"] : ["ArrowUp", "ArrowDown"];
        if (e.key === inc[0]) onChange(Math.min(max, Math.max(min, value + (dir === "y" ? step : sign * step))));
        else if (e.key === inc[1]) onChange(Math.min(max, Math.max(min, value - (dir === "y" ? step : sign * step))));
        else if (e.key === "Home") onChange(min);
        else if (e.key === "End") onChange(max);
        else return;
        e.preventDefault();
      }}
      data-testid={`sash-${label.replace(/\s+/g, "-").toLowerCase()}`}
      className={`group relative z-20 shrink-0 outline-none ${dir === "x" ? "w-0 cursor-col-resize" : "h-0 cursor-row-resize"}`}
    >
      <span className={`absolute transition-colors delay-100 group-hover:bg-accent group-focus-visible:bg-accent ${dir === "x" ? "inset-y-0 -left-[2px] w-[4px]" : "inset-x-0 -top-[2px] h-[4px]"}`} />
    </div>
  );
}

function useSessionState(session: DocSession | null) {
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
  const snap = useCallback(() => (session ? `${session.status}|${session.pendingOffline}|${session.peers().map((p) => p.clientId).join(",")}|${session.typing().join(",")}` : "none"), [session]);
  useSyncExternalStore(sub, snap, () => "none");
  return session ? { status: session.status, pending: session.pendingOffline, peers: session.peers() } : { status: "offline" as const, pending: false, peers: [] };
}

const LANG: Record<string, string> = { js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript JSX", ts: "TypeScript", tsx: "TypeScript JSX", json: "JSON", md: "Markdown", css: "CSS", html: "HTML", py: "Python" };

interface Note {
  id: number;
  msg: string;
  tone: "ok" | "danger";
  at: string;
}

/* ===================================================================================================
   Menu bar (driven by the command registry)
   =================================================================================================== */

type MenuEntry = string | "-";
const MENUS: [string, MenuEntry[]][] = [
  ["File", ["file.newFile", "file.save", "-", "view.closeEditor", "view.closeAllEditors", "-", "account.signOut"]],
  ["Edit", ["edit.undo", "edit.redo", "-", "edit.find", "search.inFiles"]],
  ["Selection", ["selection.all", "selection.line", "selection.expand", "selection.nextOccurrence"]],
  ["View", ["palette.commands", "-", "view.explorer", "view.search", "view.scm", "view.run", "view.extensions", "view.community", "view.relay", "-", "layout.toggleSidebar", "layout.toggleSecondary", "layout.togglePanel", "-", "panel.problems", "panel.impact", "panel.output", "panel.agents", "-", "theme.toggle"]],
  ["Go", ["palette.files", "go.line", "-", "go.nextEditor", "go.previousEditor"]],
  ["Run", ["view.run", "run.debug", "-", "relay.runActiveTask"]],
  ["Terminal", ["terminal.new", "terminal.toggle", "-", "view.run"]],
  ["Help", ["palette.commands", "view.settings", "help.about"]],
];

function MenuBar({ commands, compact }: { commands: Command[]; compact: boolean }) {
  const byId = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands]);
  const [open, setOpen] = useState<number | null>(null);
  const [item, setItem] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const entries = (i: number) => (MENUS[i]?.[1] ?? []).filter((e) => e === "-" || byId.has(e));
  const actionable = (i: number) => entries(i).filter((e) => e !== "-") as string[];

  useEffect(() => {
    if (open === null) return;
    const off = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [open]);

  const run = (id: string) => {
    const c = byId.get(id);
    if (!c || availability(c)) return;
    setOpen(null);
    execute(c);
  };

  if (compact)
    return (
      <div ref={root} className="relative">
        <button aria-label="Application menu" aria-haspopup="menu" aria-expanded={open !== null} onClick={() => setOpen(open === null ? 0 : null)} className="grid h-[26px] w-8 place-items-center rounded-sm text-chrome-ink hover:bg-hover hover:text-ink">
          <Menu size={15} />
        </button>
        {open !== null && (
          <div role="menu" className="glass absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-64 overflow-y-auto rounded-md border border-rule-strong p-1">
            {MENUS.map(([name], i) => (
              <div key={name}>
                <p className="micro px-2.5 pb-0.5 pt-2 text-faint">{name}</p>
                {actionable(i).map((id) => (
                  <MenuItem key={id} c={byId.get(id)!} onRun={() => run(id)} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    );

  return (
    <div
      ref={root}
      role="menubar"
      aria-label="Main menu"
      className="flex items-center"
      onKeyDown={(e) => {
        if (open === null) return;
        const list = actionable(open);
        if (e.key === "Escape") setOpen(null);
        else if (e.key === "ArrowDown") setItem((x) => (x + 1) % list.length);
        else if (e.key === "ArrowUp") setItem((x) => (x - 1 + list.length) % list.length);
        else if (e.key === "ArrowRight") (setOpen((open + 1) % MENUS.length), setItem(0));
        else if (e.key === "ArrowLeft") (setOpen((open - 1 + MENUS.length) % MENUS.length), setItem(0));
        else if (e.key === "Enter") run(list[item]!);
        else return;
        e.preventDefault();
      }}
    >
      {MENUS.map(([name], i) => (
        <div key={name} className="relative">
          <button
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => (setOpen(open === i ? null : i), setItem(0))}
            onMouseEnter={() => open !== null && open !== i && (setOpen(i), setItem(0))}
            className={`h-[24px] rounded-sm px-2 text-[12.5px] transition-colors ${open === i ? "bg-hover text-ink" : "text-chrome-ink hover:bg-hover hover:text-ink"}`}
          >
            {name}
          </button>
          {open === i && (
            <div role="menu" aria-label={name} className="glass absolute left-0 top-full z-50 mt-1 min-w-64 rounded-md border border-rule-strong p-1">
              {entries(i).map((e, k) =>
                e === "-" ? (
                  <div key={`sep${k}`} role="separator" className="mx-1.5 my-1 h-px bg-rule" />
                ) : (
                  <MenuItem key={e} c={byId.get(e)!} focused={actionable(i)[item] === e} onRun={() => run(e)} onHover={() => setItem(actionable(i).indexOf(e))} />
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MenuItem({ c, focused, onRun, onHover }: { c: Command; focused?: boolean; onRun: () => void; onHover?: () => void }) {
  const reason = availability(c);
  return (
    <button
      role="menuitem"
      aria-disabled={!!reason}
      title={reason ?? undefined}
      onClick={onRun}
      onMouseEnter={onHover}
      className={`flex h-[26px] w-full items-center gap-6 rounded-sm px-2.5 text-left text-[12.5px] ${reason ? "cursor-default text-faint" : focused ? "bg-hover text-ink shadow-[inset_2px_0_0_var(--accent)]" : "text-ink-2 hover:bg-hover hover:text-ink hover:shadow-[inset_2px_0_0_var(--accent)]"}`}
    >
      <span className="truncate">{c.title}</span>
      {c.keybinding && <span className={`ml-auto shrink-0 font-mono text-[11px] ${focused && !reason ? "text-muted" : "text-faint"}`}>{keyLabel(c.keybinding)}</span>}
    </button>
  );
}

/* ===================================================================================================
   Workbench
   =================================================================================================== */

export function Workbench() {
  const { load, events, files, live, presence: feed, testRun, setTestRun, refresh, refreshFiles } = useProject();
  const win = useWindowSize();
  const [theme, setTheme] = useState<Theme>("dark");
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [lastOpened, setLastOpened] = useState<"sidebar" | "secondary">("sidebar");
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [palette, setPalette] = useState<{ open: boolean; mode: "files" | "commands" }>({ open: false, mode: "files" });
  const [panelTab, setPanelTab] = useState<PanelTab>("terminal");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [newTaskNonce, setNewTaskNonce] = useState(0);
  const [searchNonce, setSearchNonce] = useState(0);
  const [agentNonce, setAgentNonce] = useState(0);
  const [termFocus, setTermFocus] = useState(0);
  const [termNew, setTermNew] = useState(0);
  const [termCaps, setTermCaps] = useState<TerminalAvailability | null>(null);
  const [termRun, setTermRun] = useState<{ text: string; nonce: number } | null>(null);
  const [git, setGit] = useState<Map<string, string>>(new Map());
  const [notes, setNotes] = useState<Note[]>([]);
  const [toasts, setToasts] = useState<Note[]>([]);
  const [bell, setBell] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<EditorPrefs>(DEFAULT_PREFS);
  const [showAuthors, setShowAuthors] = useState(false);
  const [authors, setAuthors] = useState<Map<number, LineMark> | null>(null);
  const [syntax, setSyntax] = useState<SyntaxProblem[] | null>(null);
  const sessions = useRef(new Map<string, DocSession>());
  const editorView = useRef<EditorView | null>(null);

  useEffect(() => {
    setTheme(initialTheme());
    setLayout(loadLayout());
    try {
      setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("relay.editor.v1") ?? "{}") });
      setShowAuthors(localStorage.getItem("relay.authors") === "1");
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("relay.editor.v1", JSON.stringify(prefs));
      localStorage.setItem("relay.authors", showAuthors ? "1" : "0");
    } catch {}
  }, [prefs, showAuthors]);
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {}
  }, [layout]);
  const set = useCallback((patch: Partial<Layout>) => setLayout((l) => ({ ...l, ...patch })), []);

  const notify = useCallback((msg: string, tone: "ok" | "danger" = "ok") => {
    const n = { id: Date.now() + Math.random(), msg, tone, at: new Date().toISOString() };
    setNotes((x) => [n, ...x].slice(0, 50));
    setToasts((t) => [...t, n]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), tone === "danger" ? 7000 : 3800);
  }, []);

  const me = load.kind === "ready" ? load.state.me : null;
  const state = load.kind === "ready" ? load.state : null;

  // Capabilities and git status come from the server; nothing is assumed.
  useEffect(() => {
    if (!me) return;
    void api<{ terminal: TerminalAvailability }>("GET", "/capabilities").then((c) => setTermCaps(c.terminal), () => setTermCaps({ available: false, reason: "Couldn't reach the Relay server." }));
  }, [me?.id, me?.role]);
  useEffect(() => {
    if (!me) return;
    const t = setTimeout(() => {
      void api<{ changes: { path: string; status: string }[] }>("GET", "/git").then((g) => setGit(new Map(g.changes.map((c) => [c.path, c.status]))), () => {});
    }, 400);
    return () => clearTimeout(t);
  }, [me?.id, events.length]);

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
  const closeTab = useCallback((path: string) => {
    const s = sessions.current.get(path);
    if (s?.pendingOffline && !confirm(`${path} has edits made while offline that haven't reached the server yet. Close it and discard them from this browser?`)) return;
    s?.destroy();
    sessions.current.delete(path);
    setTabs((t) => {
      const next = t.filter((x) => x !== path);
      setActive((a) => (a === path ? (next.at(-1) ?? null) : a));
      return next;
    });
  }, []);
  useEffect(() => () => sessions.current.forEach((s) => s.destroy()), []);
  // Never lose edits silently: warn before unloading while any open file has offline edits.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if ([...sessions.current.values()].some((s) => s.pendingOffline)) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // Diff tabs live in the same tab strip; only real file tabs have a collaborative session.
  const activePath = active && !active.startsWith("diff:") ? active : null;
  const activeDiff = active ? parseDiffTab(active) : null;
  const session = me && activePath ? sessionFor(activePath, me) : null;
  const openDiff = useCallback((d: DiffSpec) => {
    const id = diffTabId(d);
    setTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActive(id);
  }, []);
  const { status, pending, peers } = useSessionState(session);
  const onCursor = useCallback((l: number, c: number) => setCursor([l, c]), []);

  // Syntax diagnostics and line authorship follow the shared document: refetched shortly after it changes.
  const memberColors = useMemo(() => new Map((load.kind === "ready" ? load.state.members : []).map((m) => [m.id, m])), [load]);
  useEffect(() => {
    setSyntax(null);
    setAuthors(null);
    if (!session || !activePath) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    let live = true;
    const fetchAll = () => {
      void api<{ problems: SyntaxProblem[] }>("GET", `/diagnostics?path=${encodeURIComponent(activePath)}`).then((r) => live && setSyntax(r.problems), () => {});
      if (showAuthors)
        void api<{ lines: { line: number; kind: string; authors: string[] }[] }>("GET", `/attribution?path=${encodeURIComponent(activePath)}`).then((r) => {
          if (!live) return;
          const m = new Map<number, LineMark>();
          for (const l of r.lines) {
            if (l.kind === "member") {
              const who = memberColors.get(l.authors[0]!);
              m.set(l.line, { color: who?.color ?? "var(--muted)", label: `${who?.name ?? l.authors[0]}`, kind: "member" });
            } else if (l.kind === "shared") m.set(l.line, { color: "var(--muted)", label: `Shared: ${l.authors.map((a) => memberColors.get(a)?.name ?? a.replace(/^relay:/, "")).join(", ")}`, kind: "shared" });
            else if (l.kind === "agent") m.set(l.line, { color: "var(--accent)", label: `Agent: ${l.authors[0]!.replace(/^agent:/, "")}`, kind: "agent" });
            else if (l.kind === "disk") m.set(l.line, { color: "var(--faint)", label: "Changed outside Relay (disk)", kind: "disk" });
          }
          setAuthors(m);
        }, () => {});
    };
    fetchAll();
    const on = () => {
      if (t) clearTimeout(t);
      t = setTimeout(fetchAll, 700);
    };
    session.doc.on("update", on);
    return () => {
      live = false;
      if (t) clearTimeout(t);
      session.doc.off("update", on);
    };
  }, [session, activePath, showAuthors, memberColors]);

  // Follow mode: open whatever file the followed person is in, and keep their caret in view. Esc stops.
  const jumpTo = useCallback(
    (memberId: string) => {
      const where = feed.participants.find((p) => p.memberId === memberId);
      if (!where) return notify("They aren't in a file right now.", "danger");
      const s = me ? sessionFor(where.path, me) : null;
      open(where.path);
      let tries = 0;
      const tick = () => {
        const c = s?.cursorOf(memberId);
        if (c) setReveal({ line: c.line, nonce: Date.now() });
        else if (tries++ < 20) setTimeout(tick, 100);
      };
      tick();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, me?.id],
  );
  const followedPath = following ? feed.participants.find((p) => p.memberId === following)?.path : undefined;
  useEffect(() => {
    if (following && followedPath && followedPath !== active) open(followedPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, followedPath]);
  useEffect(() => {
    if (!following || !session) return;
    const aw = session.provider.awareness;
    let last = -1;
    const on = () => {
      const c = session.cursorOf(following);
      if (c && c.line !== last) {
        last = c.line;
        editorView.current?.dispatch({ effects: EditorView.scrollIntoView(editorView.current.state.doc.line(Math.min(c.line, editorView.current.state.doc.lines)).from, { y: "center" }) });
      }
    };
    on();
    aw.on("change", on);
    return () => aw.off("change", on);
  }, [following, session]);
  useEffect(() => {
    if (!following) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFollowing(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [following]);
  useEffect(() => {
    if (following && !feed.online.includes(following) && !feed.participants.some((p) => p.memberId === following)) setFollowing(null);
  }, [following, feed]);

  const showView = useCallback((v: View) => {
    setLayout((l) => ({ ...l, view: v, sidebar: l.view === v ? !l.sidebar : true }));
    setLastOpened("sidebar");
    if (v === "search") setSearchNonce((n) => n + 1);
  }, []);
  const showRight = useCallback(
    (tab: RightTab) => {
      set({ secondary: true, rightTab: tab });
      setLastOpened("secondary");
    },
    [set],
  );
  const showTask = useCallback(
    (id: string) => {
      showRight("tasks");
      setSelectedTask(id);
    },
    [showRight],
  );
  const openPanel = useCallback(
    (t: PanelTab) => {
      set({ panel: true });
      setPanelTab(t);
      if (t === "terminal") setTermFocus((n) => n + 1);
    },
    [set],
  );
  const invite = useCallback(() => {
    const name = prompt("Collaborator's name");
    if (!name) return;
    const role = (prompt("Role: editor, viewer or owner", "editor") ?? "editor").trim();
    void api<{ joinPath: string }>("POST", "/members", { name, role }).then(
      (r) => {
        const link = `${location.origin}${r.joinPath}`;
        void navigator.clipboard?.writeText(link).catch(() => {});
        notify(`One-time invite for ${name} copied (valid 72 hours): ${link}`);
      },
      (e) => notify(e instanceof ApiError ? e.message : String(e), "danger"),
    );
  }, [notify]);
  const signOut = useCallback(() => {
    void api("POST", "/logout").then(() => location.reload());
  }, []);

  const view = editorView.current;
  const needEditor = () => (active && editorView.current ? null : "Open a file first");
  const onEditor = (fn: (v: EditorView) => unknown) => () => {
    const v = editorView.current;
    if (v) {
      fn(v);
      v.focus();
    }
  };
  const activeTask: Task | undefined = state?.tasks.find((t) => t.id === selectedTask);

  /* ---------------- the command registry ---------------- */
  const commands: Command[] = useMemo(() => {
    if (!state || !me) return [];
    const canEdit = me.role !== "viewer";
    const isOwner = me.role === "owner";
    const viewOnly = canEdit ? null : "Viewers can't change the project";
    const ownerOnly = isOwner ? null : "Only project owners can do this";
    const term = () => (termCaps?.available ? null : (termCaps?.reason ?? "Checking terminal availability…"));
    const list: Command[] = [
      { id: "palette.files", category: "Go", title: "Go to File…", keywords: ["open", "quick open"], keybinding: "Mod+P", run: () => setPalette({ open: true, mode: "files" }) },
      { id: "palette.commands", category: "View", title: "Command Palette…", keywords: ["commands"], keybinding: "Mod+Shift+P", run: () => setPalette({ open: true, mode: "commands" }) },
      { id: "file.newFile", category: "File", title: "New File…", when: () => viewOnly, run: () => (set({ sidebar: true, view: "explorer" }), document.querySelector<HTMLButtonElement>("[aria-label='New file']")?.click()) },
      { id: "file.save", category: "File", title: "Save", keywords: ["write", "flush"], keybinding: "Mod+S", when: () => (!activePath ? "Open a file first" : viewOnly), run: () => activePath && void api("POST", "/save", { path: activePath }).then(() => notify(`Saved ${activePath} to disk.`), (e) => notify(e instanceof ApiError ? e.message : String(e), "danger")) },
      { id: "view.closeEditor", category: "View", title: "Close Editor", keybinding: "Mod+Alt+W", when: () => (active ? null : "No editor is open"), run: () => active && closeTab(active) },
      { id: "view.closeAllEditors", category: "View", title: "Close All Editors", when: () => (tabs.length ? null : "No editors are open"), run: () => [...tabs].forEach(closeTab) },
      { id: "edit.undo", category: "Edit", title: "Undo (your edits)", keybinding: "Mod+Z", when: needEditor, run: onEditor(() => session?.undoManager.undo()) },
      { id: "edit.redo", category: "Edit", title: "Redo (your edits)", keybinding: "Mod+Shift+Z", when: needEditor, run: onEditor(() => session?.undoManager.redo()) },
      { id: "edit.find", category: "Edit", title: "Find in File", keybinding: "Mod+F", when: needEditor, run: onEditor((v) => openSearchPanel(v)) },
      { id: "search.inFiles", category: "Search", title: "Find in Files", keywords: ["grep", "project search"], keybinding: "Mod+Shift+F", run: () => (set({ view: "search", sidebar: true }), setLastOpened("sidebar"), setSearchNonce((n) => n + 1)) },
      { id: "selection.all", category: "Selection", title: "Select All", keybinding: "Mod+A", when: needEditor, run: onEditor((v) => selectAll(v)) },
      { id: "selection.line", category: "Selection", title: "Select Line", keybinding: "Mod+L", when: needEditor, run: onEditor((v) => selectLine(v)) },
      { id: "selection.expand", category: "Selection", title: "Expand Selection", keybinding: "Mod+Shift+ArrowUp", when: needEditor, run: onEditor((v) => selectParentSyntax(v)) },
      { id: "selection.nextOccurrence", category: "Selection", title: "Add Next Occurrence", keybinding: "Mod+D", when: needEditor, run: onEditor((v) => selectNextOccurrence(v)) },
      { id: "go.line", category: "Go", title: "Go to Line…", keybinding: "Ctrl+G", when: needEditor, run: onEditor((v) => gotoLine(v)) },
      { id: "go.top", category: "Go", title: "Go to Top of File", palette: true, when: needEditor, run: onEditor((v) => cursorDocStart(v)) },
      { id: "go.nextEditor", category: "Go", title: "Next Editor", keybinding: "Mod+Alt+ArrowRight", when: () => (tabs.length > 1 ? null : "Only one editor is open"), run: () => setActive((a) => tabs[(tabs.indexOf(a ?? "") + 1) % tabs.length] ?? a) },
      { id: "go.previousEditor", category: "Go", title: "Previous Editor", keybinding: "Mod+Alt+ArrowLeft", when: () => (tabs.length > 1 ? null : "Only one editor is open"), run: () => setActive((a) => tabs[(tabs.indexOf(a ?? "") - 1 + tabs.length) % tabs.length] ?? a) },
      { id: "view.explorer", category: "View", title: "Explorer", keybinding: "Mod+Shift+E", run: () => (set({ view: "explorer", sidebar: true }), setLastOpened("sidebar")) },
      { id: "view.search", category: "View", title: "Search", run: () => (set({ view: "search", sidebar: true }), setLastOpened("sidebar"), setSearchNonce((n) => n + 1)) },
      { id: "view.scm", category: "View", title: "Source Control", keywords: ["git"], keybinding: "Mod+Shift+G", run: () => (set({ view: "scm", sidebar: true }), setLastOpened("sidebar")) },
      { id: "github.ship", category: "GitHub", title: "Ship Changes or Merge Pull Request…", keywords: ["github", "push", "pr", "pull request", "merge", "deploy"], when: () => ownerOnly, run: () => (set({ view: "scm", sidebar: true }), setLastOpened("sidebar")) },
      { id: "view.run", category: "View", title: "Run", keywords: ["scripts", "npm"], keybinding: "Mod+Shift+D", run: () => (set({ view: "run", sidebar: true }), setLastOpened("sidebar")) },
      { id: "view.extensions", category: "View", title: "Extensions", keybinding: "Mod+Shift+X", run: () => (set({ view: "extensions", sidebar: true }), setLastOpened("sidebar")) },
      { id: "view.community", category: "View", title: "People", keywords: ["people", "members", "invite"], run: () => (set({ view: "community", sidebar: true }), setLastOpened("sidebar")) },
      { id: "view.relay", category: "View", title: "Relay Tasks", keywords: ["coordination", "tasks"], run: () => (set({ view: "relay", sidebar: true }), setLastOpened("sidebar")) },
      { id: "view.settings", category: "Preferences", title: "Settings and Keyboard Shortcuts", keywords: ["preferences", "keybindings"], keybinding: "Mod+,", run: () => (set({ view: "settings", sidebar: true }), setLastOpened("sidebar")) },
      { id: "view.account", category: "Account", title: "Account", run: () => (set({ view: "account", sidebar: true }), setLastOpened("sidebar")) },
      { id: "layout.toggleSidebar", category: "View", title: "Toggle Primary Side Bar", keybinding: "Mod+B", run: () => (setLayout((l) => ({ ...l, sidebar: !l.sidebar })), setLastOpened("sidebar")) },
      { id: "layout.toggleSecondary", category: "View", title: "Toggle Secondary Side Bar", keybinding: "Mod+Alt+B", run: () => (setLayout((l) => ({ ...l, secondary: !l.secondary })), setLastOpened("secondary")) },
      { id: "layout.togglePanel", category: "View", title: "Toggle Panel", keybinding: "Mod+J", run: () => setLayout((l) => ({ ...l, panel: !l.panel })) },
      { id: "layout.reset", category: "View", title: "Reset Layout", run: () => setLayout(DEFAULT_LAYOUT) },
      { id: "panel.problems", category: "View", title: "Problems", keybinding: "Mod+Shift+M", run: () => openPanel("problems") },
      { id: "tests.show", category: "Test", title: "Show Tests", keywords: ["test results"], run: () => openPanel("tests") },
      { id: "tests.runAll", category: "Test", title: "Run All Tests", keywords: ["test"], when: () => ownerOnly ?? (testRun?.status === "running" ? "Tests are already running" : null), run: () => (openPanel("tests"), void runTests({}, notify)) },
      { id: "tests.rerunFailed", category: "Test", title: "Rerun Failed Tests", when: () => ownerOnly ?? (failedNames(testRun).length ? null : "No failed tests in the latest run"), run: () => (openPanel("tests"), void runTests(rerunFailed(testRun), notify)) },
      { id: "tests.stop", category: "Test", title: "Stop Tests", when: () => ownerOnly ?? (testRun?.status === "running" ? null : "No tests are running"), run: () => void stopTests() },
      { id: "panel.output", category: "View", title: "Output", keybinding: "Mod+Shift+U", run: () => openPanel("output") },
      { id: "panel.agents", category: "View", title: "Agent Activity", run: () => openPanel("agents") },
      { id: "panel.impact", category: "Relay", title: "Show Change Impact", keywords: ["dependency", "consumers", "affected tests", "blast radius", "map"], run: () => openPanel("impact") },
      { id: "panel.activity", category: "View", title: "Project Activity", run: () => openPanel("activity") },
      { id: "terminal.toggle", category: "Terminal", title: "Toggle Terminal", keybinding: "Ctrl+`", run: () => (layout.panel && panelTab === "terminal" ? set({ panel: false }) : openPanel("terminal")) },
      { id: "terminal.new", category: "Terminal", title: "New Terminal", keybinding: "Ctrl+Shift+`", when: term, run: () => (openPanel("terminal"), setTermNew((n) => n + 1)) },
      { id: "run.debug", category: "Run", title: "Start Debugging", when: () => "Breakpoint debugging isn't available yet (no debug adapter)", run: () => {} },
      { id: "editor.zoomIn", category: "Editor", title: "Increase Font Size", keywords: ["zoom"], keybinding: "Mod+=", run: () => setPrefs((p) => ({ ...p, fontSize: Math.min(24, p.fontSize + 1) })) },
      { id: "editor.zoomOut", category: "Editor", title: "Decrease Font Size", keywords: ["zoom"], keybinding: "Mod+-", run: () => setPrefs((p) => ({ ...p, fontSize: Math.max(10, p.fontSize - 1) })) },
      { id: "editor.zoomReset", category: "Editor", title: "Reset Font Size", keywords: ["zoom"], keybinding: "Mod+0", run: () => setPrefs((p) => ({ ...p, fontSize: DEFAULT_PREFS.fontSize })) },
      { id: "editor.wrap", category: "Editor", title: prefs.wrap ? "Turn Off Word Wrap" : "Turn On Word Wrap", keybinding: "Alt+Z", run: () => setPrefs((p) => ({ ...p, wrap: !p.wrap })) },
      { id: "editor.authors", category: "Collaboration", title: showAuthors ? "Hide Line Authorship" : "Show Line Authorship", keywords: ["blame", "who wrote", "attribution"], run: () => setShowAuthors((x) => !x) },
      { id: "people.show", category: "Collaboration", title: "Show People and Contributions", keywords: ["contributions", "history", "who"], run: () => (set({ view: "community", sidebar: true }), setLastOpened("sidebar")) },
      { id: "people.stopFollowing", category: "Collaboration", title: "Stop Following", when: () => (following ? null : "You aren't following anyone"), run: () => setFollowing(null) },
      ...feed.participants
        .filter((p) => p.memberId !== me.id)
        .flatMap((p) => {
          const who = state.members.find((m) => m.id === p.memberId)?.name ?? p.memberId;
          return [
            { id: `people.goto:${p.memberId}`, category: "Collaboration", title: `Go to ${who} (${p.path})`, run: () => jumpTo(p.memberId) },
            { id: `people.follow:${p.memberId}`, category: "Collaboration", title: `Follow ${who}`, run: () => setFollowing(p.memberId) },
          ];
        }),
      { id: "theme.toggle", category: "Preferences", title: theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme", keybinding: "Mod+Alt+T", run: () => setTheme((t) => (t === "dark" ? "light" : "dark")) },
      { id: "agent.focus", category: "Relay", title: "Ask the Agent…", keywords: ["chat", "code with agent", "claude"], keybinding: "Mod+I", when: () => viewOnly, run: () => (showRight("agent"), setAgentNonce((n) => n + 1)) },
      { id: "relay.tasks", category: "Relay", title: "Show Tasks", run: () => (showRight("tasks"), setSelectedTask(null)) },
      { id: "relay.contracts", category: "Relay", title: "Show Contracts", run: () => (showRight("contracts"), setSelectedTask(null)) },
      { id: "relay.records", category: "Relay", title: "Show Investigations and Decisions", keywords: ["bug", "debug", "investigation", "decision", "adr", "knowledge"], run: () => showRight("records") },
      { id: "relay.newTask", category: "Relay", title: "New Task…", when: () => viewOnly, run: () => (showRight("tasks"), setSelectedTask(null), setNewTaskNonce((n) => n + 1)) },
      {
        id: "relay.runActiveTask",
        category: "Relay",
        title: activeTask ? `Run with Claude Code: ${activeTask.id}` : "Run Selected Task with Claude Code",
        when: () => viewOnly ?? (!activeTask ? "Select a task in the Relay side bar first" : activeTask.state !== "queued" ? `${activeTask.id} is ${activeTask.state.replace("_", " ")}; only ready tasks can start` : null),
        run: () => activeTask && void api("POST", `/tasks/${encodeURIComponent(activeTask.id)}/run`).then(() => (notify(`Claude Code started on ${activeTask.id} in its own worktree.`), refresh()), (e) => notify(e instanceof ApiError ? e.message : String(e), "danger")),
      },
      { id: "relay.invite", category: "Relay", title: "Invite Collaborator…", when: () => ownerOnly, run: invite },
      { id: "account.signOut", category: "Account", title: "Sign Out", run: signOut },
      { id: "help.about", category: "Help", title: "About Relay", run: () => notify("Relay: one project, any model, every contributor in sync. Collaborative IDE preview.") },
      ...tabs.map((t) => ({ id: `editor:${t}`, category: "Open Editor", title: t, keywords: ["tab", "switch"], run: () => setActive(t) })),
      ...state.tasks.map((t) => ({ id: `task:${t.id}`, category: "Relay", title: `Open Task ${t.id}: ${t.objective}`, run: () => showTask(t.id) })),
    ];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, me, termCaps, active, tabs, theme, layout.panel, panelTab, activeTask, session, view, prefs.wrap, showAuthors, following, feed, jumpTo, testRun, notify]);

  /*
    Keyboard. Bound chords dispatch through the registry in the capture phase, so workbench shortcuts work even when
    the terminal has focus (xterm would otherwise swallow them, as VS Code's "skip shell" list prevents).
    Editing chords stay with whichever editor, field or terminal has focus.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (palette.open) return; // the palette owns the keyboard while open
      const chord = chordOf(e);
      const inEditor = !!(e.target as HTMLElement | null)?.closest?.(".cm-editor");
      const inField = !inEditor && ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement | null)?.tagName ?? "");
      const cmd = commands.find((c) => c.keybinding && matches(c.keybinding, chord));
      if (!cmd) return;
      // Editing chords belong to the focused editor or field (CodeMirror handles them natively there).
      const editing = ["edit.undo", "edit.redo", "selection.all", "selection.line", "selection.expand", "selection.nextOccurrence", "edit.find"].includes(cmd.id);
      if (editing && (inEditor || inField)) return;
      if (inField && !e.metaKey && !e.ctrlKey) return;
      if (availability(cmd)) return;
      e.preventDefault();
      e.stopPropagation();
      execute(cmd);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [commands, palette.open]);

  if (load.kind === "loading") return <Splash />;
  if (load.kind === "signed-out") return <SignedOut />;
  if (load.kind === "error") return <Splash message={load.message} />;
  const s: ProjectState = load.state;

  const fit = allocate(layout, win.w, win.h, lastOpened);
  const presence = new Map(s.presence.map((p) => [p.path, p.members]));
  if (activePath) presence.set(activePath, [...new Set([...(presence.get(activePath) ?? []), me!.id, ...peers.map((p) => p.id)])]);
  const online = new Set([...presence.values()].flat());
  const membersById = new Map(s.members.map((m) => [m.id, m]));
  const where = (id: string) => [...presence.entries()].find(([, ms]) => ms.includes(id))?.[0];
  const problems = problemsOf(s);
  const needsPerson = s.tasks.filter((t) => t.state === "review_required" || t.state === "proposed" || t.state === "blocked").length;
  const runningAgents = s.tasks.flatMap((t) => t.runs).filter((r) => r.status === "running").length;
  const ext = activePath?.split(".").pop() ?? "";
  const eol = session && session.text.toString().includes("\r\n") ? "CRLF" : "LF";

  const activities: { id: View; icon: React.ReactNode; label: string; badge?: number; cmd: string }[] = [
    { id: "explorer", icon: <Files size={20} strokeWidth={1.5} />, label: "Explorer", cmd: "view.explorer" },
    { id: "search", icon: <Search size={20} strokeWidth={1.5} />, label: "Search", cmd: "search.inFiles" },
    { id: "scm", icon: <GitBranch size={20} strokeWidth={1.5} />, label: "Source Control", badge: git.size || undefined, cmd: "view.scm" },
    { id: "run", icon: <Play size={20} strokeWidth={1.5} />, label: "Run", cmd: "view.run" },
    { id: "extensions", icon: <Blocks size={20} strokeWidth={1.5} />, label: "Extensions", cmd: "view.extensions" },
    { id: "community", icon: <Users size={20} strokeWidth={1.5} />, label: "People", badge: online.size > 1 ? online.size : undefined, cmd: "view.community" },
    { id: "relay", icon: <Bot size={20} strokeWidth={1.5} />, label: "Relay", badge: needsPerson || undefined, cmd: "view.relay" },
  ];
  const kb = (id: string) => commands.find((c) => c.id === id)?.keybinding;
  const tip = (label: string, id: string) => (kb(id) ? `${label} (${keyLabel(kb(id)!)})` : label);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-chrome text-ink">
      {/* ===================== Title bar ===================== */}
      <header style={{ height: TITLE_H }} className="relative z-30 flex shrink-0 select-none items-center gap-1 border-b border-rule bg-chrome pl-2 pr-1.5">
        <span className="grid w-8 place-items-center" aria-hidden>
          <Mark size={16} />
        </span>
        <MenuBar commands={commands} compact={fit.compactMenu} />
        <div className="absolute left-1/2 top-1/2 w-[min(38vw,520px)] -translate-x-1/2 -translate-y-1/2">
          <button onClick={() => setPalette({ open: true, mode: "files" })} data-testid="command-center" aria-label={`Search files and commands (${keyLabel("Mod+P")})`} className="group flex h-[24px] w-full items-center gap-2 rounded-sm border border-rule bg-sidebar px-2 text-[12px] text-muted transition-colors hover:border-rule-strong hover:text-ink-2">
            <Search size={12} strokeWidth={1.75} className="shrink-0 text-faint group-hover:text-accent" />
            <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate">
              <span className="truncate text-ink-2">{s.project.name}</span>
              {s.project.head && <span className="hidden font-mono text-[10.5px] text-faint md:inline">@{s.project.head}</span>}
            </span>
            <kbd className="hidden shrink-0 font-mono text-[10.5px] text-faint lg:inline">{keyLabel("Mod+P")}</kbd>
          </button>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <div className="mr-1.5 hidden items-center gap-0.5 sm:flex" aria-label="People here">
            <AnimatePresence>
              {s.members
                .filter((m) => online.has(m.id) && m.id !== me!.id)
                .slice(0, 5)
                .map((m) => (
                  <Avatar key={m.id} name={m.name} color={m.color} size={20} title={`${m.name}${where(m.id) ? ` · ${where(m.id)}` : ""}`} />
                ))}
            </AnimatePresence>
          </div>
          {[
            { on: fit.sidebar, label: tip("Toggle Primary Side Bar", "layout.toggleSidebar"), icon: <PanelLeft size={15} />, cmd: "layout.toggleSidebar" },
            { on: layout.panel, label: tip("Toggle Panel", "layout.togglePanel"), icon: <PanelBottom size={15} />, cmd: "layout.togglePanel" },
            { on: fit.secondary, label: tip("Toggle Secondary Side Bar", "layout.toggleSecondary"), icon: <PanelRight size={15} />, cmd: "layout.toggleSecondary" },
          ].map((b) => (
            <button key={b.cmd} aria-label={b.label} title={b.label} aria-pressed={b.on} onClick={() => execute(commands.find((c) => c.id === b.cmd)!)} className={`grid size-[26px] place-items-center rounded-sm hover:bg-hover ${b.on ? "text-ink" : "text-faint"}`}>
              {b.icon}
            </button>
          ))}
          <button aria-label={tip("Settings", "view.settings")} title={tip("Settings", "view.settings")} onClick={() => showView("settings")} className="grid size-[26px] place-items-center rounded-sm text-chrome-ink hover:bg-hover hover:text-ink">
            <Settings size={15} />
          </button>
          <button aria-label={`Account: ${me!.name}`} title={`Account: ${me!.name}`} onClick={() => showView("account")} className="ml-0.5 grid size-[26px] place-items-center rounded-sm hover:bg-hover">
            <Avatar name={me!.name} color={me!.color} size={20} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ===================== Activity bar ===================== */}
        <nav aria-label="Activities" style={{ width: ACTIVITY_W }} className="flex shrink-0 flex-col items-center border-r border-rule bg-chrome" role="tablist" aria-orientation="vertical">
          {activities.map((a) => {
            const on = fit.sidebar && layout.view === a.id;
            return (
              <button
                key={a.id}
                role="tab"
                aria-selected={on}
                aria-label={a.label}
                title={tip(a.label, a.cmd)}
                data-testid={`activity-${a.id}`}
                onClick={() => showView(a.id)}
                className={`relative grid h-11 w-12 place-items-center transition-colors ${on ? "text-ink" : "text-faint hover:text-ink-2"}`}
              >
                {on && <motion.span layoutId="activity-indicator" transition={{ type: "spring", stiffness: 520, damping: 40 }} className="absolute inset-y-2.5 left-0 w-[2px] bg-accent" />}
                {a.icon}
                {a.badge !== undefined && <span className="tnum absolute bottom-1.5 right-1.5 grid h-[15px] min-w-[15px] place-items-center rounded-sm bg-accent px-[3px] font-mono text-[9.5px] font-semibold text-accent-fg">{a.badge}</span>}
              </button>
            );
          })}
          <div className="mt-auto flex flex-col items-center pb-1">
            {[
              { id: "account" as View, icon: <CircleUserRound size={20} strokeWidth={1.5} />, label: "Accounts", cmd: "view.account" },
              { id: "settings" as View, icon: <Settings size={20} strokeWidth={1.5} />, label: "Manage", cmd: "view.settings" },
            ].map((a) => {
              const on = fit.sidebar && layout.view === a.id;
              return (
                <button key={a.id} role="tab" aria-selected={on} aria-label={a.label} title={tip(a.label, a.cmd)} data-testid={`activity-${a.id}`} onClick={() => showView(a.id)} className={`relative grid h-11 w-12 place-items-center transition-colors ${on ? "text-ink" : "text-faint hover:text-ink-2"}`}>
                  {on && <motion.span layoutId="activity-indicator" transition={{ type: "spring", stiffness: 520, damping: 40 }} className="absolute inset-y-2.5 left-0 w-[2px] bg-accent" />}
                  {a.icon}
                </button>
              );
            })}
          </div>
        </nav>

        {/* ===================== Primary side bar ===================== */}
        {fit.sidebar && (
          <>
            <aside aria-label="Primary side bar" style={{ width: fit.sw }} className="flex shrink-0 flex-col overflow-hidden bg-sidebar" data-testid="primary-sidebar">
              {layout.view === "explorer" && (
                <div className="flex h-full min-h-0 flex-col">
                  <ViewHeader title="Explorer" />
                  {tabs.length > 0 && (
                    <Section title="Open Editors" count={tabs.length} defaultOpen={false}>
                      {tabs.map((t) => (
                        <div key={t} className={`group flex h-[22px] items-center gap-1.5 pl-5 pr-2 text-[13px] ${t === active ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"}`}>
                          <button onClick={() => open(t)} className="min-w-0 truncate text-left">
                            {t.split("/").pop()} <span className="text-[11.5px] text-faint">{t.split("/").slice(0, -1).join("/")}</span>
                          </button>
                          <button aria-label={`Close ${t}`} onClick={() => closeTab(t)} className="ml-auto text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </Section>
                  )}
                  <div className="min-h-0 flex-1 border-t border-rule">
                    <FileTree
                      title={s.project.name}
                      files={files}
                      active={active}
                      presence={presence}
                      members={s.members}
                      me={me!}
                      canEdit={me!.role !== "viewer"}
                      gitStatus={git}
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
              {layout.view === "scm" && <SourceControlView onOpen={open} onDiff={(p, staged) => openDiff({ kind: staged ? "staged" : "working", path: p })} tick={events.length} canShip={me!.role === "owner"} canEdit={me!.role !== "viewer"} notify={notify} />}
              {layout.view === "run" && <RunView terminal={termCaps} onRunInTerminal={(cmd) => (openPanel("terminal"), setTermRun({ text: cmd, nonce: Date.now() }))} />}
              {layout.view === "extensions" && <ExtensionsView />}
              {layout.view === "community" && <PeopleView me={me!} members={s.members} presence={feed} tick={events.length} following={following} onOpen={open} onJump={jumpTo} onFollow={setFollowing} onInvite={invite} notify={notify} />}
              {layout.view === "relay" && <RelayView state={s} onTask={showTask} onNewTask={() => execute(commands.find((c) => c.id === "relay.newTask")!)} />}
              {layout.view === "account" && <AccountView me={me!} onSignOut={signOut} />}
              {layout.view === "settings" && <SettingsView theme={theme} setTheme={setTheme} commands={commands} terminal={termCaps} onResetLayout={() => setLayout(DEFAULT_LAYOUT)} prefs={prefs} setPrefs={setPrefs} showAuthors={showAuthors} setShowAuthors={setShowAuthors} />}
            </aside>
            <Sash dir="x" label="Primary side bar width" value={fit.sw} min={SIDEBAR.min} max={Math.min(SIDEBAR.max, win.w - ACTIVITY_W - 300)} onChange={(v) => set({ sidebarW: v })} />
          </>
        )}

        {/* ===================== Editor group + panel ===================== */}
        <div className="flex min-w-0 flex-1 flex-col border-l border-rule bg-editor" data-testid="editor-group">
          <main className="flex min-h-0 flex-1 flex-col" aria-label="Editor">
            {tabs.length > 0 && (
              <div className="flex h-[35px] shrink-0 items-stretch overflow-x-auto overflow-y-hidden bg-sidebar " role="tablist" aria-label="Open editors">
                {tabs.map((t) => {
                  const on = t === active;
                  const here = (presence.get(t) ?? []).filter((id) => id !== me!.id);
                  const offline = sessions.current.get(t)?.pendingOffline;
                  return (
                    <div key={t} role="tab" aria-selected={on} data-testid={`tab-${t}`} onMouseDown={(e) => e.button === 1 && (e.preventDefault(), closeTab(t))} className={`group relative flex min-w-0 shrink-0 items-center gap-1.5 border-r border-rule pl-3 pr-1 text-[12.5px] transition-colors ${on ? "bg-editor text-ink" : "border-b text-muted hover:bg-hover/50 hover:text-ink"}`}>
                      {on && <motion.span layoutId="tab-indicator" transition={{ type: "spring", stiffness: 520, damping: 42 }} className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
                      <button onClick={() => setActive(t)} className="max-w-56 truncate" title={t}>
                        {parseDiffTab(t) ? diffTabLabel(parseDiffTab(t)!) : t.split("/").pop()}
                      </button>
                      {here.slice(0, 3).map((id) => (
                        <span key={id} title={`${membersById.get(id)?.name} is here`} className="size-1.5 shrink-0 rounded-full" style={{ background: membersById.get(id)?.color }} />
                      ))}
                      <button aria-label={offline ? `${t} has offline edits; close` : `Close ${t}`} title={offline ? "Edits made offline haven't reached the server yet" : "Close"} onClick={() => closeTab(t)} className="grid size-5 shrink-0 place-items-center rounded-sm hover:bg-hover">
                        {offline ? <span className="size-2 rounded-full bg-attention" /> : <X size={13} className={on ? "text-muted" : "text-transparent group-hover:text-muted"} />}
                      </button>
                    </div>
                  );
                })}
                <div className="min-w-4 flex-1 border-b border-rule" />
              </div>
            )}
            {activeDiff ? (
              <DiffView spec={activeDiff} canEdit={me!.role !== "viewer"} onOpenFile={open} notify={notify} onStage={(p) => void api("POST", "/git/stage", { paths: [p] }).then(() => notify(`Staged ${p}.`), (e) => notify(e instanceof ApiError ? e.message : String(e), "danger"))} />
            ) : session ? (
              <>
                <div className="flex h-[24px] shrink-0 items-center justify-between px-4 text-[12px] text-muted">
                  <nav aria-label="Breadcrumbs" className="min-w-0 truncate">
                    {active!.split("/").map((seg, i, all) => (
                      <span key={i}>
                        <span className={i === all.length - 1 ? "text-ink-2" : ""}>{seg}</span>
                        {i < all.length - 1 && <span className="px-1.5 font-mono text-faint">/</span>}
                      </span>
                    ))}
                  </nav>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {peers.map((p) => (
                      <span key={p.clientId} className="inline-flex items-center gap-1 text-[11.5px]" style={{ color: p.color }}>
                        <span className="size-1.5 rounded-full" style={{ background: p.color }} /> {p.name}
                      </span>
                    ))}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <Editor key={session.path} session={session} readOnly={me!.role === "viewer"} onCursor={onCursor} reveal={reveal} viewHandle={editorView} prefs={prefs} authors={showAuthors ? authors : null} problems={syntax} />
                </div>
              </>
            ) : (
              <EmptyEditor commands={commands} recent={recent} onOpen={open} />
            )}
          </main>
          {/* The panel stays mounted when closed so terminal sessions and scrollback survive. */}
          <div className={layout.panel ? "contents" : "hidden"}>
            <Sash dir="y" label="Panel height" value={fit.panelH} min={PANEL.min} max={fit.maxPanel} onChange={(v) => set({ panelH: v })} />
            <section aria-label="Panel" style={{ height: fit.panelH }} className="shrink-0 border-t border-rule" data-testid="bottom-panel">
              <BottomPanel
                tab={panelTab}
                setTab={(t) => openPanel(t)}
                state={s}
                events={events}
                members={s.members}
                onTask={showTask}
                onOpen={open}
                syntax={activePath && syntax ? syntax.map((p) => ({ ...p, path: activePath })) : []}
                onClose={() => set({ panel: false })}
                output={<OutputPanel tick={events.length} />}
                tests={<TestsPanel run={testRun} setRun={setTestRun} canRun={me?.role === "owner"} onOpen={open} notify={notify} />}
                testFailures={testRun && !testRun.stale ? failedNames(testRun).length : 0}
                terminal={<TerminalPanel availability={termCaps} visible={layout.panel && panelTab === "terminal"} focusNonce={termFocus} newNonce={termNew} theme={theme} run={termRun} />}
              />
            </section>
          </div>
        </div>

        {/* ===================== Secondary side bar: Relay ===================== */}
        {fit.secondary && (
          <>
            <Sash dir="x" label="Secondary side bar width" value={fit.rw} min={SECONDARY.min} max={Math.min(SECONDARY.max, win.w - ACTIVITY_W - 300)} onChange={(v) => set({ secondaryW: v })} />
            <aside aria-label="Secondary side bar" style={{ width: fit.rw }} className="flex shrink-0 flex-col overflow-hidden border-l border-rule bg-sidebar" data-testid="secondary-sidebar">
              <div className="flex h-[35px] shrink-0 items-center gap-4 border-b border-rule px-3" role="tablist" aria-label="Relay">
                {(["agent", "tasks", "contracts", "records"] as RightTab[]).map((t) => (
                  <button key={t} role="tab" aria-selected={layout.rightTab === t} data-testid={`right-tab-${t}`} onClick={() => (set({ rightTab: t }), t !== "agent" && setSelectedTask(null))} className={`micro relative h-full transition-colors ${layout.rightTab === t ? "text-ink" : "text-faint hover:text-ink-2"}`}>
                    {t}
                    {t === "tasks" && needsPerson > 0 && <span className="tnum ml-1.5 rounded-sm bg-accent px-1 py-px text-[9.5px] text-accent-fg">{needsPerson}</span>}
                    {layout.rightTab === t && <motion.span layoutId="right-tab-indicator" transition={{ type: "spring", stiffness: 520, damping: 42 }} className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" />}
                  </button>
                ))}
                <button aria-label="Close secondary side bar" title="Close" onClick={() => set({ secondary: false })} className="ml-auto grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
                  <X size={14} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {layout.rightTab === "records" ? (
                  <RecordsPanel tick={events.length} role={me!.role} notify={notify} />
                ) : layout.rightTab === "agent" ? (
                  <AgentPanel state={s} files={files} activeFile={active} onOpenTask={showTask} onOpenFile={open} notify={notify} refresh={refresh} focusNonce={agentNonce} />
                ) : (
                  <Coordination embedded state={s} onOpenFile={open} onOpenDiff={(task, p) => openDiff({ kind: "task", task, path: p })} refresh={refresh} notify={notify} tab={layout.rightTab as CoordTab} setTab={(t) => set({ rightTab: t })} selected={selectedTask} setSelected={setSelectedTask} newTaskNonce={newTaskNonce} />
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      {/* ===================== Status bar ===================== */}
      <footer style={{ height: STATUS_H }} className="tnum flex shrink-0 select-none items-stretch border-t border-rule bg-status-bg font-mono text-[11px] text-status-fg" aria-label="Status bar">
        <span title={live ? "Connected to the Relay server" : "Reconnecting to the Relay server"} className={`flex items-center gap-1.5 px-2.5 font-semibold tracking-[0.06em] ${live ? "bg-remote text-remote-fg" : "bg-warn-soft text-warn"}`}>
          <span className={`size-1.5 rounded-full ${live ? "live-dot bg-remote-fg" : "bg-warn"}`} />
          {live ? "RELAY" : "RECONNECTING"}
        </span>
        <StatusItem title="Branch / HEAD" onClick={() => showView("scm")}>
          <GitBranch size={12} /> {s.project.head ?? "–"}
          {git.size > 0 && <span>*</span>}
        </StatusItem>
        <StatusItem title="Problems" onClick={() => openPanel("problems")} testId="status-problems">
          <CircleAlert size={12} /> {problems.filter((p) => p.severity === "error").length + (syntax?.length ?? 0)} <TriangleAlert size={12} className="ml-1" /> {problems.filter((p) => p.severity === "warning").length}
        </StatusItem>
        {runningAgents > 0 && (
          <StatusItem title="Agents working" onClick={() => openPanel("agents")}>
            <Bot size={12} /> {runningAgents} working
          </StatusItem>
        )}
        <span className="ml-auto" />
        {session && (
          <>
            <StatusItem title="Collaboration sync" testId="sync-status">
              {pending ? "Offline edits pending" : status === "synced" ? "Synced" : status === "connecting" ? "Connecting…" : "Offline"}
            </StatusItem>
            <StatusItem title="Go to Line" onClick={() => execute(commands.find((c) => c.id === "go.line")!)}>
              Ln {cursor[0]}, Col {cursor[1]}
            </StatusItem>
            <StatusItem title="Encoding">UTF-8</StatusItem>
            <StatusItem title="End of line">{eol}</StatusItem>
            <StatusItem title="Language">{LANG[ext] ?? "Plain Text"}</StatusItem>
          </>
        )}
        {following && (
          <button onClick={() => setFollowing(null)} title="Stop following (Esc)" data-testid="following" className="inline-flex items-center gap-1.5 bg-accent-soft px-2 text-accent-ink hover:brightness-110">
            <span className="size-1.5 rounded-full bg-accent" /> following {s.members.find((m) => m.id === following)?.name ?? following} · stop
          </button>
        )}
        {session && session.typing().filter((id) => id !== me!.id).length > 0 && (
          <StatusItem title="Typing in this file">{session.typing().filter((id) => id !== me!.id).map((id) => s.members.find((m) => m.id === id)?.name ?? id).join(", ")} typing</StatusItem>
        )}
        <StatusItem title={`${online.size} people here`} onClick={() => showView("community")}>
          <Users size={12} /> {online.size}
        </StatusItem>
        <div className="relative">
          <StatusItem title="Notifications" onClick={() => setBell((b) => !b)} testId="notifications">
            <Bell size={12} />
            {notes.length > 0 && <span>{notes.length}</span>}
          </StatusItem>
          {bell && (
            <div role="dialog" aria-label="Notifications" className="glass absolute bottom-full right-1 z-50 mb-1.5 w-96 overflow-hidden rounded-md border border-rule-strong font-sans">
              <div className="micro flex h-8 items-center justify-between border-b border-rule px-3 text-muted">
                Notifications
                <button className="font-sans text-[12px] normal-case tracking-normal text-accent-ink hover:underline" onClick={() => setNotes([])}>
                  Clear all
                </button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {notes.length === 0 && <p className="px-3 py-3 text-[12.5px] text-muted">No notifications.</p>}
                {notes.map((n) => (
                  <p key={n.id} className={`border-b border-rule px-3 py-2 text-[12.5px] ${n.tone === "danger" ? "text-danger" : "text-ink-2"}`}>
                    {n.msg}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </footer>

      <CommandPalette open={palette.open} mode={palette.mode} files={files} openEditors={[...new Set([...(active ? [active] : []), ...recent.filter((r) => tabs.includes(r))])]} commands={commands} onClose={() => setPalette((p) => ({ ...p, open: false }))} onOpenFile={(p) => open(p)} />

      <div className="pointer-events-none fixed bottom-8 right-3 z-50 flex flex-col items-end gap-2" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 12 }} transition={{ type: "spring", stiffness: 480, damping: 36 }} role="status" className={`glass pointer-events-auto flex max-w-md items-start gap-2.5 rounded-md border border-rule-strong py-2 pl-2.5 pr-3 text-[12.5px] ${t.tone === "danger" ? "text-danger" : "text-ink"}`}>
              <span className={`mt-[5px] size-1.5 shrink-0 rounded-full ${t.tone === "danger" ? "bg-danger" : "bg-ok"}`} />
              <span>{t.msg}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function StatusItem({ children, title, onClick, testId }: { children: React.ReactNode; title: string; onClick?: () => void; testId?: string }) {
  const cls = "inline-flex h-full items-center gap-1 px-2 whitespace-nowrap";
  return onClick ? (
    <button title={title} aria-label={title} onClick={onClick} data-testid={testId} className={`${cls} hover:bg-hover hover:text-ink`}>
      {children}
    </button>
  ) : (
    <span title={title} data-testid={testId} className={cls}>
      {children}
    </span>
  );
}

/** Relay's task overview in the primary side bar: filters plus a compact list; details open on the right. */
function RelayView({ state, onTask, onNewTask }: { state: ProjectState; onTask: (id: string) => void; onNewTask: () => void }) {
  const [filter, setFilter] = useState<"all" | "needs" | "mine" | "agents">("all");
  const tasks = state.tasks.filter((t) =>
    filter === "needs" ? ["review_required", "proposed", "blocked"].includes(t.state) : filter === "mine" ? t.owner === state.me.id : filter === "agents" ? t.runs.length > 0 : true,
  );
  const groups: [string, Task[]][] = [
    ["Needs a person", tasks.filter((t) => ["review_required", "proposed", "blocked"].includes(t.state))],
    ["In progress", tasks.filter((t) => ["queued", "running"].includes(t.state))],
    ["Done", tasks.filter((t) => ["completed", "cancelled", "failed"].includes(t.state))],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title="Relay"
        actions={
          state.me.role !== "viewer" && (
            <button aria-label="New task" title="New task" onClick={onNewTask} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
              +
            </button>
          )
        }
      />
      <div className="flex gap-1 px-3 pb-2" role="radiogroup" aria-label="Filter tasks">
        {(
          [
            ["all", "All"],
            ["needs", "Needs me"],
            ["mine", "Mine"],
            ["agents", "Agents"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="radio" aria-checked={filter === id} onClick={() => setFilter(id)} className={`h-[22px] rounded-sm px-2 text-[12px] ${filter === id ? "bg-accent-soft text-ink" : "text-muted hover:bg-hover"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.tasks.length === 0 && <p className="px-5 py-2 text-[12.5px] text-muted">No tasks yet. Ask the agent or create a task.</p>}
        {groups.map(([label, list]) =>
          list.length ? (
            <Section key={label} title={label} count={list.length}>
              {list.map((t) => (
                <button key={t.id} onClick={() => onTask(t.id)} data-testid={`relay-task-${t.id}`} className="flex w-full items-center gap-2 py-1 pl-5 pr-3 text-left hover:bg-hover">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{t.objective}</span>
                    <span className="block truncate font-mono text-[11px] text-faint">
                      {t.id} · {Object.entries(t.contracts).map(([c, v]) => `${c} v${v}`).join(", ") || "no contracts"}
                    </span>
                  </span>
                  <StatePill state={t.state} />
                </button>
              ))}
            </Section>
          ) : null,
        )}
      </div>
    </div>
  );
}

function EmptyEditor({ commands, recent, onOpen }: { commands: Command[]; recent: string[]; onOpen: (p: string) => void }) {
  const rows = ["palette.commands", "palette.files", "search.inFiles", "agent.focus", "terminal.toggle"].map((id) => commands.find((c) => c.id === id)).filter(Boolean) as Command[];
  return (
    <div className="dot-grid grid flex-1 place-items-center overflow-y-auto p-8" data-testid="empty-editor">
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.2, 0.7, 0.2, 1] }} className="ticks w-full max-w-[400px] border border-rule bg-editor/90 p-6">
        <div className="mb-6 flex items-center gap-3">
          <Mark size={30} />
          <div>
            <p className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Relay</p>
            <p className="micro mt-0.5 text-faint">One project · any model · in sync</p>
          </div>
        </div>
        <div className="divide-y divide-rule border-y border-rule">
          {rows.map((c) => {
            const reason = availability(c);
            return (
              <button key={c.id} onClick={() => execute(c)} disabled={!!reason} title={reason ?? undefined} className="group flex h-8 w-full items-center justify-between px-1 text-[12.5px] text-ink-2 transition-colors hover:text-ink disabled:opacity-45">
                <span className="flex items-center gap-2">
                  <span className="h-px w-2 bg-rule-strong transition-all group-hover:w-3 group-hover:bg-accent" />
                  {c.title.replace(/…$/, "")}
                </span>
                {c.keybinding && <kbd className="rounded-sm border border-rule px-1.5 py-px font-mono text-[10.5px] text-muted">{keyLabel(c.keybinding)}</kbd>}
              </button>
            );
          })}
        </div>
        {recent.length > 0 && (
          <div className="mt-6">
            <p className="micro mb-1.5 px-1 text-faint">Recent</p>
            {recent.slice(0, 5).map((p) => (
              <button key={p} onClick={() => onOpen(p)} className="block w-full truncate rounded-sm px-1 py-0.5 text-left font-mono text-[12px] text-ink-2 hover:text-accent-ink">
                {p}
              </button>
            ))}
          </div>
        )}
        <p className="mt-6 px-1 font-mono text-[10.5px] text-faint">{isMac ? "⌘" : "Ctrl"}+P files · &gt; commands</p>
      </motion.div>
    </div>
  );
}

function Splash({ message }: { message?: string }) {
  return (
    <div className="dot-grid grid h-screen place-items-center bg-chrome">
      <div className="flex flex-col items-center gap-4 text-center">
        <Mark size={28} />
        <div className="h-px w-24 overflow-hidden bg-rule">
          {!message && <motion.div className="h-full w-8 bg-accent" animate={{ x: [-32, 96] }} transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }} />}
        </div>
        <p className="micro text-muted">{message ?? "Opening the project"}</p>
      </div>
    </div>
  );
}

function SignedOut() {
  return (
    <div className="dot-grid grid h-screen place-items-center bg-chrome p-6">
      <div className="ticks max-w-sm border border-rule bg-sidebar p-6">
        <Mark size={26} />
        <h1 className="mt-4 text-[18px] font-semibold tracking-[-0.01em]">You&apos;re not signed in</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">Ask the project owner for an invite. They can create one with</p>
        <code className="mt-3 block rounded-sm border border-rule bg-sunken px-2 py-1.5 font-mono text-[12px]">relay ide invite &lt;your name&gt;</code>
      </div>
    </div>
  );
}
