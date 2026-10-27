"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { availability, execute, keyLabel } from "@/lib/commands";
import type { Command } from "@/lib/commands";

/**
 * Menus as VS Code draws them: command entries (title, shortcut, check mark for toggles), separators and submenus.
 * Every entry is a registered command or a direct action; an unavailable one stays visible, dimmed, with its reason.
 */
export type MenuEntry = string | "-" | { label: string; items: MenuEntry[] } | { label: string; run: () => void; reason?: string | null; keybinding?: string; checked?: boolean; danger?: boolean };

type Row =
  | { kind: "sep" }
  | { kind: "sub"; label: string; items: MenuEntry[] }
  | { kind: "item"; label: string; run: () => void; reason: string | null; keybinding?: string; checked?: boolean; danger?: boolean };

function rows(entries: MenuEntry[], byId: Map<string, Command>): Row[] {
  const out: Row[] = [];
  for (const e of entries) {
    if (e === "-") {
      if (out.length && out.at(-1)!.kind !== "sep") out.push({ kind: "sep" });
    } else if (typeof e === "string") {
      const c = byId.get(e);
      if (c) out.push({ kind: "item", label: c.title, run: () => execute(c), reason: availability(c), keybinding: c.keybinding, checked: c.checked?.() });
    } else if ("items" in e) out.push({ kind: "sub", label: e.label, items: e.items });
    else out.push({ kind: "item", label: e.label, run: e.run, reason: e.reason ?? null, keybinding: e.keybinding, checked: e.checked, danger: e.danger });
  }
  while (out.at(-1)?.kind === "sep") out.pop();
  return out;
}

/** One menu panel. Arrow keys move, Right/Enter open submenus, Left/Escape close them. */
export function MenuList({ entries, byId, onDone, autoFocus = false, label, onLeft, onRight }: { entries: MenuEntry[]; byId: Map<string, Command>; onDone: () => void; autoFocus?: boolean; label?: string; onLeft?: () => void; onRight?: () => void }) {
  const list = rows(entries, byId);
  const actionable = list.map((r, i) => (r.kind === "sep" ? -1 : i)).filter((i) => i >= 0);
  const [sel, setSel] = useState(autoFocus ? (actionable[0] ?? -1) : -1);
  const [sub, setSub] = useState<number | null>(null);
  const [subFocus, setSubFocus] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r && r.right > innerWidth - 4) setFlip(true);
  }, []);
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  const activate = (i: number) => {
    const r = list[i];
    if (!r || r.kind === "sep") return;
    if (r.kind === "sub") return (setSub(i), setSubFocus(true));
    if (r.reason) return;
    onDone();
    r.run();
  };
  const move = (d: number) => {
    const at = actionable.indexOf(sel);
    const next = actionable[(at + d + actionable.length) % actionable.length];
    if (next !== undefined) (setSel(next), setSub(null));
  };

  return (
    <div
      ref={box}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={`relative min-w-60 max-w-[min(420px,90vw)] rounded-md border border-rule-strong bg-panel-2 p-1 shadow-pop outline-none ${flip ? "right-0" : ""}`}
      onKeyDown={(e) => {
        if (sub !== null && subFocus) return; // the open submenu handles keys
        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Enter" || e.key === " ") activate(sel);
        else if (e.key === "ArrowRight") list[sel]?.kind === "sub" ? activate(sel) : onRight?.();
        else if (e.key === "ArrowLeft") onLeft ? onLeft() : onDone();
        else if (e.key === "Escape") onDone();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {list.map((r, i) =>
        r.kind === "sep" ? (
          <div key={`s${i}`} role="separator" className="mx-1.5 my-1 h-px bg-rule" />
        ) : (
          <div key={`${r.label}${i}`} className="relative" onMouseEnter={() => (setSel(i), setSub(r.kind === "sub" ? i : null), setSubFocus(false))}>
            <button
              role="menuitem"
              aria-haspopup={r.kind === "sub" ? "menu" : undefined}
              aria-expanded={r.kind === "sub" ? sub === i : undefined}
              aria-disabled={r.kind === "item" && !!r.reason}
              aria-checked={r.kind === "item" && r.checked !== undefined ? r.checked : undefined}
              title={r.kind === "item" && r.reason ? r.reason : undefined}
              onClick={() => activate(i)}
              className={`flex h-[26px] w-full items-center gap-2 rounded-sm pl-1.5 pr-2.5 text-left text-[12.5px] ${r.kind === "item" && r.reason ? "cursor-default text-faint" : sel === i ? "bg-hover text-ink" : r.kind === "item" && r.danger ? "text-danger" : "text-ink-2"}`}
            >
              <span className="grid w-4 shrink-0 place-items-center">{r.kind === "item" && r.checked && <Check size={12} />}</span>
              <span className="truncate">{r.label}</span>
              {r.kind === "item" && r.keybinding && <span className="ml-auto shrink-0 pl-6 font-mono text-[11px] text-faint">{keyLabel(r.keybinding)}</span>}
              {r.kind === "sub" && <ChevronRight size={12} className="ml-auto shrink-0 text-faint" />}
            </button>
            {r.kind === "sub" && sub === i && (
              <div className={`absolute top-[-5px] z-10 ${flip ? "right-full mr-0.5" : "left-full ml-0.5"}`}>
                <MenuList entries={r.items} byId={byId} onDone={onDone} autoFocus={subFocus} label={r.label} onLeft={() => (setSub(null), setSubFocus(false), box.current?.focus())} />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** A menu at a screen position (right-click menus, the gear and accounts menus). Closes on outside click or Escape. */
export function ContextMenu({ at, entries, byId, onClose, label }: { at: { x: number; y: number; anchor?: "above" }; entries: MenuEntry[]; byId: Map<string, Command>; onClose: () => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(4, Math.min(at.x, innerWidth - r.width - 4));
    const top = at.anchor === "above" ? Math.max(4, at.y - r.height) : Math.max(4, Math.min(at.y, innerHeight - r.height - 4));
    setPos({ left, top });
  }, [at.x, at.y, at.anchor]);
  useEffect(() => {
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", onClose);
    return () => (window.removeEventListener("mousedown", off), window.removeEventListener("keydown", esc), window.removeEventListener("blur", onClose));
  }, [onClose]);
  return (
    <div ref={box} className="fixed z-[60]" style={pos} onContextMenu={(e) => e.preventDefault()} data-testid="context-menu">
      <MenuList entries={entries} byId={byId} onDone={onClose} autoFocus label={label} />
    </div>
  );
}

/** The application menu bar (File, Edit, Selection, View, Go, Run, Terminal, Help). Collapses to one button when narrow. */
export function MenuBar({ menus, byId, compact }: { menus: [string, MenuEntry[]][]; byId: Map<string, Command>; compact: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const off = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [open]);
  if (compact)
    return (
      <div ref={root} className="relative">
        <button aria-label="Application menu" aria-haspopup="menu" aria-expanded={open !== null} onClick={() => setOpen(open === null ? 0 : null)} className="grid h-[26px] w-8 place-items-center rounded-sm text-chrome-ink hover:bg-hover hover:text-ink">
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        {open !== null && (
          <div className="absolute left-0 top-full z-50 mt-1">
            <MenuList entries={menus.map(([name, items]) => ({ label: name, items }))} byId={byId} onDone={() => setOpen(null)} autoFocus label="Application menu" />
          </div>
        )}
      </div>
    );
  return (
    <div ref={root} role="menubar" aria-label="Main menu" className="flex items-center">
      {menus.map(([name, items], i) => (
        <div key={name} className="relative">
          <button
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            data-testid={`menu-${name.toLowerCase()}`}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && open !== i && setOpen(i)}
            className={`h-[24px] rounded-sm px-2 text-[12.5px] transition-colors ${open === i ? "bg-hover text-ink" : "text-chrome-ink hover:bg-hover hover:text-ink"}`}
          >
            {name}
          </button>
          {open === i && (
            <div className="absolute left-0 top-full z-50 mt-1">
              <MenuList key={name} entries={items} byId={byId} onDone={() => setOpen(null)} autoFocus label={name} onLeft={() => setOpen((i - 1 + menus.length) % menus.length)} onRight={() => setOpen((i + 1) % menus.length)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
