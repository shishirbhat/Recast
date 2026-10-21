"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileCode2, FileText, FilePlus2, Folder, FolderOpen, FolderPlus } from "lucide-react";
import type { Member } from "@/lib/types";
import { IconButton } from "./ui";

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  file: boolean;
}

function build(paths: string[], folders: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map(), file: false };
  const add = (p: string, leafIsFile: boolean) => {
    let cur = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path, children: new Map(), file: leafIsFile && i === parts.length - 1 });
      cur = cur.children.get(part)!;
    });
  };
  for (const p of paths) add(p, true);
  for (const f of folders) add(f, false);
  return root;
}

const sorted = (n: Node) => [...n.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
const GIT_LETTER: Record<string, string> = { modified: "M", added: "A", untracked: "U", deleted: "D", renamed: "R" };
function gitTone(st: string | undefined): string {
  if (st === "modified") return "text-warn";
  if (st === "added" || st === "untracked") return "text-ok";
  if (st === "deleted") return "text-danger line-through";
  return "";
}
const CODE = /\.(m?[jt]sx?|c?js|py|css|html?|json|rs|go|java|rb|sh)$/i;
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

/** The inline name box, as VS Code shows it: new file or folder inside `dir`, or renaming `path`. */
type Editing = { kind: "file" | "folder"; dir: string } | { kind: "rename"; path: string };
interface Menu {
  x: number;
  y: number;
  target: { path: string; file: boolean } | null;
}

export function FileTree({
  files,
  folders = [],
  active,
  presence,
  members,
  me,
  canEdit,
  onOpen,
  onCreate,
  onCreateFolder,
  onRename,
  onDelete,
  onCopyPath,
  gitStatus,
  title,
}: {
  files: string[];
  folders?: string[];
  active: string | null;
  presence: Map<string, string[]>;
  members: Member[];
  me: Member;
  canEdit: boolean;
  onOpen: (path: string) => void;
  onCreate: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string, folder: boolean) => void;
  onCopyPath: (path: string) => void;
  /** path -> git status, shown as VS Code-style letters. */
  gitStatus?: Map<string, string>;
  title?: string;
}) {
  const tree = useMemo(() => build(files, folders), [files, folders]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The file list arrives after the first render: open top-level folders once, when it first shows up.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || files.length === 0) return;
    seeded.current = true;
    setOpen(new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!)));
  }, [files]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [focused, setFocused] = useState<{ path: string; file: boolean } | null>(null);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const viewOnly = canEdit ? null : "Viewers can't change files";

  useEffect(() => {
    if (!menu) return;
    const off = () => setMenu(null);
    window.addEventListener("mousedown", off);
    window.addEventListener("blur", off);
    return () => (window.removeEventListener("mousedown", off), window.removeEventListener("blur", off));
  }, [menu]);

  /** New file or folder goes in the folder that was right-clicked, or next to the file. */
  const dirOf = (t: { path: string; file: boolean } | null) => (!t ? "" : t.file ? parentOf(t.path) : t.path);
  const startNew = (kind: "file" | "folder", t: { path: string; file: boolean } | null) => {
    const dir = dirOf(t);
    if (dir) setOpen((s) => new Set(s).add(dir));
    setEditing({ kind, dir });
  };
  const remove = (t: { path: string; file: boolean }) => {
    if (confirm(`Delete ${t.path}${t.file ? "" : " and everything in it"}?\n\nAnyone with it open is told. Files git tracks can be restored from git; untracked files can't.`)) onDelete(t.path, !t.file);
  };
  const onKey = (e: React.KeyboardEvent, t: { path: string; file: boolean }) => {
    if (!canEdit) return;
    if (e.key === "F2") (e.preventDefault(), setEditing({ kind: "rename", path: t.path }));
    else if (e.key === "Delete") (e.preventDefault(), remove(t));
  };
  const context = (e: React.MouseEvent, target: Menu["target"]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const nameBox = (depth: number, initial: string, onDone: (v: string) => void, icon: React.ReactNode) => (
    <form
      className="flex h-[24px] items-center gap-1.5 pr-2"
      style={{ paddingLeft: 22 + depth * 14 }}
      onSubmit={(e) => {
        e.preventDefault();
        const v = new FormData(e.currentTarget).get("name")?.toString().trim();
        setEditing(null);
        if (v && v !== initial) onDone(v);
      }}
    >
      {icon}
      <input
        name="name"
        autoFocus
        defaultValue={initial}
        aria-label="Name"
        data-testid="tree-name-input"
        onFocus={(e) => {
          // Select the name without its extension, as VS Code does.
          const dot = initial.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
        onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setEditing(null))}
        onBlur={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-[22px] min-w-0 flex-1 rounded-sm border border-accent bg-editor px-1.5 text-[13px] outline-none"
      />
    </form>
  );
  const newBoxFor = (dir: string, depth: number) =>
    editing && editing.kind !== "rename" && editing.dir === dir
      ? nameBox(depth, "", (v) => (editing.kind === "file" ? onCreate : onCreateFolder)(dir ? `${dir}/${v}` : v), editing.kind === "file" ? <FileText size={14} className="shrink-0 text-faint" /> : <Folder size={14} className="shrink-0 text-muted" />)
      : null;

  const render = (node: Node, depth: number): React.ReactNode => [
    newBoxFor(node.path, depth) && <div key={`new:${node.path}`}>{newBoxFor(node.path, depth)}</div>,
    ...sorted(node).map((n) => {
      const renaming = editing?.kind === "rename" && editing.path === n.path;
      const rename = (v: string) => onRename(n.path, parentOf(n.path) ? `${parentOf(n.path)}/${v}` : v);
      if (!n.file) {
        const isOpen = open.has(n.path);
        return (
          <div key={n.path}>
            {renaming ? (
              nameBox(depth, n.name, rename, <Folder size={14} className="shrink-0 text-muted" />)
            ) : (
              <button
                onClick={() => setOpen((s) => (s.has(n.path) ? (s.delete(n.path), new Set(s)) : new Set(s.add(n.path))))}
                onContextMenu={(e) => context(e, { path: n.path, file: false })}
                onKeyDown={(e) => onKey(e, { path: n.path, file: false })}
                onFocus={() => setFocused({ path: n.path, file: false })}
                data-testid={`folder-${n.path}`}
                className="group flex h-[24px] w-full items-center gap-1.5 pr-2 text-[13px] text-ink-2 hover:bg-hover"
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                <ChevronRight size={13} className={`text-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
                {isOpen ? <FolderOpen size={14} className="text-muted" /> : <Folder size={14} className="text-muted" />}
                <span className="truncate">{n.name}</span>
              </button>
            )}
            {isOpen && render(n, depth + 1)}
          </div>
        );
      }
      if (renaming) return <div key={n.path}>{nameBox(depth, n.name, rename, <FileText size={14} className="shrink-0 text-faint" />)}</div>;
      const here = (presence.get(n.path) ?? []).filter((id) => id !== me.id);
      const isActive = n.path === active;
      return (
        <button
          key={n.path}
          onClick={() => onOpen(n.path)}
          onContextMenu={(e) => context(e, { path: n.path, file: true })}
          onKeyDown={(e) => onKey(e, { path: n.path, file: true })}
          onFocus={() => setFocused({ path: n.path, file: true })}
          data-testid={`file-${n.path}`}
          className={`group flex h-[24px] w-full items-center gap-1.5 pr-2 text-[13px] ${isActive ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover/60"}`}
          style={{ paddingLeft: 22 + depth * 14 }}
        >
          {CODE.test(n.name) ? <FileCode2 size={14} className={isActive ? "text-ink-2" : "text-faint"} /> : <FileText size={14} className={isActive ? "text-ink-2" : "text-faint"} />}
          <span className={`truncate ${gitTone(gitStatus?.get(n.path))}`}>{n.name}</span>
          <span className="ml-auto flex items-center gap-0.5">
            {here.slice(0, 3).map((id) => (
              <span key={id} title={`${byId.get(id)?.name ?? id} is here`} className="size-2 rounded-full" style={{ background: byId.get(id)?.color ?? "var(--muted)" }} />
            ))}
            {gitStatus?.get(n.path) && <span className={`ml-1 w-3 text-center font-mono text-[11px] ${gitTone(gitStatus.get(n.path))}`}>{GIT_LETTER[gitStatus.get(n.path)!]}</span>}
          </span>
        </button>
      );
    }),
  ];

  const t = menu?.target ?? null;
  const items: ({ label: string; key?: string; reason: string | null; run: () => void } | "-")[] = [
    { label: "New File…", reason: viewOnly, run: () => startNew("file", t) },
    { label: "New Folder…", reason: viewOnly, run: () => startNew("folder", t) },
    ...(t
      ? [
          "-" as const,
          { label: "Copy Relative Path", reason: null, run: () => onCopyPath(t.path) },
          "-" as const,
          { label: "Rename…", key: "F2", reason: viewOnly, run: () => setEditing({ kind: "rename", path: t.path }) },
          { label: "Delete", key: "Delete", reason: viewOnly, run: () => remove(t) },
        ]
      : []),
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="px-2">
        <div className="flex h-6.5 items-center justify-between pl-2 pr-0.5">
          <span className="micro truncate text-ink-2">{title ?? "Files"}</span>
          {canEdit && (
            <span className="flex items-center">
              <IconButton label="New file" onClick={() => startNew("file", focused)} className="size-5.5 rounded-md">
                <FilePlus2 size={13} />
              </IconButton>
              <IconButton label="New folder" onClick={() => startNew("folder", focused)} className="size-5.5 rounded-md">
                <FolderPlus size={13} />
              </IconButton>
            </span>
          )}
        </div>
      </div>
      <nav aria-label="Project files" className="min-h-0 flex-1 overflow-y-auto pb-3" onContextMenu={(e) => context(e, null)}>
        {render(tree, 0)}
      </nav>
      {menu && (
        <div role="menu" aria-label="File actions" onMouseDown={(e) => e.stopPropagation()} style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 180) }} className="glass fixed z-50 w-56 rounded-md border border-rule-strong p-1">
          {items.map((it, i) =>
            it === "-" ? (
              <div key={`s${i}`} role="separator" className="mx-1.5 my-1 h-px bg-rule" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                aria-disabled={!!it.reason}
                title={it.reason ?? undefined}
                onClick={() => {
                  if (it.reason) return;
                  setMenu(null);
                  it.run();
                }}
                className={`flex h-[26px] w-full items-center rounded-sm px-2.5 text-left text-[12.5px] ${it.reason ? "cursor-default text-faint" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
              >
                {it.label}
                {it.key && <span className="ml-auto font-mono text-[11px] text-faint">{it.key}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
