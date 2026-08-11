ALTER TABLE pull_requests
  ADD COLUMN latest_comparison_base_oid TEXT NOT NULL DEFAULT '';

UPDATE pull_requests
SET latest_comparison_base_oid = COALESCE(
  (
    SELECT comparison_base_oid
    FROM review_versions
    WHERE review_versions.pull_request_id = pull_requests.id
    ORDER BY sequence DESC
    LIMIT 1
  ),
  latest_base_oid
);

CREATE TABLE comments_v2 (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  created_head_oid TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO comments_v2(
  id, pull_request_id, created_head_oid, resolved_at, created_at, updated_at
)
SELECT
  comments.id,
  comments.pull_request_id,
  review_versions.head_oid,
  comments.resolved_at,
  comments.created_at,
  comments.updated_at
FROM comments
JOIN review_versions ON review_versions.id = comments.created_review_version_id;

CREATE TABLE comment_targets_v2 (
  comment_id TEXT PRIMARY KEY REFERENCES comments_v2(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('pull_request', 'document')),
  document_kind TEXT CHECK(document_kind IN ('pull_request_markdown', 'repository_file')),
  source_oid TEXT,
  file_path TEXT,
  source_document_hash TEXT,
  quoted_text TEXT,
  start_line INTEGER,
  end_line INTEGER,
  CHECK(start_line IS NULL OR start_line >= 1),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK(
    (target_kind = 'pull_request' AND document_kind IS NULL AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND start_line IS NULL AND end_line IS NULL)
    OR
    (target_kind = 'document' AND document_kind = 'pull_request_markdown' AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NOT NULL)
    OR
    (target_kind = 'document' AND document_kind = 'repository_file' AND source_oid IS NOT NULL AND file_path IS NOT NULL AND source_document_hash IS NULL AND quoted_text IS NULL)
  ),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL))
);

INSERT INTO comment_targets_v2(
  comment_id,
  target_kind,
  document_kind,
  source_oid,
  file_path,
  source_document_hash,
  quoted_text,
  start_line,
  end_line
)
SELECT
  comment_id,
  target_kind,
  document_kind,
  source_oid,
  file_path,
  CASE
    WHEN document_kind = 'pull_request_markdown'
      THEN 'legacy:' || document_review_version_id
    ELSE NULL
  END,
  NULL,
  start_line,
  end_line
FROM comment_targets;

CREATE TABLE comment_posts_v2 (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments_v2(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) > 0),
  related_commit_oid TEXT,
  author_label TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO comment_posts_v2(
  id, comment_id, body, related_commit_oid, author_label, created_at
)
SELECT
  comment_posts.id,
  comment_posts.comment_id,
  comment_posts.body,
  review_versions.head_oid,
  comment_posts.author_label,
  comment_posts.created_at
FROM comment_posts
LEFT JOIN review_versions ON review_versions.id = comment_posts.related_review_version_id;

DROP TABLE comment_posts;
DROP TABLE comment_targets;
DROP TABLE comments;
DROP TABLE review_versions;

ALTER TABLE comments_v2 RENAME TO comments;
ALTER TABLE comment_targets_v2 RENAME TO comment_targets;
ALTER TABLE comment_posts_v2 RENAME TO comment_posts;

CREATE INDEX comments_pr_state_updated ON comments(pull_request_id, resolved_at, updated_at);
CREATE INDEX comment_posts_comment_created ON comment_posts(comment_id, created_at);
CREATE INDEX comment_targets_document ON comment_targets(document_kind, source_oid, file_path);
