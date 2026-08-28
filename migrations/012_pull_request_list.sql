ALTER TABLE pull_requests
  ADD COLUMN github_created_at TEXT;

CREATE INDEX pull_requests_github_updated
  ON pull_requests(github_updated_at DESC, id DESC);
