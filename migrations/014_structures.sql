CREATE TABLE structures (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  source_oid TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) > 0),
  scope TEXT NOT NULL CHECK(length(scope) > 0),
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX structures_pull_request_created
  ON structures(pull_request_id, created_at DESC, id DESC);
