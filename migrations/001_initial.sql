CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_meta(key, value) VALUES ('change_sequence', '0');

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  github_url TEXT NOT NULL,
  local_repository_path TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  latest_title TEXT NOT NULL,
  latest_body TEXT NOT NULL,
  latest_base_ref_name TEXT NOT NULL,
  latest_head_ref_name TEXT NOT NULL,
  latest_base_oid TEXT NOT NULL,
  latest_head_oid TEXT NOT NULL,
  github_updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(host, owner, repository, number)
);

CREATE TABLE review_versions (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  previous_review_version_id TEXT REFERENCES review_versions(id),
  base_tip_oid TEXT NOT NULL,
  comparison_base_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  comparison_base_git_ref TEXT NOT NULL,
  head_git_ref TEXT NOT NULL,
  pr_title TEXT NOT NULL,
  pr_body TEXT NOT NULL,
  pr_markdown TEXT NOT NULL,
  pr_markdown_format_version INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE(pull_request_id, sequence)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  created_review_version_id TEXT NOT NULL REFERENCES review_versions(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE comment_targets (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('pull_request', 'document')),
  document_kind TEXT CHECK(document_kind IN ('pull_request_markdown', 'repository_file')),
  document_review_version_id TEXT REFERENCES review_versions(id),
  source_oid TEXT,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  CHECK(start_line IS NULL OR start_line >= 1),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK(
    (target_kind = 'pull_request' AND document_kind IS NULL AND document_review_version_id IS NULL AND source_oid IS NULL AND file_path IS NULL AND start_line IS NULL AND end_line IS NULL)
    OR
    (target_kind = 'document' AND document_kind = 'pull_request_markdown' AND document_review_version_id IS NOT NULL AND source_oid IS NULL AND file_path IS NULL)
    OR
    (target_kind = 'document' AND document_kind = 'repository_file' AND document_review_version_id IS NOT NULL AND source_oid IS NOT NULL AND file_path IS NOT NULL)
  ),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL))
);

CREATE TABLE comment_posts (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) > 0),
  related_review_version_id TEXT REFERENCES review_versions(id),
  author_label TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX review_versions_pr_sequence ON review_versions(pull_request_id, sequence);
CREATE INDEX comments_pr_state_updated ON comments(pull_request_id, resolved_at, updated_at);
CREATE INDEX comment_posts_comment_created ON comment_posts(comment_id, created_at);
CREATE INDEX comment_targets_document ON comment_targets(document_review_version_id, file_path);
