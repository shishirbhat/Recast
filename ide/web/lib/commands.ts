/**
 * The command registry. Menus, the command palette and keyboard shortcuts all read from this one list,
 * so a command behaves the same however it is invoked, and an unavailable command says why everywhere.
 */

export interface Command {
  /** Stable identifier, e.g. "workbench.toggleTerminal". */
  id: string;
  title: string;
  category: string;
  /** Extra words the palette matches on. */
  keywords?: string[];
  /** "Mod" is Cmd on macOS and Ctrl elsewhere, e.g. "Mod+Shift+P", "Ctrl+`". */
  keybinding?: string;
  /** null when available; otherwise the reason it can't run right now. */
  when?: () => string | null;
  run: () => void;
  /** Shown in the palette (default true). Contextual commands like "Open Task X" set false for menus only. */
  palette?: boolean;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function keyLabel(k: string): string {
  return k
    .split("+")
    .map((p) => (p === "Mod" ? (isMac ? "⌘" : "Ctrl") : p === "Shift" ? (isMac ? "⇧" : "Shift") : p === "Alt" ? (isMac ? "⌥" : "Alt") : p === "Ctrl" ? (isMac ? "⌃" : "Ctrl") : p.length === 1 ? p.toUpperCase() : p))
    .join(isMac ? "" : "+");
}

/** Normalised chord for a keyboard event, in the same notation as `keybinding`. */
export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  const modKey = isMac ? e.metaKey : e.ctrlKey;
  if (modKey) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key === "Dead" ? e.code : e.key;
  parts.push(key === "`" || e.code === "Backquote" ? "`" : key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

/** Bindings are written with Mod; on macOS "Ctrl+`" stays Ctrl (as in VS Code). */
export function matches(binding: string, chord: string): boolean {
  if (binding === chord) return true;
  // On non-mac platforms Mod and Ctrl are the same key.
  if (!isMac) return binding.replace("Ctrl+", "Mod+") === chord;
  return false;
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
      score += 1 + streak * 2 + (i === 0 || "/._- :".includes(b[i - 1]!) ? 6 : 0);
      j++;
    } else streak = 0;
  }
  return j === a.length ? score - b.length * 0.05 : null;
}

export function availability(c: Command): string | null {
  try {
    return c.when ? c.when() : null;
  } catch {
    return "Unavailable";
  }
}

/** Run a command if it is available; returns the reason when it isn't. */
export function execute(c: Command): string | null {
  const reason = availability(c);
  if (!reason) c.run();
  return reason;
}
