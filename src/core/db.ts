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

-- One check of a set of tasks integrated together. status: blocked | passed | approved.
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  tasks TEXT NOT NULL,          -- JSON string[]
  base_commit TEXT,
  tree TEXT NOT NULL,           -- workspace tree hash the check ran against
  contracts TEXT NOT NULL,      -- JSON {contractId: version} the tasks agreed on
  status TEXT NOT NULL,
  gaps TEXT NOT NULL,           -- JSON string[]
  results TEXT NOT NULL,        -- JSON [{command, exitCode, output}]
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);

-- Project members for the IDE. Tokens are stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,           -- owner | editor | viewer
  color TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Collaborative documents: an append-only Yjs update log per document, compacted periodically.
CREATE TABLE IF NOT EXISTS doc_updates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_updates_doc ON doc_updates(doc, seq);
-- Load-time snapshots: the document's full state as of upto_seq. The update log itself is kept as history.
CREATE TABLE IF NOT EXISTS doc_snapshots (
  doc TEXT NOT NULL,
  upto_seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc, upto_seq)
);
-- Which participant (or server origin) owns each Yjs client ID in a document. Every surviving character carries one.
CREATE TABLE IF NOT EXISTS doc_clients (
  doc TEXT NOT NULL,
  client_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc, client_id)
);
-- Edit sessions: consecutive edits by one author in one document (gaps under 5 minutes), with what they inserted and deleted.
CREATE TABLE IF NOT EXISTS doc_sessions (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  author TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  base_seq INTEGER NOT NULL,
  inserted INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  ws_inserted INTEGER NOT NULL,
  ws_deleted INTEGER NOT NULL,
  edits INTEGER NOT NULL,
  line_min INTEGER,
  line_max INTEGER,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS doc_sessions_author ON doc_sessions(author, started_at);
CREATE INDEX IF NOT EXISTS doc_sessions_doc ON doc_sessions(doc, started_at);
-- What the server last wrote to disk for each document, to tell its own writes from external ones.
CREATE TABLE IF NOT EXISTS doc_files (
  doc TEXT PRIMARY KEY,
  last_written TEXT NOT NULL,
  written_at TEXT NOT NULL
);
-- External disk changes that could not be merged cleanly. The disk version is kept here, never dropped.
CREATE TABLE IF NOT EXISTS doc_conflicts (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  base TEXT NOT NULL,
  ours TEXT NOT NULL,
  theirs TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
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
