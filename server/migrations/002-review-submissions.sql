CREATE TABLE IF NOT EXISTS review_submissions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS review_submissions_project ON review_submissions(project_id);
PRAGMA user_version=2;
