INSERT INTO app_meta(key, value) VALUES ('theme_preference', 'system')
ON CONFLICT(key) DO NOTHING;
