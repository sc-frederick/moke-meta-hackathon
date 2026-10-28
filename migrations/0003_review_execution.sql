CREATE TABLE review_execution_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  journal_id TEXT NOT NULL UNIQUE,
  engine TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version >= 0),
  fact_version INTEGER NOT NULL CHECK(fact_version >= 0),
  state TEXT NOT NULL CHECK(state IN ('running','pausing','paused','cancelled','completed','failed','uncertain','incompatible')),
  version INTEGER NOT NULL CHECK(version >= 0),
  route TEXT NOT NULL CHECK(route IN ('offline','recorded','live')),
  provider TEXT NOT NULL CHECK(provider IN ('meta','baseten')),
  model TEXT NOT NULL,
  max_calls INTEGER NOT NULL CHECK(max_calls BETWEEN 1 AND 20),
  max_input_tokens INTEGER NOT NULL CHECK(max_input_tokens BETWEEN 256 AND 64000),
  max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens BETWEEN 16 AND 8192),
  admitted_calls INTEGER NOT NULL DEFAULT 0,
  reserved_input_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_output_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX review_execution_selection ON review_execution_runs(project_id, finding_id);
CREATE TABLE review_execution_attempts (
  journal_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES review_execution_runs(run_id),
  owner_generation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uncertain','completed')),
  sent INTEGER NOT NULL CHECK(sent IN (0,1)),
  response_json TEXT,
  PRIMARY KEY(journal_id, task_id, attempt),
  CHECK((status='completed' AND response_json IS NOT NULL) OR status='uncertain')
);
CREATE TABLE review_execution_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES review_execution_runs(run_id),
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX review_execution_event_cursor ON review_execution_events(project_id, sequence);
