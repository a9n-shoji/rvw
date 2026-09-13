ALTER TABLE pull_requests
  ADD COLUMN github_approval_count INTEGER CHECK(github_approval_count >= 0);
