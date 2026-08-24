ALTER TABLE comment_posts
ADD COLUMN last_modified_by TEXT
CHECK(last_modified_by IS NULL OR last_modified_by IN ('human', 'agent'));
