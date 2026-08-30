CREATE TABLE structure_publish_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  structure_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
