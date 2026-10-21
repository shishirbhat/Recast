"use client";

import { useEffect, useRef } from "react";
import { EditorView, GutterMarker, gutter, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightWhitespace, highlightTrailingWhitespace, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { Compartment, EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle, foldKeymap } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { showMinimap } from "@replit/codemirror-minimap";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { indentUnit } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import type { DocSession } from "@/lib/collab";
import { languageById, languageIdFor } from "@/lib/languages";

/** Restrained syntax colours from the theme tokens. */
const relayHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-fn)", fontWeight: "550" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-prop)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--syn-punct)" },
  { tag: t.heading, color: "var(--ink)", fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.link, color: "var(--accent-ink)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** The editor surface, from the same tokens as the rest of the IDE. Defined as a theme so it outranks CodeMirror's defaults. */
const relayTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--ink)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", fontVariantLigatures: "none" },
  ".cm-content": { padding: "4px 0 40vh", caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--editor)", border: "none", color: "var(--faint)", paddingLeft: "10px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 6px", fontSize: "12px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--hover) 60%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--ink)" },
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
  ".relay-author-gutter": { width: "4px", marginRight: "2px" },
  ".relay-author-gutter .cm-gutterElement": { padding: "0" },
  ".relay-author": { display: "block", width: "3px", height: "100%", borderRadius: "1px" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
  ".cm-tooltip-lint": { fontFamily: "var(--font-sans)", fontSize: "12px" },
  ".cm-trailingSpace": { backgroundColor: "color-mix(in oklab, var(--danger) 18%, transparent)" },
  ".cm-highlightSpace": { backgroundImage: "radial-gradient(circle at 50% 55%, var(--faint) 12%, transparent 10%)" },
  ".cm-highlightTab": { backgroundImage: "none", position: "relative" },
  ".cm-highlightTab::before": { content: "'→'", position: "absolute", color: "var(--faint)", left: "1px" },
  ".cm-minimap-gutter": { borderLeft: "1px solid var(--rule)", backgroundColor: "var(--editor)" },
  ".cm-minimap-overlay": { backgroundColor: "var(--hover) !important" },
});

export function languageFor(path: string): Extension {
  return languageById(languageIdFor(path)).mode();
}

export interface EditorPrefs {
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  wrap: boolean;
  uiFont: UiFont;
  codeFont: CodeFont;
  minimap: boolean;
  indentGuides: boolean;
  /** As VS Code's editor.renderWhitespace. */
  whitespace: "none" | "trailing" | "all";
  lineNumbers: boolean;
}
export const UI_FONTS = { figtree: { label: "Figtree", css: '"Figtree Variable"' }, geist: { label: "Geist", css: '"Geist Variable"' }, system: { label: "System", css: "system-ui" } } as const;
export const CODE_FONTS = { plex: { label: "IBM Plex Mono", css: '"IBM Plex Mono"' }, jetbrains: { label: "JetBrains Mono", css: '"JetBrains Mono Variable"' }, fira: { label: "Fira Code", css: '"Fira Code Variable"' }, geist: { label: "Geist Mono", css: '"Geist Mono Variable"' } } as const;
export type UiFont = keyof typeof UI_FONTS;
export type CodeFont = keyof typeof CODE_FONTS;
export const DEFAULT_PREFS: EditorPrefs = { fontSize: 14, lineHeight: 1.65, tabSize: 2, wrap: false, uiFont: "figtree", codeFont: "plex", minimap: true, indentGuides: true, whitespace: "trailing", lineNumbers: true };

/** Apply the chosen typefaces to the whole IDE (UI chrome, editor, diffs, terminal read the same variables). */
export function applyFonts(p: EditorPrefs): void {
  const root = document.documentElement.style;
  root.setProperty("--ui-font", (UI_FONTS[p.uiFont] ?? UI_FONTS.figtree).css);
  root.setProperty("--code-font", (CODE_FONTS[p.codeFont] ?? CODE_FONTS.plex).css);
}

/** One line's author, as the authorship gutter shows it. */
export interface LineMark {
  color: string;
  label: string;
  kind: "member" | "agent" | "shared" | "disk";
}
export interface SyntaxProblem {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
}

class AuthorMarker extends GutterMarker {
  constructor(readonly m: LineMark) {
    super();
  }
  eq(o: AuthorMarker) {
    return o.m.color === this.m.color && o.m.label === this.m.label && o.m.kind === this.m.kind;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "relay-author";
    el.title = this.m.label;
    el.style.background = this.m.kind === "shared" ? `repeating-linear-gradient(180deg, ${this.m.color} 0 3px, transparent 3px 5px)` : this.m.kind === "agent" ? "transparent" : this.m.color;
    if (this.m.kind === "agent") el.style.boxShadow = `inset 0 0 0 1px ${this.m.color}`;
    return el;
  }
}
const setAuthors = StateEffect.define<Map<number, LineMark> | null>();
const authorsField = StateField.define<Map<number, LineMark> | null>({
  create: () => null,
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setAuthors)) return e.value;
    return v;
  },
});
const authorGutter = [
  authorsField,
  gutter({
    class: "relay-author-gutter",
    markers: (view) => {
      const marks = view.state.field(authorsField);
      if (!marks) return RangeSet.empty;
      const out = [];
      for (let n = 1; n <= view.state.doc.lines; n++) {
        const m = marks.get(n);
        if (m) out.push(new AuthorMarker(m).range(view.state.doc.line(n).from));
      }
      return RangeSet.of(out);
    },
  }),
];

function minimapDom() {
  const dom = document.createElement("div");
  dom.className = "relay-minimap";
  return { dom };
}

function prefsExtension(p: EditorPrefs): Extension {
  return [
    EditorView.theme({ "&": { fontSize: `${p.fontSize}px` }, ".cm-scroller": { lineHeight: String(p.lineHeight) } }),
    EditorState.tabSize.of(p.tabSize),
    indentUnit.of(" ".repeat(p.tabSize)),
    p.wrap ? EditorView.lineWrapping : [],
    p.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    p.indentGuides ? indentationMarkers({ thickness: 1, colors: { light: "var(--rule)", dark: "var(--rule)", activeLight: "var(--rule-strong)", activeDark: "var(--rule-strong)" } }) : [],
    p.whitespace === "all" ? highlightWhitespace() : p.whitespace === "trailing" ? highlightTrailingWhitespace() : [],
    p.minimap ? showMinimap.compute(["doc"], () => ({ create: minimapDom, displayText: "blocks", showOverlay: "mouse-over" })) : [],
  ];
}

export function Editor({ session, readOnly, onCursor, reveal, viewHandle, prefs = DEFAULT_PREFS, authors = null, problems = null, language }: { session: DocSession; readOnly: boolean; onCursor?: (line: number, col: number) => void; reveal?: { line: number; nonce: number } | null; viewHandle?: { current: EditorView | null }; prefs?: EditorPrefs; authors?: Map<number, LineMark> | null; problems?: SyntaxProblem[] | null; /** Language mode id; defaults to the file extension's. */ language?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const prefsC = useRef(new Compartment());
  const authorC = useRef(new Compartment());
  const langC = useRef(new Compartment());
  const initialPrefs = useRef(prefs);
  const langId = language ?? languageIdFor(session.path);
  const initialLang = useRef(langId);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: langC.current.reconfigure(languageById(langId).mode()) });
  }, [langId]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: prefsC.current.reconfigure(prefsExtension(prefs)) });
  }, [prefs]);
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: [authorC.current.reconfigure(authors ? authorGutter : []), ...(authors ? [setAuthors.of(authors)] : [])] });
  }, [authors]);
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const doc = v.state.doc;
    const pos = (line: number, col: number) => {
      const l = doc.line(Math.min(Math.max(1, line), doc.lines));
      return Math.min(l.from + Math.max(0, col - 1), l.to);
    };
    const diags: Diagnostic[] = (problems ?? []).map((p) => {
      const from = pos(p.line, p.col);
      return { from, to: Math.max(from, pos(p.endLine, p.endCol)), severity: "error", message: p.message, source: "syntax" };
    });
    v.dispatch(setDiagnostics(v.state, diags));
  }, [problems]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: session.text.toString(),
        extensions: [
          authorC.current.of([]),
          lintGutter(),
          prefsC.current.of(prefsExtension(initialPrefs.current)),
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
          langC.current.of(languageById(initialLang.current).mode()),
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
    viewRef.current = view;
    if (viewHandle) viewHandle.current = view;
    return () => {
      viewRef.current = null;
      if (viewHandle && viewHandle.current === view) viewHandle.current = null;
      view.destroy();
    };
  }, [session, readOnly, onCursor, viewHandle]);

  // Jump to a line (from search results, problems, quick open) once the document has synced. Declared after the
  // effect that creates the view, so a file opened at a line has its view by the time this runs.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const go = () => {
      const n = Math.min(Math.max(1, reveal.line), view.state.doc.lines);
      const line = view.state.doc.line(n);
      view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
      view.focus();
    };
    if (session.status === "synced") go();
    else return session.subscribe(() => session.status === "synced" && go());
  }, [reveal, session]);

  return <div ref={host} className="h-full min-h-0" data-testid="editor" />;
}
