import type { DatabaseSync } from "node:sqlite";
import type { Relay } from "../core/engine.ts";
import { changeRecord } from "../analysis/change.ts";
import type { AgentRun } from "./runs.ts";

/**
 * Automatic rechecks: when the project has been quiet for a while after people changed files, a person's task under
 * review whose recorded checks no longer describe its files gets its checks run again, so the "tested" stage is
 * current without anyone remembering to click. It runs project code on the server's machine, so it is off until an
 * owner turns it on. One recheck at a time; agent work is left alone (Apply re-checks it on the current project).
 */
export class AutoRecheck {
  private relay: Relay;
  private root: string;
  private dbPath: string;
  private db: DatabaseSync;
  private runsFor: (id: string) => AgentRun[];
  private check: (taskId: string) => Promise<void>;
  private quietMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private closed = false;

  constructor(o: { relay: Relay; root: string; dbPath: string; runsFor: (id: string) => AgentRun[]; check: (taskId: string) => Promise<void>; quietMs?: number }) {
    this.relay = o.relay;
    this.root = o.root;
    this.dbPath = o.dbPath;
    this.db = o.relay.db;
    this.runsFor = o.runsFor;
    this.check = o.check;
    this.quietMs = o.quietMs ?? 20_000;
    this.db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  get enabled(): boolean {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'autoRecheck'").get() as { value: string } | undefined)?.value === "on";
  }

  setEnabled(on: boolean): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('autoRecheck', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? "on" : "off");
    if (!on) clearTimeout(this.timer);
  }

  /** A file changed: (re)start the quiet period. */
  touched(): void {
    if (this.closed || !this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.quietMs);
  }

  /** Person tasks under review whose tested stage is out of date. */
  due(): string[] {
    return this.relay
      .listTasks()
      .filter((t) => t.state === "review_required" && t.verify.length && !this.runsFor(t.id).some((r) => r.status !== "applied"))
      .filter((t) => changeRecord(this.relay, this.root, this.dbPath, t.id, { runs: this.runsFor(t.id) }).stages.find((s) => s.id === "tested")?.state === "stale")
      .map((t) => t.id);
  }

  private async run(): Promise<void> {
    if (this.running || this.closed || !this.enabled) return;
    this.running = true;
    try {
      for (const id of this.due()) {
        if (this.closed) return;
        this.relay.record("task.auto_recheck", "system:auto-recheck", { reason: "files changed since its checks ran" }, id);
        await this.check(id);
      }
    } finally {
      this.running = false;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
