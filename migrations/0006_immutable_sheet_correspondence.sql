CREATE TABLE review_sheet_link_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES review_projects(id),
  old_sheet_id TEXT NOT NULL,
  new_sheet_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK(content IN ('changed','unchanged')),
  command_id TEXT,
  FOREIGN KEY(project_id,old_sheet_id) REFERENCES review_records(project_id,id),
  FOREIGN KEY(project_id,new_sheet_id) REFERENCES review_records(project_id,id)
);
INSERT INTO review_sheet_link_proposals(project_id,old_sheet_id,new_sheet_id,content)
SELECT project_id,old_sheet_id,new_sheet_id,content FROM review_sheet_links WHERE confirmed=0;
DELETE FROM review_sheet_links WHERE confirmed=0;
CREATE UNIQUE INDEX review_sheet_link_successor ON review_sheet_links(project_id,old_sheet_id);
CREATE UNIQUE INDEX review_sheet_link_predecessor ON review_sheet_links(project_id,new_sheet_id);
CREATE TRIGGER review_sheet_link_no_update BEFORE UPDATE ON review_sheet_links BEGIN SELECT RAISE(ABORT,'Sheet correspondence is immutable'); END;
CREATE TRIGGER review_sheet_link_no_delete BEFORE DELETE ON review_sheet_links BEGIN SELECT RAISE(ABORT,'Sheet correspondence is immutable'); END;
CREATE TRIGGER review_sheet_proposal_no_update BEFORE UPDATE ON review_sheet_link_proposals BEGIN SELECT RAISE(ABORT,'Sheet proposal history is immutable'); END;
CREATE TRIGGER review_sheet_proposal_no_delete BEFORE DELETE ON review_sheet_link_proposals BEGIN SELECT RAISE(ABORT,'Sheet proposal history is immutable'); END;
