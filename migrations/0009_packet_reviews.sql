CREATE TABLE packet_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES review_projects(id),
  conversation_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  owner_generation TEXT NOT NULL,
  journal_id TEXT NOT NULL UNIQUE,
  engine TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX packet_reviews_conversation ON packet_reviews(project_id,conversation_id);
CREATE TABLE packet_review_attempts (
  review_id TEXT NOT NULL REFERENCES packet_reviews(id),
  task_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('model','sam')),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uncertain','completed')),
  sent INTEGER NOT NULL CHECK(sent IN (0,1)),
  response_json TEXT,
  PRIMARY KEY(review_id,task_id,attempt,kind)
);
CREATE TABLE packet_review_tools (
  review_id TEXT NOT NULL REFERENCES packet_reviews(id),
  task_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  PRIMARY KEY(review_id,task_id,operation)
);
