"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, Trash2 } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { api } from "@/lib/api";

export interface TerminalAvailability {
  available: boolean;
  reason: string | null;
}

/** Take focus only if nothing else has it (or it's already inside a terminal): never steal it from a dialog or field. */
function focusIfFree(t: XTerm) {
  const a = document.activeElement as HTMLElement | null;
  const free = !a || a === document.body || !!a.closest(".xterm") || !!a.closest(".cm-editor") || a.tagName === "BUTTON";
  if (free && !document.querySelector("[role=dialog][aria-modal=true]")) t.focus();
}

function themeFromCss() {
  const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return { background: v("--editor"), foreground: v("--ink"), cursor: v("--ink"), cursorAccent: v("--editor"), selectionBackground: v("--selection") };
}

/** One shell session. Stays mounted (hidden) when not shown so its scrollback and connection survive. */
function TerminalView({ initialId, visible, focusNonce, theme, onSession, onExit, inject }: { initialId: string | null; visible: boolean; focusNonce: number; theme: string; onSession: (id: string) => void; onExit: (code: number) => void; inject?: { text: string; nonce: number } | null }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const queued = useRef<string[]>([]);

  useEffect(() => {
    let disposed = false;
    let sessionId = initialId;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ro: ResizeObserver | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const t = new Terminal({ fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, monospace", fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, allowProposedApi: false, theme: themeFromCss(), scrollback: 5000 });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(host.current);
      term.current = t;
      fit.current = f;
      // Focus was requested before xterm finished loading: honour it now, unless the user has moved on
      // (e.g. opened the command palette) in the meantime.
      if (visibleRef.current) requestAnimationFrame(() => focusIfFree(t));
      const send = (o: unknown) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(o));
      t.onData((data) => send({ type: "input", data }));
      t.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
      const connect = () => {
        try {
          f.fit();
        } catch {}
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const sock = new WebSocket(`${proto}//${location.host}/terminal?session=${sessionId ?? ""}&cols=${t.cols}&rows=${t.rows}`);
        ws.current = sock;
        let replaying = !!sessionId;
        sock.onmessage = (m) => {
          const msg = JSON.parse(String(m.data)) as { type: string; id?: string; data?: string; code?: number; message?: string };
          if (msg.type === "ready" && msg.id) {
            if (replaying) t.reset();
            replaying = false;
            sessionId = msg.id;
            onSession(msg.id);
            setError(null);
            ready.current = true;
            for (const q of queued.current.splice(0)) sock.send(JSON.stringify({ type: "input", data: q }));
          } else if (msg.type === "output" && msg.data) t.write(msg.data);
          else if (msg.type === "exit") {
            t.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
            onExit(msg.code ?? 0);
          } else if (msg.type === "error") setError(msg.message ?? "Terminal unavailable");
        };
        sock.onclose = (ev) => {
          ready.current = false;
          if (disposed || ev.code === 4403 || ev.code === 1000) return;
          retry = setTimeout(connect, 1500); // the server keeps the shell; reconnecting reattaches it
        };
      };
      connect();
      ro = new ResizeObserver(() => {
        if (host.current && host.current.offsetWidth > 0) {
          try {
            f.fit();
          } catch {}
        }
      });
      ro.observe(host.current);
    })();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      ro?.disconnect();
      ws.current?.close();
      term.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (term.current) term.current.options.theme = themeFromCss();
  }, [theme]);
  // Run a command typed by the IDE (e.g. a package script from the Run view), exactly as if the user typed it.
  useEffect(() => {
    if (!inject) return;
    const data = inject.text + "\r";
    if (ready.current && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "input", data }));
    else queued.current.push(data);
  }, [inject]);
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {}
      if (term.current) focusIfFree(term.current);
    });
  }, [visible, focusNonce]);

  return (
    <div className={`relative h-full ${visible ? "" : "hidden"}`}>
      {error && <p className="absolute inset-x-0 top-0 z-10 bg-danger-soft px-3 py-1.5 text-[12px] text-danger">{error}</p>}
      <div ref={host} className="h-full" data-testid="terminal" />
    </div>
  );
}

interface Tab {
  key: string;
  id: string | null;
  exited: number | null;
}

export function TerminalPanel({ availability, visible, focusNonce, newNonce, theme, run }: { availability: TerminalAvailability | null; visible: boolean; focusNonce: number; newNonce: number; theme: string; run?: { text: string; nonce: number } | null }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const seq = useRef(0);

  const add = () => {
    const key = `t${++seq.current}`;
    setTabs((t) => [...t, { key, id: null, exited: null }]);
    setActive(key);
  };
  // Opening the terminal with none running starts one; "New Terminal" always adds one.
  useEffect(() => {
    if (visible && availability?.available && tabs.length === 0) add();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, availability?.available]);
  useEffect(() => {
    if (newNonce > 0 && availability?.available) add();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newNonce]);

  if (!availability) return <p className="p-3 text-[12.5px] text-muted">Checking terminal availability…</p>;
  if (!availability.available)
    return (
      <div className="flex h-full items-start gap-3 p-4 text-[12.5px]">
        <SquareTerminal size={16} className="mt-0.5 shrink-0 text-faint" />
        <div>
          <p className="font-medium text-ink">Terminal unavailable</p>
          <p className="mt-1 max-w-xl leading-relaxed text-muted">{availability.reason}</p>
        </div>
      </div>
    );

  const kill = (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    if (tab?.id) void api("POST", `/terminals/${tab.id}/kill`).catch(() => {});
    setTabs((ts) => {
      const next = ts.filter((t) => t.key !== key);
      if (active === key) setActive(next.at(-1)?.key ?? null);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            initialId={t.id}
            visible={visible && t.key === active}
            focusNonce={focusNonce}
            theme={theme}
            onSession={(id) => setTabs((ts) => ts.map((x) => (x.key === t.key ? { ...x, id } : x)))}
            onExit={(code) => setTabs((ts) => ts.map((x) => (x.key === t.key ? { ...x, exited: code } : x)))}
            inject={t.key === active ? run : null}
          />
        ))}
        {tabs.length === 0 && (
          <div className="p-4 text-[12.5px] text-muted">
            No terminal open.{" "}
            <button className="text-accent-ink hover:underline" onClick={add}>
              New terminal
            </button>
          </div>
        )}
      </div>
      <div className="flex w-40 shrink-0 flex-col border-l border-rule">
        <div className="flex h-6 items-center justify-end gap-0.5 px-1">
          <button aria-label="New terminal" title="New terminal" onClick={add} className="grid size-5 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
            <Plus size={13} />
          </button>
        </div>
        <div role="tablist" aria-label="Terminals" className="min-h-0 flex-1 overflow-y-auto">
          {tabs.map((t, i) => (
            <div key={t.key} role="tab" aria-selected={t.key === active} className={`group flex h-[22px] items-center gap-1.5 px-2 text-[12px] ${t.key === active ? "bg-hover text-ink" : "text-muted hover:bg-hover"}`}>
              <button onClick={() => setActive(t.key)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                <SquareTerminal size={12} className="shrink-0" />
                <span className="truncate">
                  shell {i + 1}
                  {t.exited !== null ? ` (exit ${t.exited})` : ""}
                </span>
              </button>
              <button aria-label={`Kill terminal ${i + 1}`} title="Kill terminal" onClick={() => kill(t.key)} className="text-faint opacity-0 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
