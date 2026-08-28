ALTER TABLE pull_requests
  ADD COLUMN github_state TEXT CHECK(github_state IN ('OPEN', 'CLOSED', 'MERGED'));

ALTER TABLE pull_requests
  ADD COLUMN github_is_draft INTEGER CHECK(github_is_draft IN (0, 1));
