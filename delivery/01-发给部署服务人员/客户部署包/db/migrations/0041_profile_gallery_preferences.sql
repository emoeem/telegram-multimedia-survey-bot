-- Store the participant's public gallery choices separately from publication state.
ALTER TABLE survey_responses ADD COLUMN gallery_cover_media_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE survey_responses ADD COLUMN gallery_visible_question_ids_json TEXT;
ALTER TABLE survey_responses ADD COLUMN gallery_cover_source_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL;
