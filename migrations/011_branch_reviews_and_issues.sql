CREATE TABLE branch_reviews (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL CHECK(host = 'github.com'),
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  local_repository_path TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  default_branch_name TEXT NOT NULL,
  source_oid TEXT NOT NULL,
  github_fetched_at TEXT NOT NULL,
  source_sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(host, owner, repository),
  UNIQUE(git_common_dir)
);

CREATE TABLE github_issues (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL CHECK(host = 'github.com'),
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  number INTEGER NOT NULL CHECK(number > 0),
  github_url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('OPEN', 'CLOSED')),
  github_updated_at TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  sync_error TEXT,
  UNIQUE(host, owner, repository, number)
);

CREATE TABLE review_issues (
  review_kind TEXT NOT NULL CHECK(review_kind IN ('pull-request', 'branch')),
  review_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES github_issues(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY(review_kind, review_id, issue_id)
);

CREATE INDEX review_issues_review ON review_issues(review_kind, review_id);

-- PR issue comments continue using the established comment lifecycle. This supplementary
-- target owns the Issue identity while the legacy target row remains available to old code.
CREATE TABLE pull_request_issue_comment_targets (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES github_issues(id),
  source_document_hash TEXT NOT NULL,
  quoted_text TEXT,
  start_line INTEGER,
  end_line INTEGER,
  CHECK(start_line IS NULL OR start_line >= 1),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK((start_line IS NULL AND end_line IS NULL AND quoted_text IS NULL)
    OR (start_line IS NOT NULL AND end_line IS NOT NULL AND quoted_text IS NOT NULL))
);

CREATE INDEX pull_request_issue_comment_targets_issue
  ON pull_request_issue_comment_targets(issue_id);

CREATE TABLE branch_walkthroughs (
  id TEXT PRIMARY KEY,
  branch_review_id TEXT NOT NULL REFERENCES branch_reviews(id) ON DELETE CASCADE,
  source_oid TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) > 0),
  body TEXT NOT NULL CHECK(length(body) > 0),
  author_label TEXT,
  diagram_bindings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE branch_walkthrough_references (
  walkthrough_id TEXT NOT NULL REFERENCES branch_walkthroughs(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(label) > 0),
  file_path TEXT NOT NULL CHECK(length(file_path) > 0),
  start_line INTEGER,
  end_line INTEGER,
  description TEXT,
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  CHECK(start_line IS NULL OR start_line > 0),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL)),
  PRIMARY KEY(walkthrough_id, reference_id)
);

CREATE INDEX branch_walkthroughs_review_created
  ON branch_walkthroughs(branch_review_id, created_at DESC);

CREATE TABLE branch_comments (
  id TEXT PRIMARY KEY,
  branch_review_id TEXT NOT NULL REFERENCES branch_reviews(id) ON DELETE CASCADE,
  created_source_oid TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE branch_comment_targets (
  comment_id TEXT PRIMARY KEY REFERENCES branch_comments(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('branch', 'repository_file', 'walkthrough', 'issue')),
  source_oid TEXT,
  file_path TEXT,
  source_document_hash TEXT,
  quoted_text TEXT,
  walkthrough_id TEXT REFERENCES branch_walkthroughs(id),
  issue_id TEXT REFERENCES github_issues(id),
  start_line INTEGER,
  end_line INTEGER,
  CHECK(start_line IS NULL OR start_line >= 1),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK(
    (target_kind = 'branch' AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND walkthrough_id IS NULL AND issue_id IS NULL AND start_line IS NULL AND end_line IS NULL)
    OR
    (target_kind = 'repository_file' AND source_oid IS NOT NULL AND file_path IS NOT NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND walkthrough_id IS NULL AND issue_id IS NULL)
    OR
    (target_kind = 'walkthrough' AND source_oid IS NULL AND file_path IS NULL AND walkthrough_id IS NOT NULL AND issue_id IS NULL
      AND ((start_line IS NULL AND end_line IS NULL AND quoted_text IS NULL)
        OR (start_line IS NOT NULL AND end_line IS NOT NULL AND source_document_hash IS NOT NULL AND quoted_text IS NOT NULL)))
    OR
    (target_kind = 'issue' AND source_oid IS NULL AND file_path IS NULL AND walkthrough_id IS NULL AND issue_id IS NOT NULL AND source_document_hash IS NOT NULL
      AND ((start_line IS NULL AND end_line IS NULL AND quoted_text IS NULL)
        OR (start_line IS NOT NULL AND end_line IS NOT NULL AND quoted_text IS NOT NULL)))
  ),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL))
);

CREATE TABLE branch_comment_posts (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES branch_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) > 0),
  related_commit_oid TEXT,
  author_label TEXT,
  is_root INTEGER NOT NULL CHECK(is_root IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE branch_comment_post_references (
  post_id TEXT NOT NULL REFERENCES branch_comment_posts(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(label) > 0),
  file_path TEXT NOT NULL CHECK(length(file_path) > 0),
  start_line INTEGER,
  end_line INTEGER,
  description TEXT,
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  CHECK(start_line IS NULL OR start_line > 0),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL)),
  PRIMARY KEY(post_id, reference_id)
);

CREATE TABLE branch_comment_reply_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX branch_comments_review_state_updated
  ON branch_comments(branch_review_id, resolved_at, updated_at);
CREATE INDEX branch_comment_posts_comment_created
  ON branch_comment_posts(comment_id, created_at);
CREATE UNIQUE INDEX branch_comment_posts_one_root
  ON branch_comment_posts(comment_id) WHERE is_root = 1;
CREATE INDEX branch_comment_targets_issue ON branch_comment_targets(issue_id);
CREATE INDEX branch_comment_targets_walkthrough ON branch_comment_targets(walkthrough_id);

-- One append-only sequence orders posts across both review kinds. Existing PR events keep their
-- original sequence; new PR and Branch events are written here after this migration.
CREATE TABLE review_comment_post_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL UNIQUE,
  comment_ref TEXT NOT NULL,
  review_kind TEXT NOT NULL CHECK(review_kind IN ('pull-request', 'branch')),
  context_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO review_comment_post_events(
  sequence, post_id, comment_ref, review_kind, context_key, created_at
)
SELECT sequence, post_id, comment_ref, 'pull-request', pull_request_url, created_at
FROM comment_post_events;

CREATE INDEX review_comment_post_events_context
  ON review_comment_post_events(review_kind, context_key, sequence);
