-- Plaza (广场): text posts ("树洞") published alongside opt-in identity cards.
-- Cards keep living in identity_profiles; the plaza feed merges both feeds.
CREATE TABLE IF NOT EXISTS plaza_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plaza_posts_feed ON plaza_posts(status, id DESC);
