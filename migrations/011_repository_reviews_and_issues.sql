CREATE TABLE repository_reviews (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL CHECK(host = 'github.com'),
  owner TEXT NOT NULL COLLATE NOCASE,
  repository TEXT NOT NULL COLLATE NOCASE,
  canonical_name TEXT NOT NULL,
  local_repository_path TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  default_branch_name TEXT NOT NULL,
  source_oid TEXT NOT NULL,
  github_fetched_at TEXT NOT NULL,
  source_sync_error TEXT,
  initialization_state TEXT NOT NULL CHECK(initialization_state IN ('pending', 'ready', 'failed')),
  source_sync_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(host, owner, repository),
  UNIQUE(git_common_dir)
);

CREATE TABLE github_issues (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL CHECK(host = 'github.com'),
  owner TEXT NOT NULL COLLATE NOCASE,
  repository TEXT NOT NULL COLLATE NOCASE,
  canonical_name TEXT NOT NULL,
  number INTEGER NOT NULL CHECK(number > 0),
  github_url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('OPEN', 'CLOSED')),
  github_updated_at TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  cache_generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE(host, owner, repository, number)
);

CREATE TABLE pull_request_issues (
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES github_issues(id),
  added_at TEXT NOT NULL,
  sync_error TEXT,
  PRIMARY KEY(pull_request_id, issue_id)
);

CREATE INDEX pull_request_issues_issue ON pull_request_issues(issue_id);

CREATE TABLE repository_review_issues (
  repository_review_id TEXT NOT NULL REFERENCES repository_reviews(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES github_issues(id),
  added_at TEXT NOT NULL,
  sync_error TEXT,
  PRIMARY KEY(repository_review_id, issue_id)
);

CREATE INDEX repository_review_issues_issue ON repository_review_issues(issue_id);

CREATE TABLE comment_targets_v5 (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('pull_request', 'document', 'walkthrough', 'issue')),
  document_kind TEXT CHECK(document_kind IN ('pull_request_markdown', 'repository_file')),
  source_oid TEXT,
  file_path TEXT,
  source_document_hash TEXT,
  quoted_text TEXT,
  walkthrough_id TEXT REFERENCES walkthroughs(id),
  issue_id TEXT REFERENCES github_issues(id),
  start_line INTEGER,
  end_line INTEGER,
  CHECK(start_line IS NULL OR start_line >= 1),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK(
    (target_kind = 'pull_request' AND document_kind IS NULL AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND walkthrough_id IS NULL AND issue_id IS NULL AND start_line IS NULL AND end_line IS NULL)
    OR
    (target_kind = 'document' AND document_kind = 'pull_request_markdown' AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NOT NULL AND walkthrough_id IS NULL AND issue_id IS NULL)
    OR
    (target_kind = 'document' AND document_kind = 'repository_file' AND source_oid IS NOT NULL AND file_path IS NOT NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND walkthrough_id IS NULL AND issue_id IS NULL)
    OR
    (
      target_kind = 'walkthrough' AND document_kind IS NULL AND source_oid IS NULL AND file_path IS NULL AND walkthrough_id IS NOT NULL AND issue_id IS NULL
      AND (
        (start_line IS NULL AND end_line IS NULL AND quoted_text IS NULL)
        OR
        (start_line IS NOT NULL AND end_line IS NOT NULL AND source_document_hash IS NOT NULL AND quoted_text IS NOT NULL)
      )
    )
    OR
    (
      target_kind = 'issue' AND document_kind IS NULL AND source_oid IS NULL AND file_path IS NULL AND walkthrough_id IS NULL AND issue_id IS NOT NULL AND source_document_hash IS NOT NULL
      AND (
        (start_line IS NULL AND end_line IS NULL AND quoted_text IS NULL)
        OR
        (start_line IS NOT NULL AND end_line IS NOT NULL AND quoted_text IS NOT NULL)
      )
    )
  ),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL))
);

INSERT INTO comment_targets_v5(
  comment_id, target_kind, document_kind, source_oid, file_path, source_document_hash,
  quoted_text, walkthrough_id, issue_id, start_line, end_line
)
SELECT
  comment_id, target_kind, document_kind, source_oid, file_path, source_document_hash,
  quoted_text, walkthrough_id, NULL, start_line, end_line
FROM comment_targets;

DROP TABLE comment_targets;
ALTER TABLE comment_targets_v5 RENAME TO comment_targets;

CREATE INDEX comment_targets_document ON comment_targets(document_kind, source_oid, file_path);
CREATE INDEX comment_targets_walkthrough ON comment_targets(walkthrough_id);
CREATE INDEX comment_targets_issue ON comment_targets(issue_id);

CREATE TABLE repository_walkthroughs (
  id TEXT PRIMARY KEY,
  repository_review_id TEXT NOT NULL REFERENCES repository_reviews(id) ON DELETE CASCADE,
  source_oid TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) > 0),
  body TEXT NOT NULL CHECK(length(body) > 0),
  author_label TEXT,
  diagram_bindings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE repository_walkthrough_references (
  walkthrough_id TEXT NOT NULL REFERENCES repository_walkthroughs(id) ON DELETE CASCADE,
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

CREATE INDEX repository_walkthroughs_review_created
  ON repository_walkthroughs(repository_review_id, created_at DESC);

CREATE TABLE repository_comments (
  id TEXT PRIMARY KEY,
  repository_review_id TEXT NOT NULL REFERENCES repository_reviews(id) ON DELETE CASCADE,
  created_source_oid TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repository_comment_targets (
  comment_id TEXT PRIMARY KEY REFERENCES repository_comments(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('repository', 'repository_file', 'walkthrough', 'issue')),
  source_oid TEXT,
  file_path TEXT,
  source_document_hash TEXT,
  quoted_text TEXT,
  walkthrough_id TEXT REFERENCES repository_walkthroughs(id),
  issue_id TEXT REFERENCES github_issues(id),
  start_line INTEGER,
  end_line INTEGER,
  CHECK(start_line IS NULL OR start_line >= 1),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK(
    (target_kind = 'repository' AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND walkthrough_id IS NULL AND issue_id IS NULL AND start_line IS NULL AND end_line IS NULL)
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

CREATE TABLE repository_comment_posts (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES repository_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) > 0),
  related_commit_oid TEXT,
  author_label TEXT,
  is_root INTEGER NOT NULL CHECK(is_root IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repository_comment_post_references (
  post_id TEXT NOT NULL REFERENCES repository_comment_posts(id) ON DELETE CASCADE,
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

CREATE INDEX repository_comments_review_state_updated
  ON repository_comments(repository_review_id, resolved_at, updated_at);
CREATE INDEX repository_comment_posts_comment_created
  ON repository_comment_posts(comment_id, created_at);
CREATE UNIQUE INDEX repository_comment_posts_one_root
  ON repository_comment_posts(comment_id) WHERE is_root = 1;
CREATE INDEX repository_comment_targets_issue ON repository_comment_targets(issue_id);
CREATE INDEX repository_comment_targets_walkthrough ON repository_comment_targets(walkthrough_id);

-- One append-only sequence orders posts across both review kinds. Existing PR events keep their
-- original sequence; new PR and Repository Review events are written here after this migration.
CREATE TABLE review_comment_post_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL UNIQUE,
  comment_ref TEXT NOT NULL,
  review_kind TEXT NOT NULL CHECK(review_kind IN ('pull-request', 'repository')),
  review_id TEXT NOT NULL,
  pull_request_url TEXT,
  repository TEXT,
  created_at TEXT NOT NULL,
  CHECK(
    (review_kind = 'pull-request' AND pull_request_url IS NOT NULL AND repository IS NULL)
    OR (review_kind = 'repository' AND pull_request_url IS NULL AND repository IS NOT NULL)
  )
);

INSERT INTO review_comment_post_events(
  sequence, post_id, comment_ref, review_kind, review_id, pull_request_url, repository, created_at
)
SELECT e.sequence, e.post_id, e.comment_ref, 'pull-request', pr.id, e.pull_request_url, NULL, e.created_at
FROM comment_post_events e
LEFT JOIN pull_requests pr ON pr.github_url = e.pull_request_url;

DROP TABLE comment_post_events;

CREATE INDEX review_comment_post_events_context
  ON review_comment_post_events(review_kind, review_id, sequence);
