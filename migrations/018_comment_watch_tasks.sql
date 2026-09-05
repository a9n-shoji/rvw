CREATE TABLE comment_watch_tasks (
  task_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK(generation >= 1),
  activated_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE UNIQUE INDEX comment_watch_tasks_single_active
  ON comment_watch_tasks((1))
  WHERE superseded_at IS NULL;
