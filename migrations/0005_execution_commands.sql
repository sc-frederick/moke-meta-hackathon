CREATE TABLE review_execution_commands (
  command_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES review_execution_runs(run_id),
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json))
);
CREATE TABLE review_execution_acknowledgements (
  run_id TEXT PRIMARY KEY REFERENCES review_execution_runs(run_id),
  command_id TEXT NOT NULL UNIQUE REFERENCES review_execution_commands(command_id),
  acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  possible_charge_acknowledged INTEGER NOT NULL CHECK(possible_charge_acknowledged=1)
);
