"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ChevronRight, FileCode2, Search } from "lucide-react";
import { availability, execute, fuzzy, keyLabel } from "@/lib/commands";
import type { Command } from "@/lib/commands";

/** A VS Code-style quick pick: a titled list of choices, each of which does one thing. */
export interface QuickPick {
  placeholder: string;
  items: { id: string; label: string; description?: string; picked?: boolean; run: () => void }[];
}

type Item =
  | { kind: "file"; key: string; path: string; open: boolean }
  | { kind: "cmd"; key: string; c: Command; reason: string | null }
  | { kind: "pick"; key: string; it: QuickPick["items"][number] };

/**
 * Quick input in the VS Code mould: file names by default (open editors first), commands after ">".
 * Restores focus to whatever had it before opening.
 */
export function CommandPalette({ open, mode, files, openEditors, commands, pick, onClose, onOpenFile }: { open: boolean; mode: "files" | "commands" | "pick"; files: string[]; openEditors: string[]; commands: Command[]; pick?: QuickPick | null; onClose: () => void; onOpenFile: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setQ(mode === "commands" ? ">" : "");
      setSel(0);
      setNotice(null);
      // Take focus now, not a frame later: keys typed right after the shortcut must land in the palette, never in
      // the code behind it. (The frame-later call covers the first open, before the input exists.)
      input.current?.focus();
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open, mode, pick]);

  const close = (restore = true) => {
    onClose();
    if (restore) requestAnimationFrame(() => returnFocus.current?.focus?.());
  };

  const isPick = mode === "pick" && !!pick;
  const isCmd = !isPick && q.startsWith(">");
  const term = (isCmd ? q.slice(1) : q).trim();

  const items: Item[] = useMemo(() => {
    if (isPick) {
      return pick!.items
        .map((it) => ({ it, s: fuzzy(term, `${it.label} ${it.description ?? ""}`) }))
        .filter((x) => x.s !== null)
        .sort((x, y) => (term ? y.s! - x.s! : 0))
        .map(({ it }) => ({ kind: "pick" as const, key: it.id, it }));
    }
    if (isCmd) {
      return commands
        .filter((c) => c.palette !== false)
        .map((c) => ({ c, s: fuzzy(term, `${c.category}: ${c.title} ${(c.keywords ?? []).join(" ")}`) }))
        .filter((x) => x.s !== null)
        .sort((x, y) => y.s! - x.s!)
        .slice(0, 80)
        .map(({ c }) => ({ kind: "cmd" as const, key: c.id, c, reason: availability(c) }));
    }
    const openSet = new Set(openEditors);
    const pool = [...openEditors, ...files.filter((f) => !openSet.has(f))];
    return pool
      .map((p) => ({ p, s: fuzzy(term, p) }))
      .filter((x) => x.s !== null)
      .sort((x, y) => (term ? y.s! - x.s! : 0))
      .slice(0, 80)
      .map(({ p }) => ({ kind: "file" as const, key: p, path: p, open: openSet.has(p) }));
  }, [isPick, pick, isCmd, term, commands, files, openEditors]);
  // A quick pick opens on the current choice.
  useEffect(() => {
    if (isPick && !term) setSel(Math.max(0, items.findIndex((i) => i.kind === "pick" && i.it.picked)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPick, pick]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === "pick") {
      onClose();
      returnFocus.current?.focus?.();
      it.it.run();
    } else if (it.kind === "cmd") {
      if (it.reason) return setNotice(it.reason);
      // Like VS Code: put focus back where it was, then run the command (which may move it on purpose).
      onClose();
      returnFocus.current?.focus?.();
      execute(it.c);
    } else {
      close(false);
      onOpenFile(it.path);
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" onMouseDown={() => close()}>
      <motion.div
        initial={{ opacity: 0, y: -4, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.14, ease: [0.2, 0.7, 0.2, 1] }}
        role="dialog"
        aria-modal="true"
        aria-label={isPick ? pick!.placeholder : isCmd ? "Command palette" : "Go to file"}
        onMouseDown={(e) => e.stopPropagation()}
        className="glass absolute left-[calc(50%-min(300px,47vw))] top-[38px] w-[min(600px,94vw)] overflow-hidden rounded-md border border-rule-strong"
      >
        <div className="flex items-center gap-2 border-b border-rule px-3">
          {isCmd || isPick ? <ChevronRight size={14} className="text-accent" /> : <Search size={13} className="text-accent" />}
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
            placeholder={isPick ? pick!.placeholder : isCmd ? "Type the name of a command to run" : "Search files by name (append > to run commands)"}
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
          {items.length === 0 && <p className="px-3 py-2 text-[12.5px] text-muted">{isPick ? "No matching items" : isCmd ? "No matching commands" : "No matching files"}</p>}
          {items.map((it, i) => (
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
              ) : (
                <>
                  <span className={it.reason ? "text-faint" : "text-muted"}>{it.c.category}:</span>
                  <span className={`truncate ${it.reason ? "text-faint" : ""}`}>{it.c.title}</span>
                  {it.reason && <span className="truncate text-[11.5px] text-faint">· {it.reason}</span>}
                  {it.c.keybinding && <kbd className="ml-auto shrink-0 rounded-sm border border-rule px-1.5 font-mono text-[10.5px] text-muted">{keyLabel(it.c.keybinding)}</kbd>}
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex h-[24px] items-center gap-3 border-t border-rule px-3 font-mono text-[10.5px] text-faint">
          <span>↑↓ select</span>
          <span>↵ {isCmd ? "run" : isPick ? "choose" : "open"}</span>
          <span>esc close</span>
          <span className="ml-auto">{items.length} {isCmd ? "commands" : isPick ? "items" : "files"}</span>
        </div>
      </motion.div>
    </div>
  );
}
