ALTER TABLE media_assets ADD COLUMN asset_scope TEXT NOT NULL DEFAULT 'legacy'
  CHECK (asset_scope IN ('survey', 'response', 'template', 'generated_result', 'template_preview', 'identity_card', 'legacy'));

CREATE INDEX IF NOT EXISTS idx_media_assets_scope ON media_assets(asset_scope, id);
