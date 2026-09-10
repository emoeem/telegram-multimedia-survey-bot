-- Optional opt-in link between an anonymous web participant key and a
-- Telegram user. The participant starts the bot with a deep-link payload
-- (link_<participantKey>) to claim the responses created by that browser.
CREATE TABLE IF NOT EXISTS participant_links (
  participant_key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participant_links_user ON participant_links(user_id);
