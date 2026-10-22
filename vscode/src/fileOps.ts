import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { RelayError } from "./connection.ts";
import type { Connection, RelayEvent } from "./connection.ts";
import type { FileSync } from "./fileSync.ts";
import { fingerprint, recoveredName, sharableText } from "./text.ts";

/** What the mirror needs from the extension. */
export interface MirrorHost {
  readonly conn: Connection | null;
  readonly root: vscode.Uri | undefined;
  /** The project's shared files (paths), as last fetched from the server. */
  files: Set<string>;
  refreshFiles(): Promise<void>;
  pathOf(uri: vscode.Uri): string | null;
  /** Open shared documents at `path` or under it (a folder). */
  syncsUnder(path: string): FileSync[];
  /**
   * Keep an open document's shared session across a rename. `ready`: the server already has `toPath`, so the session can
   * reconnect as soon as the new document opens; otherwise wait for `landed(toPath)`.
   */
  carry(sync: FileSync, toPath: string, ready: boolean): void;
  /** The server renamed to `toPath` (true) or refused (false): reconnect, or drop the carried session. */
  landed(toPath: string, ok: boolean): void;
  nameOf(actor: string): string;
  log(line: string): void;
}

const settings = () => vscode.workspace.getConfiguration("relay");

/**
 * Files and folders, both ways, between this checkout and the shared project.
 *
 * From here to Relay: files created, renamed, moved or deleted in VS Code (Explorer, refactorings, Save As) are made in
 * the shared project through Relay's file API, which validates every path. Deleting for everyone is asked first
 * (`relay.shareDeletes`). Files that other programs create or delete in the checkout (git checkout, generators, a
 * terminal) are never shared or deleted automatically: they are listed and the person decides.
 *
 * From Relay to here: files created, renamed or deleted by others are mirrored in the checkout, but never over local
 * work. A local file that already exists with other content is left alone; a file deleted in Relay is removed here
 * only if it still holds exactly what Relay last had (and goes to the trash where there is one); otherwise the person
 * chooses, and can restore it in Relay.
 *
 * Every operation checks the state it finds instead of assuming it, so a repeated event, a replay after reconnecting or
 * the echo of our own operation is a no-op, never a second copy.
 */
export class FileMirror implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  /** Changes we are making in the checkout ourselves, so the file watcher doesn't report them back as someone's. */
  private ours = new Map<string, number>();
  private outsideCreated = new Set<string>();
  private outsideDeleted = new Set<string>();
  private batchTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  /** Open shared sessions of files being renamed in VS Code, by old path. */
  private moving = new Map<string, FileSync[]>();

  constructor(private readonly host: MirrorHost) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher,
      vscode.workspace.onDidCreateFiles((e) => void this.guard(() => this.createdHere(e.files))),
      vscode.workspace.onWillRenameFiles((e) => this.willRename(e.files)),
      vscode.workspace.onDidRenameFiles((e) => void this.guard(() => this.renamedHere(e.files))),
      vscode.workspace.onDidDeleteFiles((e) => void this.guard(() => this.deletedHere(e.files))),
      watcher.onDidCreate((uri) => this.outside("create", uri)),
      watcher.onDidDelete((uri) => this.outside("delete", uri)),
    );
  }

  private get conn(): Connection {
    const c = this.host.conn;
    if (!c || this.disposed) throw new Error("Not connected to Relay");
    return c;
  }

  private inflight = new Set<Promise<void>>();

  /** Resolves once every file operation seen so far has been handled. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private guard(fn: () => Promise<void>): Promise<void> {
    const p = this.run(fn);
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (this.disposed) return;
      void vscode.window.showErrorMessage(`Relay: ${(e as Error).message}`);
    }
  }

  private mark(kind: string, path: string): void {
    this.ours.set(`${kind}:${path}`, Date.now() + 10_000);
  }
  private isOurs(kind: string, path: string): boolean {
    const until = this.ours.get(`${kind}:${path}`);
    return until !== undefined && until > Date.now();
  }

  private uri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.host.root!, ...path.split("/"));
  }

  private async exists(path: string): Promise<vscode.FileType | null> {
    try {
      return (await vscode.workspace.fs.stat(this.uri(path))).type;
    } catch {
      return null;
    }
  }

  private async readLocal(path: string): Promise<string | null> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri(path).toString());
    if (open) return open.getText();
    try {
      const r = sharableText(await vscode.workspace.fs.readFile(this.uri(path)));
      return r.ok ? r.text : null;
    } catch {
      return null;
    }
  }

  private async readDisk(path: string): Promise<string | null> {
    try {
      const r = sharableText(await vscode.workspace.fs.readFile(this.uri(path)));
      return r.ok ? r.text : null;
    } catch {
      return null;
    }
  }

  /** Run a request; on a network failure (outcome unknown) retry, since every file request here is safe to repeat. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.conn.request<T>(method, path, body);
      } catch (e) {
        if (e instanceof RelayError) throw e;
        last = e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw last;
  }

  // ---------- from here to Relay ----------

  /** Share a file that exists here. Idempotent: if Relay already has it, its content is compared, never replaced. */
  async share(path: string): Promise<"shared" | "same" | "differs" | "refused"> {
    if (this.host.files.has(path)) return "same";
    const bytes = await vscode.workspace.fs.readFile(this.uri(path));
    const t = sharableText(bytes);
    if (!t.ok) {
      this.host.log(`${path}: not shared, ${t.reason}`);
      return "refused";
    }
    try {
      await this.request("POST", "/files", { path, content: t.text });
      this.host.files.add(path);
      return "shared";
    } catch (e) {
      if (e instanceof RelayError && e.status === 409) {
        // Created by someone else first (or our own earlier attempt whose answer was lost): compare, don't overwrite.
        const shared = await this.request<{ fingerprint: string }>("GET", `/file?path=${encodeURIComponent(path)}`).catch(() => null);
        this.host.files.add(path);
        return shared?.fingerprint === fingerprint((await this.readLocal(path)) ?? t.text) ? "same" : "differs";
      }
      if (e instanceof RelayError && (e.status === 403 || e.status === 400 || e.status === 413)) {
        this.host.log(`${path}: not shared, ${e.message}`);
        return "refused";
      }
      throw e;
    }
  }

  private async createdHere(uris: readonly vscode.Uri[]): Promise<void> {
    const refused: string[] = [];
    const differs: string[] = [];
    for (const uri of uris) {
      const path = this.host.pathOf(uri);
      if (!path || this.isOurs("create", path)) continue;
      this.mark("create", path); // the watcher's report of this same creation isn't another program's
      const type = await this.exists(path);
      if (type === vscode.FileType.Directory) {
        await this.request("POST", "/folders", { path }).catch((e) => {
          if (!(e instanceof RelayError && e.status === 409)) throw e;
        });
        // A folder pasted with content: share what's inside.
        for (const f of await this.walk(path)) {
          const r = await this.share(f);
          if (r === "refused") refused.push(f);
          if (r === "differs") differs.push(f);
        }
      } else if (type === vscode.FileType.File) {
        const r = await this.share(path);
        if (r === "refused") refused.push(path);
        if (r === "differs") differs.push(path);
      }
    }
    await this.host.refreshFiles();
    if (refused.length) void vscode.window.showInformationMessage(`Not shared in Relay: ${refused.join(", ")} (ignored by git, protected, binary or too large). See the Relay output for why.`);
    if (differs.length) void vscode.window.showWarningMessage(`${differs.join(", ")} already exists in Relay with different content. Nothing was overwritten; when you open it you choose which version to keep.`);
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const [name, type] of await vscode.workspace.fs.readDirectory(this.uri(dir))) {
      const p = `${dir}/${name}`;
      if (type === vscode.FileType.Directory) out.push(...(await this.walk(p)));
      else if (type === vscode.FileType.File) out.push(p);
    }
    return out;
  }

  /** Before VS Code renames: keep open shared documents' sessions, so unsent edits and undo history move with them. */
  private willRename(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    for (const f of files) {
      const from = this.host.pathOf(f.oldUri);
      const to = this.host.pathOf(f.newUri);
      if (!from || !to || this.isOurs("rename", `${from}>${to}`)) continue;
      // The file watcher will see a delete and a create: they're this rename, not another program.
      this.mark("delete", from);
      this.mark("create", to);
      const syncs = this.host.syncsUnder(from);
      this.moving.set(from, syncs);
      for (const s of syncs) this.host.carry(s, to + s.path.slice(from.length), false);
    }
  }

  private async renamedHere(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    for (const f of files) {
      const from = this.host.pathOf(f.oldUri);
      const to = this.host.pathOf(f.newUri);
      if (!to || (from && this.isOurs("rename", `${from}>${to}`))) continue;
      const shared = from && (this.host.files.has(from) || [...this.host.files].some((p) => p.startsWith(`${from}/`)));
      if (!from || !shared) {
        // Moved in from outside the project, or a file Relay never had: it's new to Relay.
        await this.createdHere([f.newUri]);
        continue;
      }
      // Let edits typed just before the rename reach the server under the old name first.
      for (const s of this.moving.get(from) ?? []) await s.confirmedWithin(3000);
      this.moving.delete(from);
      const moved = [...this.host.files].filter((p) => p === from || p.startsWith(`${from}/`)).map((p) => to + p.slice(from.length));
      try {
        await this.request("POST", "/files/rename", { from, to });
        for (const p of moved) this.host.landed(p, true);
      } catch (e) {
        if (e instanceof RelayError && e.status === 404 && (await this.request<{ files: string[] }>("GET", "/files")).files.some((p) => p === to || p.startsWith(`${to}/`))) {
          for (const p of moved) this.host.landed(p, true); // already renamed: our earlier attempt's answer was lost
          continue;
        }
        for (const p of moved) this.host.landed(p, false);
        const back = "Rename it back here";
        this.host.log(`rename ${from} -> ${to} refused by Relay: ${(e as Error).message}`);
        void vscode.window.showWarningMessage(`Renamed ${from} to ${to} here, but not in Relay: ${(e as Error).message}. Everyone else still has ${from}.`, back, "Keep it renamed here").then((pick) => {
          if (pick !== back) return;
          void this.guard(async () => {
            this.mark("rename", `${to}>${from}`);
            const we = new vscode.WorkspaceEdit();
            we.renameFile(f.newUri, f.oldUri, { overwrite: false });
            await vscode.workspace.applyEdit(we);
          });
        });
        continue;
      }
    }
    await this.host.refreshFiles();
  }

  private async deletedHere(uris: readonly vscode.Uri[]): Promise<void> {
    const paths = uris.map((u) => this.host.pathOf(u)).filter((p): p is string => !!p && !this.isOurs("delete", p));
    for (const p of paths) this.mark("delete", p);
    const shared = paths.filter((p) => this.host.files.has(p) || [...this.host.files].some((f) => f.startsWith(`${p}/`)));
    if (!shared.length) return;
    const mode = settings().get<string>("shareDeletes", "ask");
    if (mode === "never") return;
    if (mode !== "always") {
      const all = "Delete for everyone";
      const pick = await vscode.window.showWarningMessage(
        `You deleted ${shared.join(", ")} here. Delete ${shared.length === 1 ? "it" : "them"} for everyone in Relay too?`,
        { modal: true, detail: "Relay keeps the file's edit history, but the file disappears for everyone. Choose Only here to keep it in Relay (you can get it back with Relay: Restore Shared File)." },
        all,
        "Only here",
      );
      if (pick !== all) return;
    }
    for (const p of shared) {
      await this.request("POST", "/files/delete", { path: p }).catch((e) => {
        if (!(e instanceof RelayError && e.status === 404)) throw e; // already deleted: fine
      });
    }
    await this.host.refreshFiles();
  }

  /** Files that other programs created or deleted in the checkout: collected, then the person decides. */
  private outside(kind: "create" | "delete", uri: vscode.Uri): void {
    const path = this.host.pathOf(uri);
    if (!path || path.startsWith(".git/") || path === ".git" || path.startsWith(".relay/") || this.isOurs(kind, path)) return;
    (kind === "create" ? this.outsideCreated : this.outsideDeleted).add(path);
    clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => void this.guard(() => this.reviewOutside()), 800);
  }

  private async reviewOutside(): Promise<void> {
    if (this.disposed || !this.host.conn) return;
    const created = [...this.outsideCreated];
    const deleted = [...this.outsideDeleted];
    this.outsideCreated.clear();
    this.outsideDeleted.clear();
    await this.host.refreshFiles();
    // New, non-ignored files Relay doesn't have (VS Code-made ones were shared already and are in the list now).
    const fresh: string[] = [];
    for (const p of await this.notIgnored(created)) if (!this.host.files.has(p) && (await this.exists(p)) === vscode.FileType.File) fresh.push(p);
    const gone: string[] = [];
    for (const p of deleted) if (this.host.files.has(p) && (await this.exists(p)) === null) gone.push(p);
    const list = (ps: string[]) => (ps.length > 3 ? `${ps.slice(0, 3).join(", ")} and ${ps.length - 3} more` : ps.join(", "));
    // Asked without waiting: an unanswered notification isn't unfinished work. The answer starts the work.
    if (fresh.length) {
      const share = "Share them";
      this.host.log(`outside creations not in Relay: ${fresh.join(", ")}`);
      void vscode.window.showInformationMessage(`${fresh.length === 1 ? "A new file" : `${fresh.length} new files`} appeared in your checkout (from git or another program) and ${fresh.length === 1 ? "isn't" : "aren't"} in Relay: ${list(fresh)}.`, share, "Not now").then((pick) => {
        if (pick === share) void this.guard(() => this.createdHere(fresh.map((p) => this.uri(p))));
      });
    }
    if (gone.length) {
      const restore = "Restore them here";
      const del = "Delete for everyone";
      this.host.log(`outside deletions of shared files: ${gone.join(", ")}`);
      void vscode.window.showWarningMessage(`${list(gone)} ${gone.length === 1 ? "was" : "were"} deleted in your checkout by another program; Relay still has ${gone.length === 1 ? "it" : "them"}.`, restore, del, "Leave as is").then((pick) => {
        if (pick === restore)
          void this.guard(async () => {
            for (const p of gone) await this.writeShared(p);
          });
        if (pick === del) void this.guard(() => this.deletedHere(gone.map((p) => this.uri(p))));
      });
    }
  }

  /** Drop paths git ignores (build output, dependencies); Relay never shares those. */
  private notIgnored(paths: string[]): Promise<string[]> {
    if (!paths.length || !this.host.root) return Promise.resolve(paths);
    return new Promise((ok) => {
      const child = execFile("git", ["check-ignore", "--stdin", "-z"], { cwd: this.host.root!.fsPath }, (_err, stdout) => {
        const ignored = new Set(String(stdout).split("\0").filter(Boolean));
        ok(paths.filter((p) => !ignored.has(p)));
      });
      child.stdin?.end(paths.join("\0"));
    });
  }

  // ---------- from Relay to here ----------

  /** Write Relay's text of `path` into the checkout (creating folders). Never over a different local file. */
  private async writeShared(path: string): Promise<"written" | "same" | "kept-local" | "missing"> {
    const local = await this.readLocal(path);
    const r = await this.request<{ text: string }>("GET", `/file?path=${encodeURIComponent(path)}`).catch((e) => {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    });
    if (!r) return "missing";
    if (local !== null) return local === r.text ? "same" : "kept-local";
    if ((await this.exists(path)) !== null) return "kept-local"; // something we can't read as text: leave it
    this.mark("create", path);
    const slash = path.lastIndexOf("/");
    if (slash > 0) await vscode.workspace.fs.createDirectory(this.uri(path.slice(0, slash)));
    await vscode.workspace.fs.writeFile(this.uri(path), new TextEncoder().encode(r.text));
    return "written";
  }

  async onEvent(e: RelayEvent): Promise<void> {
    if (this.disposed || !this.host.root) return;
    const who = this.host.nameOf(e.actor);
    if (e.type === "file.created") {
      const path = String(e.data.path);
      if ((await this.writeShared(path)) === "kept-local") void vscode.window.showWarningMessage(`${who} created ${path} in Relay, but your checkout already has a different ${path}. Yours was left as is; when you open it you choose which version to keep.`);
    } else if (e.type === "folder.created") {
      const path = String(e.data.path);
      if ((await this.exists(path)) === null) {
        this.mark("create", path);
        await vscode.workspace.fs.createDirectory(this.uri(path));
      }
    } else if (e.type === "file.renamed") {
      await this.renamedThere(String(e.data.from), String(e.data.to), (e.data.files as { from: string; to: string }[] | undefined) ?? [], who);
    } else if (e.type === "file.deleted") {
      await this.deletedThere((e.data.files as string[] | undefined) ?? [], (e.data.finalHash as Record<string, string> | undefined) ?? {}, who);
    }
  }

  private async renamedThere(from: string, to: string, pairs: { from: string; to: string }[], who: string): Promise<void> {
    const src = await this.exists(from);
    const dst = await this.exists(to);
    if (src === null && dst !== null) return; // already done here (our own rename, or a replayed event)
    if (src === null) {
      for (const p of pairs.length ? pairs : [{ from, to }]) await this.writeShared(p.to); // we never had it: fetch it
      return;
    }
    if (dst !== null) {
      void vscode.window.showWarningMessage(`${who} renamed ${from} to ${to} in Relay, but your checkout already has a ${to}. Nothing was changed here; ${from} is no longer shared under that name.`);
      return;
    }
    // Open documents keep their shared session (and unsent edits) across the move.
    for (const s of this.host.syncsUnder(from)) this.host.carry(s, to + s.path.slice(from.length), true);
    this.mark("rename", `${from}>${to}`);
    this.mark("delete", from);
    this.mark("create", to);
    const we = new vscode.WorkspaceEdit();
    we.renameFile(this.uri(from), this.uri(to), { overwrite: false });
    if (!(await vscode.workspace.applyEdit(we))) {
      void vscode.window.showWarningMessage(`${who} renamed ${from} to ${to} in Relay, but VS Code couldn't rename it here.`);
      return;
    }
    vscode.window.setStatusBarMessage(`Relay: ${who} renamed ${from} to ${to}`, 6000);
  }

  private async deletedThere(paths: string[], finalHash: Record<string, string>, who: string): Promise<void> {
    const kept: string[] = [];
    for (const p of paths) {
      if ((await this.exists(p)) === null) continue;
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri(p).toString());
      const disk = await this.readDisk(p);
      // Only remove a copy that holds nothing Relay didn't have: the file on disk AND any open editor hold exactly Relay's
      // last text, nothing is unsaved and nothing unsent. (An editor can lag behind its file on disk, so both count.)
      const clean = disk !== null && finalHash[p] === fingerprint(disk) && (!open || (!open.isDirty && fingerprint(open.getText()) === finalHash[p])) && !this.host.syncsUnder(p).some((s) => s.unsent());
      if (!clean) {
        kept.push(p);
        continue;
      }
      this.mark("delete", p);
      await vscode.workspace.fs.delete(this.uri(p), { useTrash: true }).then(undefined, () => vscode.workspace.fs.delete(this.uri(p)));
    }
    if (!kept.length) return;
    const restore = "Restore it in Relay";
    const del = "Delete my copy";
    this.host.log(`${who} deleted ${kept.join(", ")} in Relay; kept here (local changes)`);
    void vscode.window
      .showWarningMessage(`${who} deleted ${kept.join(", ")} in Relay. Your copy has changes Relay didn't have, so it was kept and is no longer shared.`, restore, del, "Keep my copy")
      .then((pick) => void this.guard(() => this.afterDeletedThere(pick === restore ? "restore" : pick === del ? "delete" : "keep", kept)));
  }

  private async afterDeletedThere(pick: "restore" | "delete" | "keep", kept: string[]): Promise<void> {
    if (pick === "restore") {
      for (const p of kept) {
        const text = (await this.readLocal(p)) ?? "";
        // Restore under the same name if it's free, else next to it.
        try {
          await this.request("POST", "/files", { path: p, content: text });
        } catch (e) {
          if (!(e instanceof RelayError && e.status === 409)) throw e;
          await this.request("POST", "/files", { path: recoveredName(p), content: text });
        }
      }
      await this.host.refreshFiles();
    } else if (pick === "delete") {
      for (const p of kept) {
        this.mark("delete", p);
        await vscode.workspace.fs.delete(this.uri(p), { useTrash: true }).then(undefined, () => vscode.workspace.fs.delete(this.uri(p)));
      }
    }
  }

  /** Relay: Restore Shared File — bring back shared files that are missing from this checkout. */
  async restoreMissing(): Promise<number> {
    const { missing } = await this.missingHere();
    if (!missing.length) {
      void vscode.window.showInformationMessage("Every shared file is in your checkout.");
      return 0;
    }
    const picks = await vscode.window.showQuickPick(
      missing.map((p) => ({ label: p, picked: true })),
      { canPickMany: true, title: "Restore shared files into your checkout", placeHolder: "These files are in Relay but not here" },
    );
    if (!picks?.length) return 0;
    let n = 0;
    for (const p of picks) if ((await this.writeShared(p.label)) === "written") n++;
    return n;
  }

  private async missingHere(): Promise<{ missing: string[]; differ: string[] }> {
    const { fingerprints } = await this.request<{ fingerprints: Record<string, string> }>("GET", "/files/fingerprints");
    const missing: string[] = [];
    const differ: string[] = [];
    for (const [p, fp] of Object.entries(fingerprints)) {
      const local = await this.readLocal(p);
      if (local === null) {
        if ((await this.exists(p)) === null) missing.push(p);
      } else if (fingerprint(local) !== fp) differ.push(p);
    }
    return { missing, differ };
  }

  /**
   * Compare this checkout with the shared project when joining or reconnecting: shared files missing here can be fetched;
   * files that differ are reported (each is decided when opened). Nothing is changed without the person's choice.
   */
  async compareOnJoin(): Promise<{ missing: string[]; differ: string[] }> {
    const { missing, differ } = await this.missingHere();
    const parts: string[] = [];
    if (missing.length) parts.push(`${missing.length} shared ${missing.length === 1 ? "file isn't" : "files aren't"} in your checkout`);
    if (differ.length) parts.push(`${differ.length} ${differ.length === 1 ? "differs" : "differ"} from the shared ${differ.length === 1 ? "copy" : "copies"} (you choose when you open ${differ.length === 1 ? "it" : "each"})`);
    if (parts.length) {
      const get = "Get the missing files";
      void vscode.window.showInformationMessage(`Relay: ${parts.join("; ")}.`, ...(missing.length ? [get] : [])).then(async (pick) => {
        if (pick === get) for (const p of missing) await this.writeShared(p);
      });
    }
    return { missing, differ };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.batchTimer);
    for (const d of this.disposables) d.dispose();
  }
}
