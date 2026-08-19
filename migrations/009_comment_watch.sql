ALTER TABLE pull_requests
  ADD COLUMN latest_author_login TEXT;

ALTER TABLE pull_requests
  ADD COLUMN latest_head_repository_owner TEXT;

ALTER TABLE pull_requests
  ADD COLUMN latest_head_repository_name TEXT;

CREATE TABLE comment_reply_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE comment_post_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL UNIQUE,
  comment_ref TEXT NOT NULL,
  pull_request_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX comment_post_events_pull_request
  ON comment_post_events(pull_request_url, sequence);

INSERT INTO app_meta(key, value)
VALUES ('comment_watch_database_id', lower(hex(randomblob(16))))
ON CONFLICT(key) DO NOTHING;
