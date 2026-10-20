"use client";

import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { Columns2, FileCode2, MessageSquare, Rows2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { languageFor } from "../Editor";

/** What a diff tab shows. Encoded in the tab id so tabs survive like any other editor. */
export type DiffSpec = { kind: "working" | "staged"; path: string } | { kind: "task"; task: string; path: string } | { kind: "conflict"; id: string; path: string };

export const diffTabId = (d: DiffSpec) => (d.kind === "task" ? `diff:task:${d.task}:${d.path}` : d.kind === "conflict" ? `diff:conflict:${d.id}:${d.path}` : `diff:${d.kind}:${d.path}`);
export function parseDiffTab(id: string): DiffSpec | null {
  if (!id.startsWith("diff:")) return null;
  const [, kind, ...rest] = id.split(":");
  if (kind === "task") return { kind: "task", task: rest[0]!, path: rest.slice(1).join(":") };
  if (kind === "conflict") return { kind: "conflict", id: rest[0]!, path: rest.slice(1).join(":") };
  if (kind === "working" || kind === "staged") return { kind, path: rest.join(":") };
  return null;
}
export const diffTabLabel = (d: DiffSpec) => `${d.path.split("/").pop()} (${d.kind === "task" ? d.task : d.kind === "conflict" ? "Conflict" : d.kind === "staged" ? "Staged" : "Working Tree"})`;

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
]);
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--ink)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "var(--editor)", border: "none", color: "var(--faint)" },
  ".cm-changedLine": { backgroundColor: "color-mix(in oklab, var(--ok-soft) 70%, transparent) !important" },
  ".cm-deletedChunk, .cm-deletedLine": { backgroundColor: "color-mix(in oklab, var(--danger-soft) 80%, transparent) !important" },
  ".cm-changedText": { background: "color-mix(in oklab, var(--ok) 28%, transparent) !important" },
  ".cm-deletedText, .cm-deletedChunk del": { background: "color-mix(in oklab, var(--danger) 28%, transparent) !important", textDecoration: "none" },
  ".cm-mergeSpacer": { backgroundColor: "var(--sunken)" },
  ".cm-merge-revert": { display: "none" },
});

interface Comment {
  id: string;
  line: number;
  body: string;
  author: string;
  revision: string;
  createdAt: string;
  resolved: boolean;
  outdated: boolean;
}

/** A read-only diff of one file, side by side or inline, with revision-pinned review comments for task diffs. */
export function DiffView({ spec, canEdit, onOpenFile, onStage, onResolved, notify }: { spec: DiffSpec; canEdit: boolean; onOpenFile: (p: string, line?: number) => void; onStage?: (p: string) => void; onResolved?: () => void; notify: (m: string, t?: "ok" | "danger") => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"split" | "inline">(() => {
    try {
      return (localStorage.getItem("relay.diff.mode") as "split" | "inline") ?? "split";
    } catch {
      return "split";
    }
  });
  const [sides, setSides] = useState<{ before: string; after: string; beforeLabel: string; afterLabel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState({ line: "", body: "" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setSides(null);
    setError(null);
    if (spec.kind === "conflict") {
      void api<{ theirs: string; current: string; resolvedAt: string | null }>("GET", `/conflicts/${encodeURIComponent(spec.id)}`).then(
        (r) => (setSides({ before: r.theirs, after: r.current, beforeLabel: "Outside edit (from disk)", afterLabel: "Shared copy (now)" }), setResolved(!!r.resolvedAt)),
        (e) => setError(e instanceof ApiError ? e.message : String(e)),
      );
      return;
    }
    const url = spec.kind === "task" ? `/tasks/${encodeURIComponent(spec.task)}/diff?path=${encodeURIComponent(spec.path)}` : `/git/diff?path=${encodeURIComponent(spec.path)}${spec.kind === "staged" ? "&staged=1" : ""}`;
    void api<{ before: string; after: string; beforeLabel?: string; afterLabel?: string }>("GET", url).then(
      (r) => setSides({ before: r.before, after: r.after, beforeLabel: r.beforeLabel ?? (spec.kind === "staged" ? "HEAD" : "Index"), afterLabel: r.afterLabel ?? (spec.kind === "staged" ? "Index (staged)" : "Working tree") }),
      (e) => setError(e instanceof ApiError ? e.message : String(e)),
    );
    if (spec.kind === "task") void api<{ comments: Comment[] }>("GET", `/reviews?task=${encodeURIComponent(spec.task)}&path=${encodeURIComponent(spec.path)}`).then((r) => setComments(r.comments), () => {});
  }, [spec.kind, spec.path, spec.kind === "task" ? spec.task : spec.kind === "conflict" ? spec.id : "", nonce]);
  const [resolved, setResolved] = useState(false);
  const resolve = (take: "shared" | "outside") =>
    spec.kind === "conflict" &&
    void api("POST", `/conflicts/${encodeURIComponent(spec.id)}/resolve`, { take }).then(
      () => (notify(take === "shared" ? `Kept the shared copy of ${spec.path}. The outside version stays recorded.` : `Replaced the shared copy of ${spec.path} with the outside version. The previous text stays in its history.`), onResolved?.()),
      (e) => notify(e instanceof ApiError ? e.message : String(e), "danger"),
    );

  useEffect(() => {
    if (!host.current || !sides) return;
    try {
      localStorage.setItem("relay.diff.mode", mode);
    } catch {}
    const ext = [lineNumbers(), theme, syntaxHighlighting(highlight), languageFor(spec.path), EditorState.readOnly.of(true), EditorView.editable.of(false)];
    if (mode === "split") {
      const mv = new MergeView({ a: { doc: sides.before, extensions: ext }, b: { doc: sides.after, extensions: ext }, parent: host.current, highlightChanges: true, gutter: true });
      return () => mv.destroy();
    }
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: sides.after, extensions: [...ext, unifiedMergeView({ original: sides.before, mergeControls: false })] }) });
    return () => v.destroy();
  }, [sides, mode, spec.path]);

  const added = sides ? sides.after.split("\n").length - sides.before.split("\n").length : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-view">
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-rule px-3 text-[12px]">
        <span className="font-mono text-[11px] text-muted">
          {sides?.beforeLabel ?? "…"} <span className="text-faint">→</span> {sides?.afterLabel ?? "…"}
        </span>
        {sides && sides.before === sides.after && <span className="micro text-faint">no differences</span>}
        {sides && sides.before !== sides.after && <span className="tnum font-mono text-[10.5px] text-faint">{added >= 0 ? `+${added}` : added} lines net</span>}
        <span className="ml-auto flex items-center gap-1">
          {spec.kind === "working" && onStage && canEdit && (
            <button onClick={() => onStage(spec.path)} className="h-[22px] rounded-sm border border-rule px-2 text-[11.5px] text-ink-2 hover:bg-hover">
              Stage file
            </button>
          )}
          <button onClick={() => onOpenFile(spec.path)} title="Open the file" className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink" aria-label="Open file">
            <FileCode2 size={13} />
          </button>
          <span className="flex overflow-hidden rounded-sm border border-rule" role="radiogroup" aria-label="Diff layout">
            <button role="radio" aria-checked={mode === "split"} onClick={() => setMode("split")} title="Side by side" className={`grid size-6 place-items-center ${mode === "split" ? "bg-hover text-ink" : "text-muted"}`}>
              <Columns2 size={12} />
            </button>
            <button role="radio" aria-checked={mode === "inline"} onClick={() => setMode("inline")} title="Inline" className={`grid size-6 place-items-center ${mode === "inline" ? "bg-hover text-ink" : "text-muted"}`}>
              <Rows2 size={12} />
            </button>
          </span>
        </span>
      </div>
      {spec.kind === "conflict" && sides && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-warn-soft/40 px-4 py-2.5 text-[13px]" data-testid="conflict-bar">
          <p className="min-w-0 flex-1 text-ink-2">
            {resolved
              ? "This conflict is resolved. Both versions stay recorded."
              : "Someone changed this file on disk while it was being edited here, and the changes overlap. Nothing was overwritten: compare the two and choose which to keep. You can also edit the shared copy by hand first."}
          </p>
          {!resolved && canEdit && (
            <span className="flex gap-2">
              <button onClick={() => resolve("shared")} className="h-[26px] rounded-sm border border-rule-strong px-2.5 text-[12.5px] text-ink hover:bg-hover">
                Keep shared copy
              </button>
              <button onClick={() => resolve("outside")} className="h-[26px] rounded-sm border border-rule-strong px-2.5 text-[12.5px] text-ink hover:bg-hover">
                Use outside version
              </button>
            </span>
          )}
        </div>
      )}
      {error && <p className="px-4 py-3 text-[12.5px] text-danger">{error}</p>}
      {!sides && !error && <div className="m-4 h-24 animate-pulse rounded-sm bg-sunken/50" />}
      <div ref={host} className="min-h-0 flex-1 overflow-auto [&_.cm-mergeView]:h-full [&_.cm-mergeViewEditors]:min-h-full" />
      {spec.kind === "task" && (
        <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-rule bg-sidebar" data-testid="review-comments">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <MessageSquare size={12} className="text-muted" />
            <span className="micro text-muted">Review comments</span>
            <span className="tnum font-mono text-[10.5px] text-faint">{comments.length}</span>
          </div>
          {comments.map((c) => (
            <div key={c.id} className={`border-t border-rule px-3 py-1.5 text-[12.5px] ${c.resolved ? "opacity-55" : ""}`}>
              <div className="flex items-baseline gap-2">
                <button onClick={() => onOpenFile(spec.path, c.line)} className="font-mono text-[11px] text-accent-ink hover:underline">
                  L{c.line}
                </button>
                <span className="text-ink-2">{c.author}</span>
                <span className="font-mono text-[10px] text-faint">@{c.revision.slice(0, 7)}</span>
                {c.outdated && <span className="micro text-warn" title="The file changed after this comment was made">outdated</span>}
                {c.resolved && <span className="micro text-ok">resolved</span>}
                {!c.resolved && canEdit && (
                  <button onClick={() => void api("POST", `/reviews/${c.id}/resolve`).then(() => setNonce((n) => n + 1))} className="ml-auto text-[11px] text-muted hover:text-ink">
                    Resolve
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-ink">{c.body}</p>
            </div>
          ))}
          {canEdit && (
            <form
              className="flex gap-1.5 border-t border-rule px-3 py-2"
              onSubmit={(e) => {
                e.preventDefault();
                void api("POST", "/reviews", { task: spec.task, path: spec.path, line: Number(draft.line), body: draft.body }).then(
                  () => (setDraft({ line: "", body: "" }), setNonce((n) => n + 1)),
                  (err) => notify(err instanceof ApiError ? err.message : String(err), "danger"),
                );
              }}
            >
              <input value={draft.line} onChange={(e) => setDraft({ ...draft, line: e.target.value })} placeholder="Line" aria-label="Line" inputMode="numeric" className="h-[26px] w-14 rounded-sm border border-rule bg-sunken px-2 font-mono text-[12px] outline-none focus:border-accent" />
              <input value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="Comment on this version of the file" aria-label="Comment" className="h-[26px] min-w-0 flex-1 rounded-sm border border-rule bg-sunken px-2 text-[12.5px] outline-none focus:border-accent" />
              <button disabled={!draft.body.trim() || !/^\d+$/.test(draft.line)} className="h-[26px] rounded-sm bg-accent px-2.5 text-[12px] text-accent-fg disabled:opacity-40">
                Comment
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
