CREATE TABLE walkthrough_references_v2 (
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(label) > 0),
  file_path TEXT NOT NULL CHECK(length(file_path) > 0),
  start_line INTEGER,
  end_line INTEGER,
  description TEXT,
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  CHECK(start_line IS NULL OR start_line > 0),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL)),
  PRIMARY KEY(walkthrough_id, reference_id)
);

INSERT INTO walkthrough_references_v2(
  walkthrough_id, reference_id, label, file_path, start_line, end_line, description, sort_order
)
SELECT
  walkthrough_id, reference_id, label, file_path, start_line, end_line, description, sort_order
FROM walkthrough_references;

DROP TABLE walkthrough_references;
ALTER TABLE walkthrough_references_v2 RENAME TO walkthrough_references;
