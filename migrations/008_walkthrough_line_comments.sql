CREATE TABLE comment_targets_v4 (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('pull_request', 'document', 'walkthrough')),
  document_kind TEXT CHECK(document_kind IN ('pull_request_markdown', 'repository_file')),
  source_oid TEXT,
  file_path TEXT,
  source_document_hash TEXT,
  quoted_text TEXT,
  walkthrough_id TEXT REFERENCES walkthroughs(id),
  start_line INTEGER,
  end_line INTEGER,
  CHECK(start_line IS NULL OR start_line >= 1),
  CHECK(end_line IS NULL OR end_line >= start_line),
  CHECK(
    (target_kind = 'pull_request' AND document_kind IS NULL AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND walkthrough_id IS NULL AND start_line IS NULL AND end_line IS NULL)
    OR
    (target_kind = 'document' AND document_kind = 'pull_request_markdown' AND source_oid IS NULL AND file_path IS NULL AND source_document_hash IS NOT NULL AND walkthrough_id IS NULL)
    OR
    (target_kind = 'document' AND document_kind = 'repository_file' AND source_oid IS NOT NULL AND file_path IS NOT NULL AND source_document_hash IS NULL AND quoted_text IS NULL AND walkthrough_id IS NULL)
    OR
    (
      target_kind = 'walkthrough' AND document_kind IS NULL AND source_oid IS NULL AND file_path IS NULL AND walkthrough_id IS NOT NULL
      AND (
        (start_line IS NULL AND end_line IS NULL AND quoted_text IS NULL)
        OR
        (start_line IS NOT NULL AND end_line IS NOT NULL AND source_document_hash IS NOT NULL AND quoted_text IS NOT NULL)
      )
    )
  ),
  CHECK((start_line IS NULL AND end_line IS NULL) OR (start_line IS NOT NULL AND end_line IS NOT NULL))
);

INSERT INTO comment_targets_v4(
  comment_id,
  target_kind,
  document_kind,
  source_oid,
  file_path,
  source_document_hash,
  quoted_text,
  walkthrough_id,
  start_line,
  end_line
)
SELECT
  comment_id,
  target_kind,
  document_kind,
  source_oid,
  file_path,
  source_document_hash,
  quoted_text,
  walkthrough_id,
  start_line,
  end_line
FROM comment_targets;

DROP TABLE comment_targets;
ALTER TABLE comment_targets_v4 RENAME TO comment_targets;

CREATE INDEX comment_targets_document ON comment_targets(document_kind, source_oid, file_path);
CREATE INDEX comment_targets_walkthrough ON comment_targets(walkthrough_id);
