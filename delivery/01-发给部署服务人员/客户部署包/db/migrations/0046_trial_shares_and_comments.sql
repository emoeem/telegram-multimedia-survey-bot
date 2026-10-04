-- P3 community: trial result shares in the plaza feed and tree-hole comments.
-- plaza_posts gains a kind/payload so the feed can render structured result
-- cards; comments live in their own table and can be moderated like posts.
ALTER TABLE plaza_posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE plaza_posts ADD COLUMN payload_json TEXT;

CREATE TABLE IF NOT EXISTS plaza_post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plaza_post_comments_post
  ON plaza_post_comments(post_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_plaza_post_comments_user
  ON plaza_post_comments(user_id, created_at DESC);
