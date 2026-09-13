ALTER TABLE walkthroughs
  ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE walkthroughs
SET updated_at = created_at;
