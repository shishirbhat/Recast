"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Globe, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "../ui";

type Role = "editor" | "viewer" | "owner";
const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "editor", label: "Editor", hint: "edits files, proposes tasks" },
  { id: "viewer", label: "Viewer", hint: "reads only" },
  { id: "owner", label: "Owner", hint: "also approves, applies agent work, invites" },
];

/**
 * Invite someone. One invite, two ways in: the browser IDE (nothing to install), or VS Code with the Relay extension
 * (their own checkout, their own extensions). The invite works once, whichever they use.
 */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; link: string } | null>(null);
  const [vsix, setVsix] = useState<{ available: boolean; url?: string; reason?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void api<{ vscodeExtension?: { available: boolean; url?: string; reason?: string } }>("GET", "/capabilities").then(
      (c) => setVsix(c.vscodeExtension ?? { available: false, reason: "This Relay server doesn't offer the VS Code extension." }),
      () => setVsix({ available: false, reason: "Couldn't reach the Relay server." }),
    );
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const create = async () => {
    setError(null);
    try {
      const r = await api<{ joinPath: string }>("POST", "/members", { name: name.trim(), role });
      setMade({ name: name.trim(), link: `${location.origin}${r.joinPath}` });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => (setCopied(what), setTimeout(() => setCopied(null), 1500)),
      () => setError("Couldn't copy: select the link and copy it by hand."),
    );
  };
  const vscodeLink = made ? `vscode://relay.relay-vscode/join?invite=${encodeURIComponent(made.link)}` : "";

  const row = (id: string, icon: React.ReactNode, title: string, hint: string, value: string) => (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2 text-[13px] text-ink">
        {icon}
        <span className="font-medium">{title}</span>
        <span className="text-[12px] text-muted">{hint}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="h-[26px] min-w-0 flex-1 rounded-sm border border-rule bg-sunken px-2 font-mono text-[11.5px] text-ink-2" aria-label={`${title} link`} data-testid={`invite-${id}`} />
        <Button size="sm" onClick={() => copy(id, value)} aria-label={`Copy ${title} link`}>
          {copied === id ? <Check size={12} /> : <Copy size={12} />} {copied === id ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Invite someone" className="glass w-[520px] max-w-[calc(100vw-32px)] rounded-md border border-rule-strong" data-testid="invite-dialog">
        <div className="flex items-center border-b border-rule px-4 py-2.5">
          <span className="text-[13px] font-medium text-ink">{made ? `Invite for ${made.name}` : "Invite someone"}</span>
          <button aria-label="Close" onClick={onClose} className="ml-auto grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
            <X size={13} />
          </button>
        </div>
        {!made ? (
          <form
            className="space-y-3 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <label className="block text-[12.5px] text-muted">
              Name
              <input ref={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="mt-1 block h-[28px] w-full rounded-sm border border-rule bg-sunken px-2 text-[13px] text-ink" data-testid="invite-name" />
            </label>
            <fieldset className="space-y-1">
              <legend className="text-[12.5px] text-muted">Role</legend>
              {ROLES.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-[13px] text-ink-2">
                  <input type="radio" name="role" checked={role === r.id} onChange={() => setRole(r.id)} />
                  {r.label} <span className="text-[12px] text-faint">{r.hint}</span>
                </label>
              ))}
            </fieldset>
            {error && <p className="text-[12.5px] text-danger">{error}</p>}
            <div className="flex justify-end">
              <Button tone="primary" type="submit" disabled={!name.trim()} title={name.trim() ? undefined : "Enter their name first"}>
                Create invite
              </Button>
            </div>
          </form>
        ) : (
          <div className="py-1">
            <p className="px-4 pt-2 text-[12.5px] text-muted">One-time, valid 72 hours. Send {made.name} one of these; whichever they open first uses it.</p>
            {row("browser", <Globe size={13} className="text-muted" />, "Browser", "nothing to install", made.link)}
            {row("vscode", <span className="font-mono text-[11px] font-semibold text-accent-ink">VS</span>, "VS Code", "their own checkout and extensions", vscodeLink)}
            <div className="px-4 pb-3 text-[12px] text-muted">
              {vsix?.available ? (
                <a href={vsix.url} download className="inline-flex items-center gap-1.5 text-accent-ink hover:underline" data-testid="invite-vsix">
                  <Download size={12} /> Download the Relay extension for VS Code
                </a>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-faint" title={vsix?.reason} data-testid="invite-vsix-missing">
                  <Download size={12} /> Extension download unavailable: {vsix?.reason ?? "checking…"}
                </span>
              )}
              <span className="block pt-1">In VS Code they open their checkout of this repository, install the extension, then open the VS Code link.</span>
            </div>
            {error && <p className="px-4 pb-2 text-[12.5px] text-danger">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
