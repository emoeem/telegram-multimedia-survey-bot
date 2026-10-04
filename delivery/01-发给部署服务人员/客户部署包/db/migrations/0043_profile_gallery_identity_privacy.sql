-- Telegram identity is private by default for public profile gallery cards.
ALTER TABLE survey_responses ADD COLUMN gallery_show_username INTEGER NOT NULL DEFAULT 0;