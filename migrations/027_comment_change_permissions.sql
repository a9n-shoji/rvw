ALTER TABLE comment_posts ADD COLUMN allow_changes INTEGER NOT NULL DEFAULT 0 CHECK(allow_changes IN (0, 1));

-- Permission changes are new events for an existing post; preserve every old cursor.
ALTER TABLE comment_post_events RENAME TO old_comment_post_events;
CREATE TABLE comment_post_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  comment_ref TEXT NOT NULL,
  pull_request_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  allow_changes INTEGER NOT NULL DEFAULT 0 CHECK(allow_changes IN (0, 1)),
  kind TEXT NOT NULL DEFAULT 'posted' CHECK(kind IN ('posted', 'permission-changed'))
);
INSERT INTO comment_post_events(sequence, post_id, comment_ref, pull_request_url, created_at)
  SELECT sequence, post_id, comment_ref, pull_request_url, created_at FROM old_comment_post_events;
DROP TABLE old_comment_post_events;
CREATE INDEX comment_post_events_pull_request ON comment_post_events(pull_request_url, sequence);
CREATE INDEX comment_post_events_post ON comment_post_events(post_id);
