CREATE TABLE firm_checklist_revisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL CHECK(length(text) <= 12000),
  saved_at INTEGER NOT NULL
);
CREATE TRIGGER firm_checklist_no_update BEFORE UPDATE ON firm_checklist_revisions BEGIN SELECT RAISE(ABORT,'Firm checklist history is immutable'); END;
CREATE TRIGGER firm_checklist_no_delete BEFORE DELETE ON firm_checklist_revisions BEGIN SELECT RAISE(ABORT,'Firm checklist history is immutable'); END;
