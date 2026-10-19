"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Moon, Sun, X, GitBranch, PanelRightClose, PanelRightOpen, Eye } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { DocSession } from "@/lib/collab";
import { applyTheme, initialTheme } from "@/lib/theme";
import type { Theme } from "@/lib/theme";
import type { Member, ProjectState } from "@/lib/types";
import { useProject } from "@/lib/useProject";
import { Coordination } from "./Coordination";
import { Editor } from "./Editor";
import { FileTree } from "./FileTree";
import { Avatar, IconButton, Mark, Pill } from "./ui";

function useSession(session: DocSession | null) {
  const sub = useCallback((fn: () => void) => {
    if (!session) return () => {};
    const off = session.subscribe(fn);
    const onAwareness = () => fn();
    session.provider.awareness.on("change", onAwareness);
    return () => {
      off();
      session.provider.awareness.off("change", onAwareness);
    };
  }, [session]);
  const snap = useCallback(() => (session ? `${session.status}|${session.peers().map((p) => p.clientId).join(",")}` : "none"), [session]);
  useSyncExternalStore(sub, snap, () => "none");
  return session ? { status: session.status, peers: session.peers() } : { status: "offline" as const, peers: [] };
}

interface Toast {
  id: number;
  msg: string;
  tone: "ok" | "danger";
}

export function IDE() {
  const { load, events, files, live, refresh, refreshFiles } = useProject();
  const [theme, setTheme] = useState<Theme>("light");
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [panel, setPanel] = useState(true);
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sessions = useRef(new Map<string, DocSession>());

  useEffect(() => setTheme(initialTheme()), []);
  useEffect(() => applyTheme(theme), [theme]);

  const notify = useCallback((msg: string, tone: "ok" | "danger" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "danger" ? 7000 : 3800);
  }, []);

  const me = load.kind === "ready" ? load.state.me : null;
  const sessionFor = useCallback(
    (path: string, member: Member) => {
      let s = sessions.current.get(path);
      if (!s) {
        s = new DocSession(path, member);
        sessions.current.set(path, s);
      }
      return s;
    },
    [],
  );

  const open = useCallback(
    (path: string) => {
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setActive(path);
    },
    [],
  );
  const close = (path: string) => {
    sessions.current.get(path)?.destroy();
    sessions.current.delete(path);
    setTabs((t) => {
      const next = t.filter((x) => x !== path);
      if (active === path) setActive(next.at(-1) ?? null);
      return next;
    });
  };
  useEffect(() => () => sessions.current.forEach((s) => s.destroy()), []);

  const session = me && active ? sessionFor(active, me) : null;
  const { status, peers } = useSession(session);
  const onCursor = useCallback((l: number, c: number) => setCursor([l, c]), []);

  if (load.kind === "loading") return <Splash />;
  if (load.kind === "signed-out") return <SignedOut />;
  if (load.kind === "error") return <Splash message={load.message} />;

  const state: ProjectState = load.state;
  const presence = new Map(state.presence.map((p) => [p.path, p.members]));
  // Live awareness in the open file is fresher than the server's polled presence; merge both.
  if (active) presence.set(active, [...new Set([...(presence.get(active) ?? []), me!.id, ...peers.map((p) => p.id)])]);
  const online = new Set([...presence.values()].flat());
  const membersById = new Map(state.members.map((m) => [m.id, m]));
  const where = (id: string) => state.presence.find((p) => p.members.includes(id))?.path;

  return (
    <div className="relative z-10 flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-4 px-4">
        <div className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">Relay</span>
          <span className="text-faint">/</span>
          <span className="serif-em text-[19px] leading-none text-ink">{state.project.name}</span>
          {state.project.head && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] text-muted">
              <GitBranch size={11} /> {state.project.head}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center -space-x-1" aria-label="People in this project">
            <AnimatePresence>
              {state.members
                .filter((m) => online.has(m.id) || m.id === me!.id)
                .map((m) => (
                  <Avatar key={m.id} name={m.name} color={m.color} ring={m.id !== me!.id} title={`${m.name}${m.id === me!.id ? " (you)" : ""}${where(m.id) ? ` · ${where(m.id)}` : ""}`} />
                ))}
            </AnimatePresence>
          </div>
          <span className="h-5 w-px bg-rule" />
          {me!.role === "viewer" && (
            <Pill tone="neutral">
              <Eye size={11} /> Viewing
            </Pill>
          )}
          <IconButton label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
          <IconButton label={panel ? "Hide coordination" : "Show coordination"} onClick={() => setPanel((p) => !p)}>
            {panel ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </IconButton>
        </div>
      </header>

      {/* Body: three floating panels on the page */}
      <div className="flex min-h-0 flex-1 gap-2.5 px-2.5 pb-1">
        <aside className="w-60 shrink-0 overflow-hidden rounded-[18px] border border-rule bg-panel shadow-panel">
          <FileTree
            files={files}
            active={active}
            presence={presence}
            members={state.members}
            me={me!}
            canEdit={me!.role !== "viewer"}
            onOpen={open}
            onCreate={(p) =>
              void api("POST", "/files", { path: p })
                .then(() => (refreshFiles(), open(p)))
                .catch((e) => notify(e instanceof ApiError ? e.message : String(e), "danger"))
            }
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-rule bg-panel shadow-panel">
          {tabs.length > 0 && (
            <div className="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-rule bg-panel-2 px-2" role="tablist">
              {tabs.map((t) => {
                const on = t === active;
                return (
                  <div key={t} role="tab" aria-selected={on} className={`group relative flex h-9 items-center gap-2 rounded-t-xl pl-3.5 pr-1.5 text-[12.5px] ${on ? "bg-panel text-ink" : "text-muted hover:text-ink"}`}>
                    {on && <motion.span layoutId="tab-accent" className="absolute inset-x-3 top-0 h-[2px] rounded-full bg-accent" />}
                    <button onClick={() => setActive(t)} className="max-w-48 truncate font-medium">
                      {t.split("/").pop()}
                    </button>
                    <span className="flex -space-x-1">
                      {(presence.get(t) ?? [])
                        .filter((id) => id !== me!.id)
                        .slice(0, 3)
                        .map((id) => (
                          <span key={id} className="size-1.5 rounded-full" style={{ background: membersById.get(id)?.color }} />
                        ))}
                    </span>
                    <button aria-label={`Close ${t}`} onClick={() => close(t)} className="grid size-5 place-items-center rounded-md text-faint opacity-0 hover:bg-sunken hover:text-ink group-hover:opacity-100">
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {session ? (
            <>
              <div className="flex h-9 shrink-0 items-center justify-between px-5 text-[12px] text-muted">
                <span className="font-mono">{active!.split("/").join("  ›  ")}</span>
                <span className="flex items-center gap-2">
                  <AnimatePresence>
                    {peers.map((p) => (
                      <motion.span key={p.clientId} initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium" style={{ background: p.color + "1f", color: p.color }}>
                        <span className="size-1.5 rounded-full" style={{ background: p.color }} /> {p.name}
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <Editor key={session.path} session={session} readOnly={me!.role === "viewer"} onCursor={onCursor} />
              </div>
            </>
          ) : (
            <Welcome name={me!.name} onOpen={open} files={files} />
          )}
        </main>

        <AnimatePresence initial={false}>
          {panel && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 372, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 38 }}
              className="shrink-0 overflow-hidden rounded-[18px] border border-rule bg-panel shadow-panel"
            >
              <div className="h-full w-[372px]">
                <Coordination state={state} events={events} onOpenFile={open} refresh={refresh} notify={notify} />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {/* Status bar */}
      <footer className="flex h-8 shrink-0 items-center gap-4 px-5 text-[11.5px] text-muted">
        <span className="inline-flex items-center gap-1.5" data-testid="sync-status">
          <span className={`size-1.5 rounded-full ${session ? (status === "synced" ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : "bg-danger") : live ? "bg-ok" : "bg-danger"}`} />
          {session ? (status === "synced" ? "Synced" : status === "connecting" ? "Connecting…" : "Offline — edits are kept and sync on reconnect") : live ? "Connected" : "Reconnecting…"}
        </span>
        <span>{online.size} here</span>
        {state.conflicts.length > 0 && <span className="text-danger">{state.conflicts.length} outside edit{state.conflicts.length > 1 ? "s" : ""} need review</span>}
        <span className="ml-auto">{session ? `Ln ${cursor[0]}, Col ${cursor[1]}` : ""}</span>
        <span>{me!.name} · {me!.role}</span>
      </footer>

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-12 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6 }}
              className={`pointer-events-auto max-w-lg rounded-2xl px-4 py-2.5 text-[13px] shadow-pop ${t.tone === "danger" ? "bg-danger text-panel" : "bg-ink text-panel"}`}
              role="status"
            >
              {t.msg}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Welcome({ name, files, onOpen }: { name: string; files: string[]; onOpen: (p: string) => void }) {
  const first = files.find((f) => /\.(m?[jt]sx?|py|md)$/.test(f));
  return (
    <div className="grid flex-1 place-items-center p-10">
      <div className="max-w-md text-center">
        <p className="text-[13px] font-medium text-muted">Hello, {name.split(" ")[0]}.</p>
        <h1 className="mt-3 text-[46px] leading-[1.02] tracking-[-0.01em]">
          Pick a file.
          <br />
          <span className="serif-em text-accent-ink">Everyone sees it live.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-[14px] leading-relaxed text-ink-2">Edits, cursors and selections sync as you type. Agents work in their own copies and only land here after Relay checks them and a person approves.</p>
        {first && (
          <button onClick={() => onOpen(first)} className="mt-6 inline-flex h-9 items-center rounded-full bg-ink px-4 text-[13px] font-medium text-panel hover:bg-ink-2">
            Open {first}
          </button>
        )}
      </div>
    </div>
  );
}

function Splash({ message }: { message?: string }) {
  return (
    <div className="relative z-10 grid h-screen place-items-center">
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
        <Mark size={30} />
        <h1 className="mt-4 text-[34px] leading-none">
          You&apos;re <span className="serif-em">not signed in.</span>
        </h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">Ask the project owner for an invite. They can create one with</p>
        <code className="mt-2 inline-block rounded-lg bg-sunken px-2 py-1 font-mono text-[12px]">relay ide invite &lt;your name&gt;</code>
      </div>
    </div>
  );
}
