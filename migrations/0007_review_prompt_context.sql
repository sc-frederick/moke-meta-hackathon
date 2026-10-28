ALTER TABLE review_execution_runs ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'selected-finding-review-v1';
ALTER TABLE review_execution_runs ADD COLUMN review_context_json TEXT CHECK(review_context_json IS NULL OR json_valid(review_context_json));
