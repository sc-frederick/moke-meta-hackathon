CREATE TABLE review_sheet_dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES review_projects(id),
  revision_id TEXT NOT NULL,
  old_sheet_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('removed','unresolved')),
  command_id TEXT NOT NULL,
  UNIQUE(command_id,old_sheet_id),
  FOREIGN KEY(project_id,revision_id) REFERENCES review_records(project_id,id),
  FOREIGN KEY(project_id,old_sheet_id) REFERENCES review_records(project_id,id)
);
CREATE TRIGGER review_sheet_disposition_no_update BEFORE UPDATE ON review_sheet_dispositions BEGIN SELECT RAISE(ABORT,'Sheet disposition history is immutable'); END;
CREATE TRIGGER review_sheet_disposition_no_delete BEFORE DELETE ON review_sheet_dispositions BEGIN SELECT RAISE(ABORT,'Sheet disposition history is immutable'); END;
