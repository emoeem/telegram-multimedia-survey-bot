ALTER TABLE users ADD COLUMN banned_at TEXT;
ALTER TABLE users ADD COLUMN banned_by INTEGER;
ALTER TABLE users ADD COLUMN ban_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_users_banned_at ON users(banned_at, id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_name ON users(first_name, last_name);
