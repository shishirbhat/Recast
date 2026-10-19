"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, FileCode2, Search } from "lucide-react";

export interface Command {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  run: () => void;
}

/** Subsequence fuzzy score: higher is better, null if `q` is not a subsequence of `s`. */
export function fuzzy(q: string, s: string): number | null {
  if (!q) return 0;
  const a = q.toLowerCase();
  const b = s.toLowerCase();
  let score = 0;
  let j = 0;
  let streak = 0;
  for (let i = 0; i < b.length && j < a.length; i++) {
    if (b[i] === a[j]) {
      streak++;
      score += 1 + streak * 2 + (i === 0 || "/._- ".includes(b[i - 1]!) ? 6 : 0);
      j++;
    } else streak = 0;
  }
  return j === a.length ? score - b.length * 0.05 : null;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = isMac ? "⌘" : "Ctrl+";
export function keyLabel(k: string): string {
  return k.replace("Mod+", mod).replace("Shift+", isMac ? "⇧" : "Shift+").replace("Alt+", isMac ? "⌥" : "Alt+");
}

/**
 * VS Code-style quick input: files by default, commands after ">".
 * Opening with mode "commands" pre-fills ">".
 */
export function CommandPalette({ open, mode, files, commands, recent, onClose, onOpenFile }: { open: boolean; mode: "files" | "commands"; files: string[]; commands: Command[]; recent: string[]; onClose: () => void; onOpenFile: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ(mode === "commands" ? ">" : "");
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open, mode]);

  const isCmd = q.startsWith(">");
  const term = (isCmd ? q.slice(1) : q).trim();

  const items = useMemo(() => {
    if (isCmd) {
      return commands
        .map((c) => ({ c, s: fuzzy(term, `${c.category}: ${c.title}`) }))
        .filter((x) => x.s !== null)
        .sort((x, y) => y.s! - x.s!)
        .slice(0, 60)
        .map(({ c }) => ({ kind: "cmd" as const, key: c.id, c }));
    }
    const pool = term ? files : [...new Set([...recent, ...files])];
    return pool
      .map((p) => ({ p, s: fuzzy(term, p) }))
      .filter((x) => x.s !== null)
      .sort((x, y) => (term ? y.s! - x.s! : 0))
      .slice(0, 60)
      .map(({ p }) => ({ kind: "file" as const, key: p, p }));
  }, [isCmd, term, commands, files, recent]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    if (it.kind === "cmd") it.c.run();
    else onOpenFile(it.p);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }} onMouseDown={onClose}>
          <motion.div
            role="dialog"
            aria-label={isCmd ? "Command palette" : "Go to file"}
            initial={{ y: -8, opacity: 0, scale: 0.99 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -6, opacity: 0 }}
            transition={{ type: "spring", stiffness: 600, damping: 40 }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute left-1/2 top-[52px] w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-rule-strong bg-panel shadow-pop"
          >
            <div className="flex items-center gap-2 border-b border-rule px-3">
              {isCmd ? <ChevronRight size={15} className="text-accent" /> : <Search size={14} className="text-muted" />}
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onClose();
                  else if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
                  else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
                  else if (e.key === "Enter") (e.preventDefault(), choose(sel));
                }}
                placeholder={isCmd ? "Type a command" : "Search files by name (type > for commands)"}
                className="h-11 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-faint focus-visible:outline-none"
                aria-controls="palette-list"
                data-testid="palette-input"
              />
            </div>
            <div ref={list} id="palette-list" role="listbox" className="max-h-[52vh] overflow-y-auto py-1.5">
              {items.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">{isCmd ? "No matching commands" : "No matching files"}</p>}
              {!isCmd && !term && recent.length > 0 && <p className="px-4 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">Recently opened</p>}
              {items.map((it, i) => (
                <button
                  key={it.key}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  onMouseMove={() => setSel(i)}
                  onClick={() => choose(i)}
                  className={`flex h-8 w-full items-center gap-2.5 px-4 text-left text-[13px] ${i === sel ? "bg-accent-soft text-ink" : "text-ink-2"}`}
                >
                  {it.kind === "file" ? (
                    <>
                      <FileCode2 size={14} className={i === sel ? "text-accent" : "text-faint"} />
                      <span className="font-medium">{it.p.split("/").pop()}</span>
                      <span className="truncate text-[12px] text-faint">{it.p.split("/").slice(0, -1).join("/")}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted">{it.c.category}:</span>
                      <span className="truncate">{it.c.title}</span>
                      {it.c.keybinding && <kbd className="ml-auto rounded-md border border-rule bg-panel-2 px-1.5 py-px font-sans text-[11px] text-muted">{keyLabel(it.c.keybinding)}</kbd>}
                    </>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
