CREATE TABLE review_sam_attempts (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES review_execution_runs(run_id),
  project_id TEXT NOT NULL REFERENCES review_projects(id),
  finding_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version >= 0),
  fact_version INTEGER NOT NULL CHECK(fact_version >= 0),
  input_fingerprint TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  status TEXT NOT NULL CHECK(status IN ('uncertain','completed')),
  sent INTEGER NOT NULL CHECK(sent IN (0,1)),
  response_id TEXT,
  response_status INTEGER,
  response_body TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  FOREIGN KEY(project_id, finding_id) REFERENCES review_records(project_id,id),
  FOREIGN KEY(project_id, source_artifact_id) REFERENCES review_records(project_id,id),
  CHECK(status != 'completed' OR (sent=1 AND response_id IS NOT NULL AND response_body IS NOT NULL AND result_json IS NOT NULL))
);
CREATE INDEX review_sam_by_run ON review_sam_attempts(run_id,status);
CREATE INDEX review_sam_by_project ON review_sam_attempts(project_id);
