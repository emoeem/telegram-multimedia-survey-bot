-- Identity card gallery: per-card opt-in publication plus the stored card
-- render so the bot gallery and the admin card list can serve the same PNG
-- without re-rendering through the browser binding on every view.
ALTER TABLE identity_profiles ADD COLUMN gallery_published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE identity_profiles ADD COLUMN gallery_published_at TEXT;
ALTER TABLE identity_profiles ADD COLUMN card_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_identity_profiles_gallery
  ON identity_profiles(gallery_published, id DESC);
