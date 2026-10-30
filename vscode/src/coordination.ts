import * as vscode from "vscode";
import type { Connection } from "./connection.ts";

/** The same status vocabulary as the browser IDE (`STATUS` in CoordinationView.tsx), derived by the server. */
export const STATUS: Record<string, { label: string; icon: string; color?: string }> = {
  proposed: { label: "Awaiting approval", icon: "circle-outline", color: "charts.yellow" },
  waiting: { label: "Waiting", icon: "clock" },
  queued: { label: "Queued", icon: "circle-outline" },
  running: { label: "Running", icon: "sync~spin", color: "charts.blue" },
  stopped: { label: "Stopped", icon: "debug-stop", color: "charts.red" },
  checking: { label: "Checking", icon: "loading~spin", color: "charts.blue" },
  blocked: { label: "Blocked", icon: "error", color: "charts.red" },
  verification_failed: { label: "Verification failed", icon: "error", color: "charts.red" },
  verification_required: { label: "Verification required", icon: "warning", color: "charts.yellow" },
  review: { label: "Needs review", icon: "eye", color: "charts.yellow" },
  ready: { label: "Ready to integrate", icon: "pass-filled", color: "charts.green" },
  failed: { label: "Failed", icon: "error", color: "charts.red" },
  cancelled: { label: "Cancelled", icon: "circle-slash" },
  done: { label: "Done", icon: "check" },
};

export interface CoordTask {
  id: string;
  objective: string;
  status: string;
  why: string;
  blockers: string[];
  files: string[];
  partners: string[];
  run: { status: string; provider: string; worktree: string } | null;
}

/** One Conflict Radar alert (`src/analysis/radar.ts` on the server): evidence-based, known or suspected. */
export interface RadarAlert {
  id: string;
  kind: string;
  certainty: "known" | "suspected";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  tasks: string[];
  files: string[];
  evidence: { at: string | null; source: string; text: string }[];
}

type Node =
  | { kind: "task"; task: CoordTask }
  | { kind: "file"; task: CoordTask; path: string }
  | { kind: "info"; text: string; tooltip?: string }
  | { kind: "radar"; alerts: RadarAlert[] }
  | { kind: "alert"; alert: RadarAlert };

/**
 * Relay's Coordination view in VS Code's sidebar: every task with the server's status and why, the files it changed,
 * and what still blocks it. "Apply to project" appears on agent work that is ready, for owners; the server enforces the
 * same rules again (and re-checks the change against the current project first).
 */
export class CoordinationTree implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private tasks: CoordTask[] | null = null;
  private alerts: RadarAlert[] | null = null;
  /** Settles when the radar requested by the latest refresh has arrived (or failed). */
  radarDone: Promise<void> = Promise.resolve();
  private error: string | null = null;
  conn: Connection | null = null;

  async refresh(): Promise<void> {
    if (!this.conn) {
      this.tasks = null;
      this.error = null;
    } else {
      try {
        this.tasks = (await this.conn.request<{ tasks: CoordTask[] }>("GET", "/coordination")).tasks;
        this.error = null;
        // The radar takes longer to compute and is extra: the tasks show (and commands go on) without waiting for it,
        // and if it can't be read, the tasks still show.
        const conn = this.conn;
        this.radarDone = conn.request<{ alerts: RadarAlert[] }>("GET", "/radar").then(
          (r) => {
            if (this.conn === conn) (this.alerts = r.alerts), this.changed.fire();
          },
          () => {},
        );
      } catch (e) {
        this.error = (e as Error).message;
      }
    }
    this.changed.fire();
  }

  task(id: string): CoordTask | undefined {
    return this.tasks?.find((t) => t.id === id);
  }

  all(): CoordTask[] {
    return this.tasks ?? [];
  }

  /** Needed to reveal a task (Check Together's "Show T-…"): tasks are top level, files and notes sit under theirs. */
  getParent(node: Node): Node | undefined {
    if (node.kind === "alert") return { kind: "radar", alerts: this.alerts ?? [] };
    return node.kind === "file" ? { kind: "task", task: node.task } : undefined;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (!this.conn) return [];
      if (this.error) return [{ kind: "info", text: `Couldn't load: ${this.error}` }];
      if (!this.tasks) return [{ kind: "info", text: "Loading…" }];
      if (!this.tasks.length) return [{ kind: "info", text: "No tasks yet" }];
      const tasks = this.tasks.filter((t) => t.status !== "cancelled").map((task): Node => ({ kind: "task", task }));
      return this.alerts?.length ? [{ kind: "radar", alerts: this.alerts }, ...tasks] : tasks;
    }
    if (node.kind === "radar") return node.alerts.map((alert): Node => ({ kind: "alert", alert }));
    if (node.kind !== "task") return [];
    const t = node.task;
    return [
      ...t.blockers.map((b): Node => ({ kind: "info", text: b, tooltip: "Blocks integration" })),
      ...t.files.map((path): Node => ({ kind: "file", task: t, path })),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "radar") {
      const high = node.alerts.filter((a) => a.severity === "high").length;
      const item = new vscode.TreeItem("Conflict radar", high ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = "radar";
      item.description = `${node.alerts.length} ${node.alerts.length === 1 ? "alert" : "alerts"}${high ? `, ${high} high` : ""}`;
      item.tooltip = "What could go wrong between pieces of work before they're integrated, from evidence. Known: Relay can show the fact. Suspected: evidence points to it, but nothing has run to prove it.";
      item.iconPath = new vscode.ThemeIcon("radio-tower", high ? new vscode.ThemeColor("charts.red") : undefined);
      return item;
    }
    if (node.kind === "alert") {
      const a = node.alert;
      const item = new vscode.TreeItem(a.title);
      item.id = `alert:${a.id}`;
      item.description = `${a.certainty === "known" ? "Known" : "Suspected"} · ${a.severity}`;
      item.tooltip = new vscode.MarkdownString(`**${a.title}**\n\n${a.certainty === "known" ? "Known" : "Suspected"}, ${a.severity} severity\n\n${a.detail}\n\n${a.evidence.map((e) => `- *${e.source}*${e.at ? ` (${e.at})` : ""}: \`${e.text.replace(/`/g, "'")}\``).join("\n")}`);
      item.iconPath = new vscode.ThemeIcon(a.severity === "high" ? "error" : a.severity === "medium" ? "warning" : "info", a.severity === "high" ? new vscode.ThemeColor("charts.red") : a.severity === "medium" ? new vscode.ThemeColor("charts.yellow") : undefined);
      const folder = vscode.workspace.workspaceFolders?.[0];
      const file = a.files.at(-1);
      if (folder && file) item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.joinPath(folder.uri, file)] };
      item.contextValue = "radar-alert";
      return item;
    }
    if (node.kind === "info") {
      const item = new vscode.TreeItem(node.text);
      item.tooltip = node.tooltip ?? node.text;
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    if (node.kind === "file") {
      const item = new vscode.TreeItem(node.path);
      item.iconPath = vscode.ThemeIcon.File;
      item.resourceUri = vscode.Uri.parse(`relay-file:/${node.path}`);
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.joinPath(folder.uri, node.path)] };
      item.tooltip = node.task.run && node.task.run.status !== "applied" ? `Changed by the agent in ${node.task.run.worktree}; your copy shows the shared project` : node.path;
      return item;
    }
    const t = node.task;
    const s = STATUS[t.status] ?? { label: t.status, icon: "circle-outline" };
    const item = new vscode.TreeItem(`${t.id}  ${t.objective}`, t.blockers.length || t.files.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `task:${t.id}`;
    item.description = s.label;
    item.tooltip = new vscode.MarkdownString(`**${t.id}** · ${s.label}\n\n${t.why}${t.run ? `\n\nAgent: ${t.run.provider}, worktree \`${t.run.worktree}\`` : ""}`);
    item.iconPath = new vscode.ThemeIcon(s.icon, s.color ? new vscode.ThemeColor(s.color) : undefined);
    const agentReady = t.status === "ready" && t.run?.status === "finished" && !t.partners.length;
    const isOwner = this.conn?.me?.role === "owner";
    item.contextValue = agentReady ? (isOwner ? "task-apply" : "task-apply-denied") : "task";
    return item;
  }
}
