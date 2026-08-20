CREATE TABLE comment_post_references (
  post_id TEXT NOT NULL REFERENCES comment_posts(id) ON DELETE CASCADE,
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
  PRIMARY KEY(post_id, reference_id)
);

CREATE INDEX comment_post_references_post_order
  ON comment_post_references(post_id, sort_order);
