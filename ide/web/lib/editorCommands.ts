/**
 * VS Code editor commands that CodeMirror doesn't ship. Each is an ordinary CodeMirror command (view => handled),
 * so it goes through the same transaction path as typing and reaches collaborators as a normal shared edit.
 */
import { EditorSelection } from "@codemirror/state";
import type { SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { selectParentSyntax } from "@codemirror/commands";

type Cmd = (v: EditorView) => boolean;

/** Lines touched by the selection, each once, in order. */
function selectedLines(v: EditorView) {
  const seen = new Set<number>();
  const out = [];
  for (const r of v.state.selection.ranges) {
    const a = v.state.doc.lineAt(r.from).number;
    const b = v.state.doc.lineAt(r.to > r.from && v.state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to).number;
    for (let n = a; n <= b; n++) if (!seen.has(n)) (seen.add(n), out.push(v.state.doc.line(n)));
  }
  return out;
}

export const insertLineAbove: Cmd = (v) => {
  const changes = [];
  const sel = [];
  for (const r of v.state.selection.ranges) {
    const line = v.state.doc.lineAt(r.head);
    const indent = /^\s*/.exec(line.text)![0];
    changes.push({ from: line.from, insert: indent + v.state.lineBreak });
    sel.push(line.from + indent.length);
  }
  // Positions are in the old document; each insert before a later line shifts it, which mapPos handles.
  const tr = v.state.update({ changes });
  v.dispatch({ changes, selection: EditorSelection.create(sel.map((p) => EditorSelection.cursor(tr.changes.mapPos(p, -1)))), userEvent: "input", scrollIntoView: true });
  return true;
};

export const joinLines: Cmd = (v) => {
  const changes = [];
  for (const r of v.state.selection.ranges) {
    const first = v.state.doc.lineAt(r.from).number;
    const last = Math.max(first + 1, v.state.doc.lineAt(r.to).number);
    for (let n = first; n < last && n < v.state.doc.lines; n++) {
      const a = v.state.doc.line(n);
      const b = v.state.doc.line(n + 1);
      const trimEnd = a.text.length - a.text.trimEnd().length;
      const lead = /^\s*/.exec(b.text)![0].length;
      changes.push({ from: a.to - trimEnd, to: b.from + lead, insert: b.text.trim() ? " " : "" });
    }
  }
  if (!changes.length) return false;
  v.dispatch({ changes, userEvent: "input" });
  return true;
};

function transformSelection(fn: (s: string) => string): Cmd {
  return (v) => {
    const changes = v.state.selection.ranges.map((r) => {
      // An empty selection transforms the word under the caret, as VS Code does.
      const range = r.empty ? (v.state.wordAt(r.head) ?? r) : r;
      return { from: range.from, to: range.to, insert: fn(v.state.sliceDoc(range.from, range.to)) };
    });
    v.dispatch({ changes, userEvent: "input" });
    return true;
  };
}
export const toUpperCase = transformSelection((s) => s.toUpperCase());
export const toLowerCase = transformSelection((s) => s.toLowerCase());
export const toTitleCase = transformSelection((s) => s.replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()));

function sortLines(dir: 1 | -1): Cmd {
  return (v) => {
    const lines = selectedLines(v);
    // With a single caret VS Code sorts the whole document.
    const target = lines.length > 1 ? lines : Array.from({ length: v.state.doc.lines }, (_, i) => v.state.doc.line(i + 1));
    const sorted = target.map((l) => l.text).sort((a, b) => dir * a.localeCompare(b));
    v.dispatch({ changes: { from: target[0]!.from, to: target.at(-1)!.to, insert: sorted.join(v.state.lineBreak) }, userEvent: "input" });
    return true;
  };
}
export const sortLinesAscending = sortLines(1);
export const sortLinesDescending = sortLines(-1);

export const duplicateSelection: Cmd = (v) => {
  const changes = [];
  const sel = [];
  for (const r of v.state.selection.ranges) {
    if (r.empty) {
      const line = v.state.doc.lineAt(r.head);
      changes.push({ from: line.to, insert: v.state.lineBreak + line.text });
      sel.push({ anchor: r.head, head: r.head });
    } else {
      changes.push({ from: r.to, insert: v.state.sliceDoc(r.from, r.to) });
      sel.push({ anchor: r.from, head: r.to });
    }
  }
  const tr = v.state.update({ changes });
  v.dispatch({ changes, selection: EditorSelection.create(sel.map((s) => EditorSelection.range(tr.changes.mapPos(s.anchor, 1), tr.changes.mapPos(s.head, 1)))), userEvent: "input" });
  return true;
};

/** Expand / shrink selection: expansion steps are remembered so shrink retraces them. */
const expansions = new WeakMap<EditorView, SelectionRange[][]>();
export const expandSelection: Cmd = (v) => {
  const before = v.state.selection.ranges;
  const stack = expansions.get(v) ?? [];
  if (!selectParentSyntax(v)) return false;
  stack.push([...before]);
  expansions.set(v, stack);
  return true;
};
export const shrinkSelection: Cmd = (v) => {
  const prev = expansions.get(v)?.pop();
  if (!prev) return false;
  v.dispatch({ selection: EditorSelection.create(prev), scrollIntoView: true });
  return true;
};

export const cursorsAtLineEnds: Cmd = (v) => {
  const ranges = [];
  for (const r of v.state.selection.ranges) {
    if (r.empty) continue;
    const a = v.state.doc.lineAt(r.from).number;
    const b = v.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) ranges.push(EditorSelection.cursor(n === b ? r.to : v.state.doc.line(n).to));
  }
  if (!ranges.length) return false;
  v.dispatch({ selection: EditorSelection.create(ranges) });
  return true;
};

export function convertIndentation(v: EditorView, to: "spaces" | "tabs", size: number): number {
  const changes = [];
  for (let n = 1; n <= v.state.doc.lines; n++) {
    const line = v.state.doc.line(n);
    const lead = /^[ \t]*/.exec(line.text)![0];
    if (!lead) continue;
    const width = [...lead].reduce((w, c) => (c === "\t" ? w + size - (w % size) : w + 1), 0);
    const next = to === "spaces" ? " ".repeat(width) : "\t".repeat(Math.floor(width / size)) + " ".repeat(width % size);
    if (next !== lead) changes.push({ from: line.from, to: line.from + lead.length, insert: next });
  }
  if (changes.length) v.dispatch({ changes, userEvent: "input" });
  return changes.length;
}

/** The indentation a file actually uses, for the status bar ("Spaces: 2" / "Tab Size: 4"). */
export function detectIndent(text: string): { tabs: boolean; size: number } | null {
  let tabs = 0;
  let spaces = 0;
  const widths = new Map<number, number>();
  let prev = 0;
  for (const l of text.split("\n", 2000)) {
    if (!l.trim()) continue;
    const lead = /^[ \t]*/.exec(l)![0];
    if (lead.startsWith("\t")) tabs++;
    else if (lead.length) {
      spaces++;
      const d = Math.abs(lead.length - prev);
      if (d > 0 && d <= 8) widths.set(d, (widths.get(d) ?? 0) + 1);
    }
    prev = lead.startsWith("\t") ? prev : lead.length;
  }
  if (!tabs && !spaces) return null;
  if (tabs > spaces) return { tabs: true, size: 0 };
  const size = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 2;
  return { tabs: false, size };
}
