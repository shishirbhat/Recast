"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { AtSign, ChevronRight, FileCode2, Hash, Search } from "lucide-react";
import { api } from "@/lib/api";
import { availability, execute, fuzzy, keyLabel } from "@/lib/commands";
import type { Command } from "@/lib/commands";
import type { FileSymbol } from "@/lib/symbols";

/** A VS Code-style quick pick: a titled list of choices, each of which does one thing. */
export interface QuickPick {
  placeholder: string;
  items: { id: string; label: string; description?: string; picked?: boolean; run: () => void }[];
}

type Item =
  | { kind: "file"; key: string; path: string; open: boolean }
  | { kind: "cmd"; key: string; c: Command; reason: string | null }
  | { kind: "pick"; key: string; it: QuickPick["items"][number] }
  | { kind: "line"; key: string; line: number; label: string }
  | { kind: "symbol"; key: string; name: string; symKind: string; path: string | null; line: number }
  | { kind: "help"; key: string; prefix: string; label: string }
  | { kind: "note"; key: string; label: string };

/** The palette's prefixes, as VS Code has them. "?" lists them. */
const PREFIXES = [
  { prefix: "", label: "Go to File" },
  { prefix: ">", label: "Show and Run Commands" },
  { prefix: ":", label: "Go to Line" },
  { prefix: "@", label: "Go to Symbol in Editor" },
  { prefix: "#", label: "Go to Symbol in Workspace" },
  { prefix: "?", label: "Help" },
];

/**
 * Quick input in the VS Code mould. Files by default (open editors first); ">" commands, ":" a line, "@" a symbol in
 * the open file, "#" a symbol anywhere, "?" help. A quick pick replaces the list with its own choices.
 * Restores focus to whatever had it before opening.
 */
export function CommandPalette({
  open,
  prefix,
  files,
  openEditors,
  commands,
  pick,
  activeFile,
  lineCount,
  fileSymbols,
  onClose,
  onOpenFile,
}: {
  open: boolean;
  /** Text the input opens with ("" files, ">" commands, ":" line …). Ignored while a quick pick is shown. */
  prefix: string;
  files: string[];
  openEditors: string[];
  commands: Command[];
  pick?: QuickPick | null;
  activeFile: string | null;
  lineCount: number;
  fileSymbols: () => FileSymbol[];
  onClose: () => void;
  onOpenFile: (p: string, line?: number) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ q: string; items: Item[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setQ(pick ? "" : prefix);
      setSel(0);
      setNotice(null);
      // Take focus now, not a frame later: keys typed right after the shortcut must land in the palette, never in
      // the code behind it. (The frame-later call covers the first open, before the input exists.)
      input.current?.focus();
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open, prefix, pick]);

  const close = (restore = true) => {
    onClose();
    if (restore) requestAnimationFrame(() => returnFocus.current?.focus?.());
  };

  const isPick = !!pick;
  const mode = isPick ? "pick" : (PREFIXES.find((p) => p.prefix && q.startsWith(p.prefix))?.prefix ?? "");
  const term = (mode && mode !== "pick" ? q.slice(1) : q).trim();

  // Workspace symbols come from the server; debounced, and only the latest answer counts.
  useEffect(() => {
    if (mode !== "#" || !term) return;
    const t = setTimeout(() => {
      void api<{ symbols: { name: string; kind: string; path: string; line: number }[] }>("GET", `/symbols?q=${encodeURIComponent(term)}`).then(
        (r) => setRemote({ q: term, items: r.symbols.map((s) => ({ kind: "symbol" as const, key: `${s.path}:${s.line}`, name: s.name, symKind: s.kind, path: s.path, line: s.line })) }),
        () => setRemote({ q: term, items: [{ kind: "note", key: "err", label: "Couldn't search the workspace" }] }),
      );
    }, 150);
    return () => clearTimeout(t);
  }, [mode, term]);

  const items: Item[] = useMemo(() => {
    if (mode === "pick") {
      return pick!.items
        .map((it) => ({ it, s: fuzzy(term, `${it.label} ${it.description ?? ""}`) }))
        .filter((x) => x.s !== null)
        .sort((x, y) => (term ? y.s! - x.s! : 0))
        .map(({ it }) => ({ kind: "pick" as const, key: it.id, it }));
    }
    if (mode === ">") {
      return commands
        .filter((c) => c.palette !== false)
        .map((c) => ({ c, s: fuzzy(term, `${c.category}: ${c.title} ${(c.keywords ?? []).join(" ")}`) }))
        .filter((x) => x.s !== null)
        .sort((x, y) => y.s! - x.s!)
        .slice(0, 80)
        .map(({ c }) => ({ kind: "cmd" as const, key: c.id, c, reason: availability(c) }));
    }
    if (mode === "?") return PREFIXES.filter((p) => p.prefix !== "?").map((p) => ({ kind: "help" as const, key: p.label, prefix: p.prefix, label: p.label }));
    if (mode === ":") {
      if (!activeFile) return [{ kind: "note" as const, key: "none", label: "Open a file to go to a line" }];
      const [l, c] = term.split(/[:,]/).map(Number);
      if (!term || !l || l < 1) return [{ kind: "note" as const, key: "hint", label: `Type a line number between 1 and ${lineCount} to go to it` }];
      const line = Math.min(l, lineCount);
      return [{ kind: "line" as const, key: "line", line, label: `Go to line ${line}${c ? `, column ${c}` : ""}${l > lineCount ? ` (the file has ${lineCount} lines)` : ""}` }];
    }
    if (mode === "@") {
      if (!activeFile) return [{ kind: "note" as const, key: "none", label: "Open a file to see its symbols" }];
      const syms = fileSymbols()
        .map((s) => ({ s, score: fuzzy(term, s.name) }))
        .filter((x) => x.score !== null)
        .sort((a, b) => (term ? b.score! - a.score! : a.s.line - b.s.line));
      if (!syms.length) return [{ kind: "note" as const, key: "empty", label: term ? "No matching symbols" : "No symbols found in this file" }];
      return syms.map(({ s }) => ({ kind: "symbol" as const, key: `${s.line}:${s.name}`, name: s.name, symKind: s.kind, path: null, line: s.line }));
    }
    if (mode === "#") {
      if (!term) return [{ kind: "note" as const, key: "hint", label: "Type the name of a function, class, type or heading" }];
      if (remote?.q !== term) return [{ kind: "note" as const, key: "loading", label: "Searching…" }];
      return remote.items.length ? remote.items : [{ kind: "note" as const, key: "empty", label: "No matching symbols" }];
    }
    const openSet = new Set(openEditors);
    const pool = [...openEditors, ...files.filter((f) => !openSet.has(f))];
    return pool
      .map((p) => ({ p, s: fuzzy(term, p) }))
      .filter((x) => x.s !== null)
      .sort((x, y) => (term ? y.s! - x.s! : 0))
      .slice(0, 80)
      .map(({ p }) => ({ kind: "file" as const, key: p, path: p, open: openSet.has(p) }));
  }, [mode, pick, term, commands, files, openEditors, activeFile, lineCount, fileSymbols, remote]);

  // A quick pick opens on the current choice.
  useEffect(() => {
    if (isPick) setSel(Math.max(0, items.findIndex((i) => i.kind === "pick" && i.it.picked)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPick, pick]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  /** Close, put focus back where it was, then act (the action may move focus on purpose). */
  const thenRun = (fn: () => void) => {
    onClose();
    returnFocus.current?.focus?.();
    fn();
  };
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === "pick") thenRun(it.it.run);
    else if (it.kind === "cmd") {
      if (it.reason) return setNotice(it.reason);
      thenRun(() => execute(it.c));
    } else if (it.kind === "file") {
      close(false);
      onOpenFile(it.path);
    } else if (it.kind === "line") {
      close(false);
      onOpenFile(activeFile!, it.line);
    } else if (it.kind === "symbol") {
      close(false);
      onOpenFile(it.path ?? activeFile!, it.line);
    } else if (it.kind === "help") {
      setQ(it.prefix);
      setSel(0);
      input.current?.focus();
    }
  };

  if (!open) return null;
  const label = isPick ? pick!.placeholder : (PREFIXES.find((p) => p.prefix === mode)?.label ?? "Go to File");
  const placeholder = isPick ? pick!.placeholder : mode === ">" ? "Type the name of a command to run" : mode === "" ? "Search files by name (type ? for help, > for commands)" : label;
  return (
    <div className="fixed inset-0 z-50" onMouseDown={() => close()}>
      <motion.div
        initial={{ opacity: 0, y: -4, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.14, ease: [0.2, 0.7, 0.2, 1] }}
        role="dialog"
        aria-modal="true"
        aria-label={mode === ">" ? "Command palette" : label}
        onMouseDown={(e) => e.stopPropagation()}
        className="glass absolute left-[calc(50%-min(300px,47vw))] top-[38px] w-[min(600px,94vw)] overflow-hidden rounded-md border border-rule-strong"
      >
        <div className="flex items-center gap-2 border-b border-rule px-3">
          {mode === "@" ? <AtSign size={13} className="text-accent" /> : mode === "#" ? <Hash size={13} className="text-accent" /> : mode === "" ? <Search size={13} className="text-accent" /> : <ChevronRight size={14} className="text-accent" />}
          <input
            ref={input}
            value={q}
            onChange={(e) => (setQ(e.target.value), setSel(0), setNotice(null))}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.preventDefault(), close());
              else if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
              else if (e.key === "Enter") (e.preventDefault(), choose(sel));
              else if (e.key === "Tab") e.preventDefault();
            }}
            placeholder={placeholder}
            className="h-10 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint focus-visible:outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[sel] ? `pal-${sel}` : undefined}
            data-testid="palette-input"
          />
        </div>
        {notice && (
          <p role="alert" className="border-b border-rule bg-warn-soft px-3 py-1.5 font-mono text-[11.5px] text-warn">
            {notice}
          </p>
        )}
        <div ref={list} id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
          {items.length === 0 && <p className="px-3 py-2 text-[12.5px] text-muted">{isPick ? "No matching items" : mode === ">" ? "No matching commands" : "No matching files"}</p>}
          {items.map((it, i) =>
            it.kind === "note" ? (
              <p key={it.key} className="px-2.5 py-1.5 text-[12.5px] text-muted" data-testid="palette-note">
                {it.label}
              </p>
            ) : (
              <div
                key={it.key}
                id={`pal-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === sel}
                aria-disabled={it.kind === "cmd" && !!it.reason}
                onMouseMove={() => setSel(i)}
                onClick={() => choose(i)}
                title={it.kind === "cmd" && it.reason ? it.reason : undefined}
                className={`flex h-[28px] cursor-default items-center gap-2 rounded-sm px-2.5 text-[13px] ${i === sel ? "bg-hover text-ink shadow-[inset_2px_0_0_var(--accent)]" : "text-ink-2"}`}
              >
                {it.kind === "pick" ? (
                  <>
                    <span className="truncate">{it.it.label}</span>
                    {it.it.description && <span className="truncate text-[11.5px] text-faint">{it.it.description}</span>}
                    {it.it.picked && <span className="ml-auto shrink-0 text-[11.5px] text-muted">current</span>}
                  </>
                ) : it.kind === "file" ? (
                  <>
                    <FileCode2 size={13} className="shrink-0 text-faint" />
                    <span>{it.path.split("/").pop()}</span>
                    <span className="truncate font-mono text-[11px] text-faint">{it.path.split("/").slice(0, -1).join("/")}</span>
                    {it.open && <span className="micro ml-auto text-faint">open</span>}
                  </>
                ) : it.kind === "line" ? (
                  <span>{it.label}</span>
                ) : it.kind === "symbol" ? (
                  <>
                    <span className="w-16 shrink-0 font-mono text-[11px] text-faint">{it.symKind}</span>
                    <span className="truncate">{it.name}</span>
                    <span className="ml-auto truncate font-mono text-[11px] text-faint">{it.path ? `${it.path}:${it.line}` : `line ${it.line}`}</span>
                  </>
                ) : it.kind === "help" ? (
                  <>
                    <span className="w-6 shrink-0 font-mono text-accent-ink">{it.prefix || "…"}</span>
                    <span>{it.label}</span>
                  </>
                ) : (
                  <>
                    <span className={it.reason ? "text-faint" : "text-muted"}>{it.c.category}:</span>
                    <span className={`truncate ${it.reason ? "text-faint" : ""}`}>{it.c.title}</span>
                    {it.c.checked?.() && <span className="text-[11.5px] text-muted">· on</span>}
                    {it.reason && <span className="truncate text-[11.5px] text-faint">· {it.reason}</span>}
                    {it.c.keybinding && <kbd className="ml-auto shrink-0 rounded-sm border border-rule px-1.5 font-mono text-[10.5px] text-muted">{keyLabel(it.c.keybinding)}</kbd>}
                  </>
                )}
              </div>
            ),
          )}
        </div>
        <div className="flex h-[24px] items-center gap-3 border-t border-rule px-3 font-mono text-[10.5px] text-faint">
          <span>↑↓ select</span>
          <span>↵ {mode === ">" ? "run" : isPick ? "choose" : "open"}</span>
          <span>esc close</span>
          <span className="ml-auto">{mode === "" ? "? for help" : label}</span>
        </div>
      </motion.div>
    </div>
  );
}
