import * as vscode from "vscode";
import { RelayError } from "./connection.ts";
import type { Connection } from "./connection.ts";
import type { CoordTask } from "./coordination.ts";

/**
 * Check Together: ask the Relay server to rehearse several tasks' changes as one combined change and show its result.
 * The server does all of it (combining, verifying, explaining, recording); this only picks the tasks and shows what
 * came back. It is a check, never an apply: a passing result still needs an owner's approval, through the server's
 * own approval endpoint, which refuses if anything moved since the check.
 */

/** The result the server returns: its stored integration record, plus the report every client prints verbatim. */
export interface CheckResult {
  id: string;
  tasks: string[];
  status: "blocked" | "passed" | "approved";
  gaps: string[];
  baseCommit: string | null;
  tree: string;
  explanation: { verdict: "confirmed" | "likely" | "unknown"; summary: string } | null;
  report: string;
}

/** What the person is told afterwards, and which follow-up actions they're offered. */
export interface Outcome {
  severity: "error" | "info";
  message: string;
  actions: string[];
}

export const SHOW_REPORT = "Show Report";
export const APPROVE = "Approve and Apply…";
export const showTask = (id: string) => `Show ${id}`;

// Work that is finished but not yet in the project: the only tasks worth checking together.
const NOT_PENDING = new Set(["proposed", "waiting", "queued", "running", "stopped", "failed", "cancelled", "done"]);

export function pendingTasks(tasks: readonly CoordTask[]): CoordTask[] {
  return tasks.filter((t) => !NOT_PENDING.has(t.status));
}

/** Preselection for the picker: what was selected in the view, plus the contract partners it must integrate with. */
export function preselected(selected: readonly CoordTask[], pending: readonly CoordTask[]): string[] {
  const ids = new Set(selected.map((t) => t.id));
  for (const t of selected) for (const p of t.partners) ids.add(p);
  return pending.filter((t) => ids.has(t.id)).map((t) => t.id);
}

export function outcome(r: CheckResult, isOwner: boolean): Outcome {
  const tasks = r.tasks.join(" + ");
  if (r.status === "passed")
    return {
      severity: "info",
      message: `Relay checked ${tasks} together: the combined verification passed. Nothing has been applied${isOwner ? "" : "; a project owner must approve it"}.`,
      actions: [...(isOwner ? [APPROVE] : []), SHOW_REPORT],
    };
  const why = r.explanation ? `${r.explanation.verdict === "confirmed" ? "" : `(${r.explanation.verdict}) `}${firstSentences(r.explanation.summary)}` : r.gaps.join("; ");
  return { severity: "error", message: `Relay blocked ${tasks}. ${why} Nothing was applied.`, actions: [SHOW_REPORT, ...r.tasks.map(showTask)] };
}

function firstSentences(s: string): string {
  return s.replace(/ Relay blocked integration because combined verification failed\.$/, "");
}

/** A failed request, in words a developer can act on. Nothing was applied in any of these cases. */
export function failureMessage(e: unknown, tasks: readonly string[]): string {
  const what = tasks.join(" + ");
  if (e instanceof RelayError) {
    if (e.status === 401) return `Your Relay session ended. Join the project again, then check ${what} together.`;
    if (e.status === 403) return `You can't check ${what} together: ${e.message}`;
    if (e.status === 404) return `Couldn't check ${what} together: ${e.message}. Refresh the Coordination view; the task may have been removed.`;
    return `Relay didn't check ${what} together: ${e.message}`;
  }
  return `The check of ${what} didn't finish (${(e as Error).message}). Nothing was applied; check together again once Relay is reachable.`;
}

export class CheckTogether {
  readonly channel = vscode.window.createOutputChannel("Relay: Check Together");
  /** The latest result and what the person was offered, for the view and for tests. */
  last: { result: CheckResult; outcome: Outcome } | null = null;

  constructor(
    private conn: () => Connection | null,
    private reveal: (taskId: string) => Promise<void>,
    private refresh: () => Promise<void>,
  ) {}

  dispose(): void {
    this.channel.dispose();
  }

  /** Let the person choose the tasks: the view's selection and its contract partners come preselected. */
  async pick(all: readonly CoordTask[], selected: readonly CoordTask[]): Promise<string[] | undefined> {
    const pending = pendingTasks(all);
    if (pending.length < 2) throw new Error("Check Together needs at least two tasks with finished work that isn't in the project yet.");
    const pre = new Set(preselected(selected, pending));
    const items = pending.map((t) => ({ label: t.id, description: t.objective, detail: `${t.run ? `agent work (${t.run.provider})` : "work in the shared project"}${t.partners.length ? ` · shares a contract with ${t.partners.join(", ")}` : ""}`, picked: pre.has(t.id) }));
    const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: "Relay: Check Together", placeHolder: "Choose the tasks to check as one combined change (nothing is applied)" });
    if (!chosen) return undefined;
    if (chosen.length < 2) throw new Error("Choose at least two tasks to check together.");
    return chosen.map((c) => c.label);
  }

  /** Run the rehearsal on the server and show its result. Returns the result, or null if it couldn't run. */
  async run(taskIds: string[]): Promise<CheckResult | null> {
    const conn = this.conn();
    if (!conn) throw new Error("Join a Relay project first.");
    const what = taskIds.join(" + ");
    let result: CheckResult;
    try {
      result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Relay: checking ${what} together`, cancellable: false }, async (p) => {
        p.report({ message: "running the combined verification…" });
        return conn.request<CheckResult>("POST", "/integrations/check", { tasks: taskIds });
      });
    } catch (e) {
      const message = failureMessage(e, taskIds);
      this.last = null;
      void vscode.window.showErrorMessage(message);
      return null;
    }
    this.channel.clear();
    this.channel.appendLine(result.report);
    const out = outcome(result, conn.me?.role === "owner");
    this.last = { result, outcome: out };
    await this.refresh();
    void this.offer(out, result);
    return result;
  }

  private async offer(out: Outcome, result: CheckResult): Promise<void> {
    const show = out.severity === "error" ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
    const pick = await show(out.message, ...out.actions);
    if (pick === SHOW_REPORT) this.channel.show(true);
    else if (pick === APPROVE) await this.approve(result);
    else if (pick?.startsWith("Show ")) await this.reveal(pick.slice(5));
  }

  /** The existing approval flow: asks first, then the server re-checks everything moved since and applies. */
  async approve(result: CheckResult): Promise<void> {
    const conn = this.conn();
    if (!conn) return;
    const go = "Approve and Apply";
    const pick = await vscode.window.showWarningMessage(
      `Apply ${result.tasks.join(" + ")} to the shared project?`,
      { modal: true, detail: "Relay applies exactly the combined change it checked. If the project, a task or a contract changed since, it refuses and you check together again." },
      go,
    );
    if (pick !== go) return;
    try {
      const r = await conn.request<{ applied: string[]; conflicts: { path: string }[] }>("POST", `/integrations/${encodeURIComponent(result.id)}/approve`);
      if (r.conflicts.length) void vscode.window.showErrorMessage(`Not applied: ${r.conflicts.map((c) => c.path).join(", ")} changed in the shared project in a way that conflicts.`);
      else void vscode.window.showInformationMessage(`Applied ${result.tasks.join(" + ")}: ${r.applied.length} ${r.applied.length === 1 ? "file" : "files"}.`);
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof RelayError && e.status === 409 ? `Not applied: ${e.message}` : failureMessage(e, result.tasks));
    }
    await this.refresh();
  }
}
