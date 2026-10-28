CREATE TABLE review_projects (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 0),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);

CREATE TABLE review_records (
  project_id TEXT NOT NULL REFERENCES review_projects(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('revision','sheet','artifact','finding','fact','check','conversation','message')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (project_id, id),
  UNIQUE (id),
  CHECK (json_extract(payload, '$.projectId') = project_id),
  CHECK (json_extract(payload, '$.id') = id)
);

CREATE TABLE review_fact_versions (
  project_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('drawn','scheduled')),
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (project_id, finding_id, side, version),
  FOREIGN KEY (project_id, fact_id) REFERENCES review_records(project_id,id),
  FOREIGN KEY (project_id, finding_id) REFERENCES review_records(project_id,id)
);

CREATE TABLE review_dependencies (
  project_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  dependent_id TEXT NOT NULL,
  PRIMARY KEY (project_id,input_id,dependent_id),
  FOREIGN KEY (project_id,input_id) REFERENCES review_records(project_id,id),
  FOREIGN KEY (project_id,dependent_id) REFERENCES review_records(project_id,id)
);

CREATE TABLE review_commands (
  command_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES review_projects(id),
  fingerprint TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK (json_valid(receipt))
);

CREATE TABLE review_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES review_projects(id),
  command_id TEXT NOT NULL REFERENCES review_commands(command_id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX review_records_by_kind ON review_records(project_id,kind);
CREATE INDEX review_dependencies_by_input ON review_dependencies(project_id,input_id);
CREATE INDEX review_events_by_project ON review_events(project_id,sequence);

CREATE TABLE review_sheet_links (
  project_id TEXT NOT NULL,
  old_sheet_id TEXT NOT NULL,
  new_sheet_id TEXT NOT NULL,
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0,1)),
  content TEXT NOT NULL CHECK (content IN ('changed','unchanged')),
  PRIMARY KEY (project_id,old_sheet_id,new_sheet_id),
  FOREIGN KEY (project_id,old_sheet_id) REFERENCES review_records(project_id,id),
  FOREIGN KEY (project_id,new_sheet_id) REFERENCES review_records(project_id,id)
);
