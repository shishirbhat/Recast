"use client";

import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle, foldKeymap } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { DocSession } from "@/lib/collab";

/** Restrained syntax colours from the theme tokens. Comments are set in italic serif: Relay's quiet signature. */
const relayHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-fn)", fontWeight: "550" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-prop)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: "1.12em" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--syn-punct)" },
  { tag: t.heading, color: "var(--ink)", fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.link, color: "var(--accent-ink)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** The editor surface, from the same tokens as the rest of the IDE. Defined as a theme so it outranks CodeMirror's defaults. */
const relayTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--ink)", fontSize: "13.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.7", fontVariantLigatures: "contextual" },
  ".cm-content": { padding: "18px 0 40vh", caretColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--faint)", paddingLeft: "10px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 6px", fontSize: "12px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent-soft) 45%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent-line)", borderRadius: "3px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--sunken)", border: "1px solid var(--rule)", color: "var(--muted)", borderRadius: "6px", padding: "0 6px" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--rule)", borderRadius: "10px", boxShadow: "var(--shadow-pop)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--ink)" },
  ".cm-panels": { backgroundColor: "var(--panel-2)", color: "var(--ink)", borderColor: "var(--rule)" },
  ".cm-searchMatch": { backgroundColor: "var(--attention-soft)", outline: "1px solid color-mix(in oklab, var(--attention) 50%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--accent-soft) 70%, transparent)" },
  // Collaborators: a thin coloured caret with a name flag that is always visible, not only on hover.
  ".cm-ySelectionCaret": { position: "relative", borderLeft: "2px solid", marginLeft: "-1px", marginRight: "-1px", boxSizing: "border-box", display: "inline" },
  ".cm-ySelectionCaretDot": { display: "none" },
  ".cm-ySelectionInfo": {
    position: "absolute", top: "-1.5em", left: "-2px", fontFamily: "var(--font-sans)", fontSize: "11px", fontWeight: "600", lineHeight: "1",
    padding: "3px 7px 4px", borderRadius: "7px 7px 7px 2px", color: "#fff", backgroundColor: "inherit", whiteSpace: "nowrap",
    userSelect: "none", pointerEvents: "none", opacity: "1", zIndex: "5",
  },
  ".cm-ySelection": { borderRadius: "2px" },
});

export function languageFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return javascript({ jsx: true });
  if (["ts", "mts", "cts", "tsx"].includes(ext)) return javascript({ jsx: ext === "tsx", typescript: true });
  if (ext === "json") return json();
  if (["md", "mdx", "markdown"].includes(ext)) return markdown();
  if (ext === "css") return css();
  if (["html", "htm"].includes(ext)) return html();
  if (ext === "py") return python();
  return [];
}

export function Editor({ session, readOnly, onCursor }: { session: DocSession; readOnly: boolean; onCursor?: (line: number, col: number) => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: session.text.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter({ markerDOM: (open) => Object.assign(document.createElement("span"), { textContent: open ? "⌄" : "›", className: "text-faint" }) }),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          relayTheme,
          syntaxHighlighting(relayHighlight),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          history(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...yUndoManagerKeymap, indentWithTab]),
          languageFor(session.path),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          // Collaboration: CRDT sync, remote carets and selections (positions are CRDT-relative, so they move with edits).
          yCollab(session.text, session.provider.awareness, { undoManager: session.undoManager }),
          EditorView.updateListener.of((u) => {
            if (!onCursor || !u.selectionSet) return;
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            onCursor(line.number, head - line.from + 1);
          }),
          EditorView.contentAttributes.of({ "aria-label": `Editor for ${session.path}` }),
        ],
      }),
    });
    return () => view.destroy();
  }, [session, readOnly, onCursor]);

  return <div ref={host} className="h-full min-h-0" data-testid="editor" />;
}
