import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  selectParentSyntax,
  simplifySelection,
  toggleBlockComment,
  toggleComment,
  toggleTabFocusMode,
  transposeChars,
} from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { openSearchPanel, selectSelectionMatches } from "@codemirror/search";
import { diff } from "@codemirror/merge";
import type { Command } from "./commands";

/**
 * The editor's own commands, named and bound as in VS Code. Every one is a real CodeMirror command or a text
 * transform applied as a minimal edit, so collaborators' carets and line authorship survive.
 * `native` marks chords the focused editor already handles itself (the workbench leaves those to it).
 */

export type EditorCommand = Command & { native?: boolean };

/** Replace the document with `next` using the smallest edits, not one wholesale replacement. */
export function applyMinimal(view: EditorView, next: string): boolean {
  const cur = view.state.doc.toString();
  if (cur === next) return false;
  const changes: ChangeSpec[] = diff(cur, next).map((c) => ({ from: c.fromA, to: c.toA, insert: next.slice(c.fromB, c.toB) }));
  view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

/** The line range a command acts on: the selected lines, or every line when nothing is selected. */
function lineSpan(view: EditorView): { from: number; to: number } {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) return { from: 0, to: state.doc.length };
  return { from: state.doc.lineAt(sel.from).from, to: state.doc.lineAt(sel.to).to };
}

function replaceLines(view: EditorView, fn: (lines: string[]) => string[]): boolean {
  const { from, to } = lineSpan(view);
  const text = view.state.sliceDoc(from, to);
  const next = fn(text.split("\n")).join("\n");
  if (next === text) return false;
  const changes = diff(text, next).map((c) => ({ from: from + c.fromA, to: from + c.toA, insert: next.slice(c.fromB, c.toB) }));
  view.dispatch({ changes, userEvent: "input" });
  return true;
}

/** Transform each selection (or the word under each caret). */
function transformWords(view: EditorView, fn: (s: string) => string): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  for (const r of state.selection.ranges) {
    const range = r.empty ? state.wordAt(r.head) : r;
    if (!range) continue;
    const text = state.sliceDoc(range.from, range.to);
    if (fn(text) !== text) changes.push({ from: range.from, to: range.to, insert: fn(text) });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input" });
  return true;
}

export const titleCase = (s: string) => s.replace(/\b([a-z])([a-z]*)/gi, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());

const FORMATTERS: Record<string, { parser: string; plugins: () => Promise<unknown[]> }> = {
  babel: { parser: "babel", plugins: () => Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]) },
  typescript: { parser: "typescript", plugins: () => Promise.all([import("prettier/plugins/typescript"), import("prettier/plugins/estree")]) },
  json: { parser: "json", plugins: () => Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]) },
  css: { parser: "css", plugins: () => Promise.all([import("prettier/plugins/postcss")]) },
  markdown: { parser: "markdown", plugins: () => Promise.all([import("prettier/plugins/markdown")]) },
  html: { parser: "html", plugins: () => Promise.all([import("prettier/plugins/html"), import("prettier/plugins/postcss"), import("prettier/plugins/babel"), import("prettier/plugins/estree")]) },
  yaml: { parser: "yaml", plugins: () => Promise.all([import("prettier/plugins/yaml")]) },
};
const FORMATTER_FOR: Record<string, keyof typeof FORMATTERS> = {
  javascript: "babel",
  javascriptreact: "babel",
  typescript: "typescript",
  typescriptreact: "typescript",
  json: "json",
  css: "css",
  markdown: "markdown",
  html: "html",
};
export const canFormat = (languageId: string) => languageId in FORMATTER_FOR;

/** Format with Prettier, running in the browser. Throws Prettier's own message on a syntax error. */
export async function formatText(text: string, languageId: string, tabWidth: number): Promise<string> {
  const f = FORMATTERS[FORMATTER_FOR[languageId]!];
  if (!f) throw new Error(`No formatter for ${languageId}`);
  const [prettier, plugins] = await Promise.all([import("prettier/standalone"), f.plugins()]);
  return prettier.format(text, { parser: f.parser, plugins: plugins as never[], tabWidth, printWidth: 100 });
}

export function editorCommands(ctx: {
  /** Run on the active editor (focusing it first); null when no editor is open. */
  on: (fn: (v: EditorView) => unknown) => () => void;
  need: () => string | null;
  readOnly: () => string | null;
  language: () => string;
  tabSize: () => number;
  notify: (m: string, tone?: "ok" | "danger") => void;
}): EditorCommand[] {
  const edit = () => ctx.need() ?? ctx.readOnly();
  const c = (id: string, category: string, title: string, run: (v: EditorView) => unknown, extra: Partial<EditorCommand> = {}): EditorCommand => ({ id, category, title, when: edit, run: ctx.on(run), ...extra });
  const nav = (id: string, category: string, title: string, run: (v: EditorView) => unknown, extra: Partial<EditorCommand> = {}): EditorCommand => ({ id, category, title, when: ctx.need, run: ctx.on(run), ...extra });
  return [
    // Edit
    c("editor.action.commentLine", "Edit", "Toggle Line Comment", toggleComment, { keybinding: "Mod+/", native: true }),
    c("editor.action.blockComment", "Edit", "Toggle Block Comment", toggleBlockComment, { keybinding: "Shift+Alt+A", native: true }),
    c("editor.action.moveLinesUpAction", "Selection", "Move Line Up", moveLineUp, { keybinding: "Alt+ArrowUp", native: true }),
    c("editor.action.moveLinesDownAction", "Selection", "Move Line Down", moveLineDown, { keybinding: "Alt+ArrowDown", native: true }),
    c("editor.action.copyLinesUpAction", "Selection", "Copy Line Up", copyLineUp, { keybinding: "Shift+Alt+ArrowUp", native: true }),
    c("editor.action.copyLinesDownAction", "Selection", "Copy Line Down", copyLineDown, { keybinding: "Shift+Alt+ArrowDown", native: true }),
    c("editor.action.duplicateSelection", "Selection", "Duplicate Selection", (v) => {
      const { state } = v;
      v.dispatch(state.changeByRange((r) => (r.empty ? { range: r, changes: [] } : { range: EditorSelection.range(r.to, r.to + (r.to - r.from)), changes: { from: r.to, insert: state.sliceDoc(r.from, r.to) } })));
    }),
    c("editor.action.deleteLines", "Edit", "Delete Line", deleteLine, { keybinding: "Mod+Shift+K", native: true }),
    c("editor.action.insertLineAfter", "Edit", "Insert Line Below", insertBlankLine, { keybinding: "Mod+Enter", native: true }),
    c("editor.action.indentLines", "Edit", "Indent Line", indentMore, { keybinding: "Mod+]", native: true }),
    c("editor.action.outdentLines", "Edit", "Outdent Line", indentLess, { keybinding: "Mod+[", native: true }),
    c("editor.action.reindentlines", "Edit", "Reindent Lines", (v) => (v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }), indentSelection(v))),
    c("editor.action.transposeLetters", "Edit", "Transpose Characters", transposeChars),
    c("editor.action.transformToUppercase", "Edit", "Transform to Uppercase", (v) => transformWords(v, (s) => s.toUpperCase())),
    c("editor.action.transformToLowercase", "Edit", "Transform to Lowercase", (v) => transformWords(v, (s) => s.toLowerCase())),
    c("editor.action.transformToTitlecase", "Edit", "Transform to Title Case", (v) => transformWords(v, titleCase)),
    c("editor.action.sortLinesAscending", "Edit", "Sort Lines Ascending", (v) => replaceLines(v, (l) => [...l].sort((a, b) => a.localeCompare(b)))),
    c("editor.action.sortLinesDescending", "Edit", "Sort Lines Descending", (v) => replaceLines(v, (l) => [...l].sort((a, b) => b.localeCompare(a)))),
    c("editor.action.removeDuplicateLines", "Edit", "Delete Duplicate Lines", (v) => replaceLines(v, (l) => l.filter((x, i) => l.indexOf(x) === i))),
    c("editor.action.joinLines", "Edit", "Join Lines", (v) => {
      const { state } = v;
      const sel = state.selection.main;
      const first = state.doc.lineAt(sel.from);
      const last = sel.empty ? state.doc.line(Math.min(first.number + 1, state.doc.lines)) : state.doc.lineAt(sel.to);
      if (last.number === first.number) return;
      replaceLinesIn(v, first.from, last.to, (t) => t.split("\n").map((l, i) => (i ? l.trim() : l.trimEnd())).filter((l, i) => i === 0 || l).join(" "));
    }),
    c("editor.action.trimTrailingWhitespace", "Edit", "Trim Trailing Whitespace", (v) => replaceLinesIn(v, 0, v.state.doc.length, (t) => t.replace(/[ \t]+$/gm, ""))),
    c("editor.action.indentationToSpaces", "Edit", "Convert Indentation to Spaces", (v) => replaceLinesIn(v, 0, v.state.doc.length, (t) => t.replace(/^\t+/gm, (m) => " ".repeat(m.length * ctx.tabSize())))),
    c("editor.action.indentationToTabs", "Edit", "Convert Indentation to Tabs", (v) => replaceLinesIn(v, 0, v.state.doc.length, (t) => t.replace(/^( +)/gm, (m) => "\t".repeat(Math.floor(m.length / ctx.tabSize())) + " ".repeat(m.length % ctx.tabSize())))),
    c("workbench.action.editor.changeEOL.lf", "Edit", "Change End of Line Sequence to LF", (v) => replaceLinesIn(v, 0, v.state.doc.length, (t) => t.replace(/\r\n/g, "\n"))),
    c("workbench.action.editor.changeEOL.crlf", "Edit", "Change End of Line Sequence to CRLF", (v) => replaceLinesIn(v, 0, v.state.doc.length, (t) => t.replace(/\r?\n/g, "\r\n"))),
    {
      id: "editor.action.formatDocument",
      category: "Edit",
      title: "Format Document",
      keybinding: "Shift+Alt+F",
      keywords: ["prettier", "beautify"],
      when: () => edit() ?? (canFormat(ctx.language()) ? null : "No formatter for this language. Prettier formats JavaScript, TypeScript, JSON, CSS, Markdown and HTML."),
      run: ctx.on(async (v) => {
        try {
          const out = await formatText(v.state.doc.toString(), ctx.language(), ctx.tabSize());
          ctx.notify(applyMinimal(v, out) ? "Formatted with Prettier." : "Already formatted.");
        } catch (e) {
          ctx.notify(`Prettier couldn't format this file: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`, "danger");
        }
      }),
    },
    {
      id: "editor.action.formatSelection",
      category: "Edit",
      title: "Format Selection",
      when: () => edit() ?? (canFormat(ctx.language()) ? null : "No formatter for this language"),
      run: ctx.on(async (v) => {
        const r = v.state.selection.main;
        if (r.empty) return ctx.notify("Select the code to format first.", "danger");
        const from = v.state.doc.lineAt(r.from).from;
        const to = v.state.doc.lineAt(r.to).to;
        try {
          const out = (await formatText(v.state.sliceDoc(from, to), ctx.language(), ctx.tabSize())).replace(/\n$/, "");
          replaceLinesIn(v, from, to, () => out);
        } catch (e) {
          ctx.notify(`Prettier couldn't format the selection: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`, "danger");
        }
      }),
    },
    // Selection
    nav("editor.action.insertCursorAbove", "Selection", "Add Cursor Above", addCursorAbove, { keybinding: "Mod+Alt+ArrowUp", native: true }),
    nav("editor.action.insertCursorBelow", "Selection", "Add Cursor Below", addCursorBelow, { keybinding: "Mod+Alt+ArrowDown", native: true }),
    nav("editor.action.selectHighlights", "Selection", "Select All Occurrences of Find Match", selectSelectionMatches, { keybinding: "Mod+Shift+L", native: true }),
    nav("editor.action.changeAll", "Selection", "Change All Occurrences", (v) => {
      if (v.state.selection.main.empty) {
        const w = v.state.wordAt(v.state.selection.main.head);
        if (w) v.dispatch({ selection: { anchor: w.from, head: w.to } });
      }
      selectSelectionMatches(v);
    }, { keybinding: "Mod+F2" }),
    nav("editor.action.smartSelect.shrink", "Selection", "Shrink Selection", simplifySelection),
    nav("editor.action.smartSelect.expand2", "Selection", "Expand Selection to Bracket", selectParentSyntax),
    // Go
    nav("editor.action.jumpToBracket", "Go", "Go to Bracket", cursorMatchingBracket, { keybinding: "Mod+Shift+\\", native: true }),
    // Folding
    nav("editor.fold", "View", "Fold", foldCode, { keybinding: "Mod+Shift+[", native: true }),
    nav("editor.unfold", "View", "Unfold", unfoldCode, { keybinding: "Mod+Shift+]", native: true }),
    nav("editor.foldAll", "View", "Fold All", foldAll),
    nav("editor.unfoldAll", "View", "Unfold All", unfoldAll),
    // Find
    nav("editor.action.startFindReplaceAction", "Edit", "Replace", (v) => openSearchPanel(v), { keybinding: "Mod+H" }),
    nav("editor.action.toggleTabFocusMode", "View", "Toggle Tab Key Moves Focus", toggleTabFocusMode, { keybinding: "Mod+M" }),
  ];
}

function replaceLinesIn(view: EditorView, from: number, to: number, fn: (text: string) => string): boolean {
  const text = view.state.sliceDoc(from, to);
  const next = fn(text);
  if (next === text) return false;
  view.dispatch({ changes: diff(text, next).map((c) => ({ from: from + c.fromA, to: from + c.toA, insert: next.slice(c.fromB, c.toB) })), userEvent: "input" });
  return true;
}
