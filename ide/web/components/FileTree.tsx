"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileCode2, FileText, FilePlus2, Folder, FolderOpen } from "lucide-react";
import type { Member } from "@/lib/types";
import { IconButton } from "./ui";

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  file: boolean;
}

function build(paths: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map(), file: false };
  for (const p of paths) {
    let cur = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path, children: new Map(), file: i === parts.length - 1 });
      cur = cur.children.get(part)!;
    });
  }
  return root;
}

const sorted = (n: Node) => [...n.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
const CODE = /\.(m?[jt]sx?|c?js|py|css|html?|json|rs|go|java|rb|sh)$/i;

export function FileTree({
  files,
  active,
  presence,
  members,
  me,
  canEdit,
  onOpen,
  onCreate,
}: {
  files: string[];
  active: string | null;
  presence: Map<string, string[]>;
  members: Member[];
  me: Member;
  canEdit: boolean;
  onOpen: (path: string) => void;
  onCreate: (path: string) => void;
}) {
  const tree = useMemo(() => build(files), [files]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The file list arrives after the first render: open top-level folders once, when it first shows up.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || files.length === 0) return;
    seeded.current = true;
    setOpen(new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!)));
  }, [files]);
  const [creating, setCreating] = useState(false);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const render = (node: Node, depth: number): React.ReactNode =>
    sorted(node).map((n) => {
      if (!n.file) {
        const isOpen = open.has(n.path);
        return (
          <div key={n.path}>
            <button
              onClick={() => setOpen((s) => (s.has(n.path) ? (s.delete(n.path), new Set(s)) : new Set(s.add(n.path))))}
              className="group flex h-[22px] w-full items-center gap-1.5 pr-2 text-[13px] text-ink-2 hover:bg-hover"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              <ChevronRight size={13} className={`text-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
              {isOpen ? <FolderOpen size={14} className="text-muted" /> : <Folder size={14} className="text-muted" />}
              <span className="truncate">{n.name}</span>
            </button>
            {isOpen && render(n, depth + 1)}
          </div>
        );
      }
      const here = (presence.get(n.path) ?? []).filter((id) => id !== me.id);
      const isActive = n.path === active;
      return (
        <button
          key={n.path}
          onClick={() => onOpen(n.path)}
          data-testid={`file-${n.path}`}
          className={`group flex h-[22px] w-full items-center gap-1.5 pr-2 text-[13px] ${isActive ? "bg-accent-soft text-ink outline outline-1 -outline-offset-1 outline-accent-line" : "text-ink-2 hover:bg-hover"}`}
          style={{ paddingLeft: 22 + depth * 14 }}
        >
          {CODE.test(n.name) ? <FileCode2 size={14} className={isActive ? "text-accent" : "text-faint"} /> : <FileText size={14} className={isActive ? "text-accent" : "text-faint"} />}
          <span className="truncate">{n.name}</span>
          <span className="ml-auto flex gap-0.5">
            {here.slice(0, 3).map((id) => (
              <span key={id} title={`${byId.get(id)?.name ?? id} is here`} className="size-2 rounded-full" style={{ background: byId.get(id)?.color ?? "var(--muted)" }} />
            ))}
          </span>
        </button>
      );
    });

  return (
    <div className="flex h-full flex-col">
      <div className="px-2">
        <div className="flex h-6.5 items-center justify-between pl-2 pr-0.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-2">Files</span>
          {canEdit && (
            <IconButton label="New file" onClick={() => setCreating(true)} className="size-5.5 rounded-md">
              <FilePlus2 size={13} />
            </IconButton>
          )}
        </div>
        {creating && (
          <form
            className="mb-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("path")?.toString().trim();
              if (v) onCreate(v);
              setCreating(false);
            }}
          >
            <input
              name="path"
              autoFocus
              placeholder="src/new-file.ts"
              onBlur={() => setCreating(false)}
              className="h-6.5 w-full rounded border border-accent bg-editor px-2 font-mono text-[12.5px] outline-none"
            />
          </form>
        )}
      </div>
      <nav aria-label="Project files" className="min-h-0 flex-1 overflow-y-auto pb-3">
        {render(tree, 0)}
      </nav>
    </div>
  );
}
