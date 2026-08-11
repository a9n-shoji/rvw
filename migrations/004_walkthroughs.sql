CREATE TABLE walkthroughs (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  source_oid TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) > 0),
  body TEXT NOT NULL CHECK(length(body) > 0),
  author_label TEXT,
  diagram_bindings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE walkthrough_references (
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(label) > 0),
  file_path TEXT NOT NULL CHECK(length(file_path) > 0),
  start_line INTEGER NOT NULL CHECK(start_line > 0),
  end_line INTEGER NOT NULL CHECK(end_line >= start_line),
  description TEXT,
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  PRIMARY KEY(walkthrough_id, reference_id)
);

CREATE INDEX walkthroughs_pull_request_created
  ON walkthroughs(pull_request_id, created_at DESC);
