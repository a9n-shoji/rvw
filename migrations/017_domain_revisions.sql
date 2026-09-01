INSERT INTO app_meta(key, value)
SELECT 'revision_pull_requests', value FROM app_meta WHERE key = 'change_sequence';

INSERT INTO app_meta(key, value)
SELECT 'revision_comments', value FROM app_meta WHERE key = 'change_sequence';

INSERT INTO app_meta(key, value)
SELECT 'revision_walkthroughs', value FROM app_meta WHERE key = 'change_sequence';

INSERT INTO app_meta(key, value)
SELECT 'revision_structures', value FROM app_meta WHERE key = 'change_sequence';
