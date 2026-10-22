import * as vscode from "vscode";
import type { Connection, Member } from "./connection.ts";

export interface Origin {
  author: string;
  kind: "member" | "agent" | "baseline" | "disk" | "unknown";
  text: string;
  at: string | null;
  seq: number | null;
  session: string | null;
}

/** Who wrote a part of a line, in words. */
export function authorName(o: Origin, members: Member[]): string {
  const m = members.find((x) => x.id === o.author);
  if (m) return m.name;
  if (o.kind === "agent") return `Agent ${o.author.replace(/^agent:/, "")}`;
  if (o.kind === "baseline") return "Already in the file";
  if (o.kind === "disk") return "Changed outside Relay";
  return o.author;
}

/**
 * The before/after of a Relay edit session, served to VS Code's diff editor as read-only documents
 * (`relay-session:/<id>/before/<path>` and `.../after/<path>`).
 */
export class SessionContent implements vscode.TextDocumentContentProvider {
  conn: Connection | null = null;
  private cache = new Map<string, { before: string; after: string }>();

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [, id, side] = uri.path.split("/");
    if (!this.conn || !id) return "";
    let sides = this.cache.get(id);
    if (!sides) {
      sides = await this.conn.request<{ before: string; after: string }>("GET", `/sessions/${encodeURIComponent(id)}/sides`);
      this.cache.set(id, sides);
    }
    return side === "before" ? sides.before : sides.after;
  }
}

/** "Who wrote this line?": each part of the line with its author and time; picking one opens that edit session as a diff. */
export async function showLineHistory(conn: Connection, path: string, line: number): Promise<void> {
  const r = await conn.request<{ origins: Origin[] }>("GET", `/attribution/line?path=${encodeURIComponent(path)}&line=${line}`);
  if (!r.origins.length) {
    void vscode.window.showInformationMessage(`Line ${line} of ${path} is blank.`);
    return;
  }
  const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const pick = await vscode.window.showQuickPick(
    r.origins.map((o) => ({
      label: authorName(o, conn.members),
      description: o.at ? (o.kind === "baseline" ? `loaded ${when(o.at)}` : when(o.at)) : "",
      detail: o.text.trim(),
      origin: o,
    })),
    { title: `Who wrote line ${line} of ${path}`, placeHolder: "Pick a part to see the change that wrote it" },
  );
  if (!pick) return;
  if (!pick.origin.session) {
    void vscode.window.showInformationMessage(`${pick.label}: no edit session recorded for this part (it was in the file before Relay tracked it, or came from outside).`);
    return;
  }
  const base = `relay-session:/${pick.origin.session}`;
  await vscode.commands.executeCommand("vscode.diff", vscode.Uri.parse(`${base}/before/${path}`), vscode.Uri.parse(`${base}/after/${path}`), `${path}: ${pick.label}'s change`);
}
