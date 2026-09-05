CREATE UNIQUE INDEX comment_watch_tasks_identity
  ON comment_watch_tasks(task_id, generation);

CREATE TABLE comment_watch_write_reservations (
  lease_id TEXT PRIMARY KEY,
  write_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  acquired_at TEXT NOT NULL,
  FOREIGN KEY(task_id, generation) REFERENCES comment_watch_tasks(task_id, generation)
);
