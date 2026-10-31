CREATE TABLE review_render_operations (
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  render_identity TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  FOREIGN KEY (project_id, artifact_id) REFERENCES review_records(project_id, id)
);

CREATE INDEX review_render_operations_by_identity
  ON review_render_operations(project_id, sheet_id, render_identity);

-- Earlier renders keep their operation receipts. Their rasterizer is unrecorded, so 'legacy'
-- never matches a render identity and those images are not reused for new operations.
INSERT OR IGNORE INTO review_render_operations
  (project_id, operation_id, sheet_id, render_identity, artifact_id)
SELECT project_id, json_extract(payload, '$.operationId'), json_extract(payload, '$.sheetId'),
  'legacy', id
FROM review_records
WHERE kind = 'artifact'
  AND json_extract(payload, '$.operationId') IS NOT NULL
  AND json_extract(payload, '$.sheetId') IS NOT NULL
ORDER BY rowid;
