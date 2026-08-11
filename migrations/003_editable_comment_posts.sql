CREATE TABLE comment_posts_v3 (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) > 0),
  related_commit_oid TEXT,
  author_label TEXT,
  is_root INTEGER NOT NULL CHECK(is_root IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO comment_posts_v3(
  id, comment_id, body, related_commit_oid, author_label, is_root, created_at, updated_at
)
SELECT
  posts.id,
  posts.comment_id,
  posts.body,
  posts.related_commit_oid,
  posts.author_label,
  CASE WHEN posts.id = (
    SELECT root.id
    FROM comment_posts AS root
    WHERE root.comment_id = posts.comment_id
    ORDER BY root.created_at ASC, root.id ASC
    LIMIT 1
  ) THEN 1 ELSE 0 END,
  posts.created_at,
  posts.created_at
FROM comment_posts AS posts;

DROP TABLE comment_posts;
ALTER TABLE comment_posts_v3 RENAME TO comment_posts;

CREATE INDEX comment_posts_comment_created ON comment_posts(comment_id, created_at);
CREATE UNIQUE INDEX comment_posts_one_root ON comment_posts(comment_id) WHERE is_root = 1;
