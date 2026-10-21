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
  /**
   * The focused editor already binds this chord (CodeMirror's keymap). The registry shows the binding in menus and the
   * palette but leaves the key to the editor, so the command never runs twice.
   */
  native?: boolean;
  /** The shortcut applies only while the editor has focus (VS Code's `editorTextFocus`). Implied by `native`. */
  editorKey?: boolean;
  /** For toggles: menus show a check mark when this returns true. */
  checked?: () => boolean;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function keyLabel(k: string): string {
  return k
    .split("+")
    .map((p) => (p === "Mod" ? (isMac ? "⌘" : "Ctrl") : p === "Shift" ? (isMac ? "⇧" : "Shift") : p === "Alt" ? (isMac ? "⌥" : "Alt") : p === "Ctrl" ? (isMac ? "⌃" : "Ctrl") : p.length === 1 ? p.toUpperCase() : p))
    .join(isMac ? "" : "+");
}

const CODE_KEYS: Record<string, string> = { Backquote: "`", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Slash: "/", Equal: "=", Minus: "-", Comma: ",", Period: ".", Semicolon: ";", Quote: "'" };

/** Normalised chord for a keyboard event, in the same notation as `keybinding`. */
export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  const modKey = isMac ? e.metaKey : e.ctrlKey;
  if (modKey) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // The physical key, not the produced character: Shift+[ is "{" and Alt+F is "ƒ" on macOS, but the chord is the key.
  const code = e.code ?? "";
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : (CODE_KEYS[code] ?? (e.key === "Dead" ? code : e.key));
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

/** Bindings are written with Mod; on macOS "Ctrl+`" stays Ctrl (as in VS Code). */
export function matches(binding: string, chord: string): boolean {
  // On non-mac platforms Mod and Ctrl are the same key.
  const b = isMac ? binding : binding.replace("Ctrl+", "Mod+");
  return canonical(b) === canonical(chord);
}

/** Modifiers in one order, so "Shift+Alt+F" and "Alt+Shift+F" are the same chord. */
function canonical(chord: string): string {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const order = ["Mod", "Ctrl", "Alt", "Shift"];
  return [...parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)), key.length === 1 ? key.toUpperCase() : key].join("+");
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
