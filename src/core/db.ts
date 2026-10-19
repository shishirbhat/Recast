import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  state TEXT NOT NULL,
  owner TEXT,
  agent TEXT,
  scope TEXT NOT NULL,          -- JSON string[]
  contracts TEXT NOT NULL,      -- JSON {contractId: version}
  prerequisites TEXT NOT NULL,  -- JSON string[]
  verify TEXT NOT NULL,         -- JSON string[]
  base_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  status TEXT NOT NULL,
  author TEXT NOT NULL,
  approved_by TEXT,
  rationale TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  files TEXT NOT NULL,
  contracts TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  command TEXT,
  exit_code INTEGER,
  output TEXT NOT NULL,
  source TEXT NOT NULL,
  verified INTEGER NOT NULL,
  environment TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Append-only. Nothing updates or deletes rows here.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  data TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  // Bounded lock wait: a hook must answer inside its deadline rather than hang on a busy database.
  db.exec("PRAGMA busy_timeout = 1500;");
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE so concurrent writers serialize instead of interleaving reads and writes. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
