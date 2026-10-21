import type { EditorView } from "@codemirror/view";
import { diff } from "@codemirror/merge";
import { languageById } from "./languages";

/** Why a language can't be formatted, or null when it can. */
export function formatUnavailable(languageId: string): string | null {
  const l = languageById(languageId);
  return l.prettier ? null : `No formatter for ${l.label} (Prettier doesn't support it)`;
}

/**
 * Prettier, loaded on first use and run in the browser. Only the plugins the parser needs are fetched.
 * With `range`, only the code around that range is reformatted (Prettier's range formatting).
 */
export async function formatText(text: string, languageId: string, tabSize: number, range?: { from: number; to: number }): Promise<string> {
  const parser = languageById(languageId).prettier;
  if (!parser) throw new Error(formatUnavailable(languageId)!);
  const prettier = await import("prettier/standalone");
  const load = {
    babel: () => [import("prettier/plugins/babel"), import("prettier/plugins/estree")],
    typescript: () => [import("prettier/plugins/typescript"), import("prettier/plugins/estree")],
    json: () => [import("prettier/plugins/babel"), import("prettier/plugins/estree")],
    markdown: () => [import("prettier/plugins/markdown")],
    css: () => [import("prettier/plugins/postcss")],
    html: () => [import("prettier/plugins/html"), import("prettier/plugins/postcss"), import("prettier/plugins/babel"), import("prettier/plugins/estree")],
  }[parser]!;
  const plugins = await Promise.all(load());
  return prettier.format(text, { parser, plugins: plugins as never[], tabWidth: tabSize, printWidth: 120, ...(range ? { rangeStart: range.from, rangeEnd: range.to } : {}) });
}

/**
 * Replace the document with `next` as the smallest set of edits. In a shared document this matters: text that
 * didn't change keeps its CRDT identity, so collaborators' carets stay put and line authorship isn't rewritten.
 * Returns the number of edits applied.
 */
export function applyMinimalEdits(view: EditorView, next: string): number {
  const changes = diff(view.state.doc.toString(), next).map((c) => ({ from: c.fromA, to: c.toA, insert: next.slice(c.fromB, c.toB) }));
  if (changes.length) view.dispatch({ changes, userEvent: "format" });
  return changes.length;
}
