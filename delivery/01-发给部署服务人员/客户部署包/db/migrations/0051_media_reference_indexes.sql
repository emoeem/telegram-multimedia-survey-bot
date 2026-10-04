-- Read-path indexes for the daily media sweep and the hot admin/public lists.
--
-- The orphan-media sweep probes every table that can reference a media asset.
-- Several of those referencing columns had no index, so each probe degraded
-- into a full table scan. On 2026-09-14 a single maintenance run read millions
-- of rows and exhausted the free-tier D1 daily rows-read quota for the whole
-- day: every later query (bot updates, admin API) failed with "exceeded D1's
-- daily row read limit", which looked like a dead bot plus broken dashboards.
-- These indexes let the same checks run with bounded work.

CREATE INDEX IF NOT EXISTS idx_media_assets_created_at
  ON media_assets(created_at, id);

CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_asset
  ON gallery_profile_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_source_asset
  ON gallery_profile_media(source_asset_id);

CREATE INDEX IF NOT EXISTS idx_identity_profiles_front_asset
  ON identity_profiles(front_asset_id);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_back_asset
  ON identity_profiles(back_asset_id);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_background_asset
  ON identity_profiles(background_asset_id);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_card_asset
  ON identity_profiles(card_asset_id);

CREATE INDEX IF NOT EXISTS idx_image_generator_backgrounds_asset
  ON image_generator_backgrounds(asset_id);
CREATE INDEX IF NOT EXISTS idx_image_generators_report_background_asset
  ON image_generators(report_background_asset_id);

CREATE INDEX IF NOT EXISTS idx_survey_responses_gallery_cover_source
  ON survey_responses(gallery_cover_source_asset_id);

CREATE INDEX IF NOT EXISTS idx_surveys_cover_media
  ON surveys(cover_media_id);
CREATE INDEX IF NOT EXISTS idx_surveys_status_published
  ON surveys(status, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_surveys_updated_at
  ON surveys(updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_task_items_pack_sort
  ON task_items(pack_id, enabled, sort_order, id);
