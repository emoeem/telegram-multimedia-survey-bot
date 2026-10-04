ALTER TABLE identity_profiles ADD COLUMN background_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL;
