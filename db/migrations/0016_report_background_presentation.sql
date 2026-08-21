ALTER TABLE image_generators ADD COLUMN report_background_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE image_generators ADD COLUMN report_contrast_mode TEXT NOT NULL DEFAULT 'auto' CHECK (report_contrast_mode IN ('auto', 'light', 'dark'));
