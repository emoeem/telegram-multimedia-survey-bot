-- The public cursor index is partial on published=1. Admin cursor pages can include
-- unpublished rows, so give that mode an equally selective created_at/id index.
CREATE INDEX IF NOT EXISTS idx_showcase_persons_admin_cursor_all
  ON showcase_persons(created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Legacy-feed cursors preserve the old feature_rank/sort_order/id ordering for
-- clients that upgrade from ?limit=N and choose to consume the additive cursor.
CREATE INDEX IF NOT EXISTS idx_showcase_persons_admin_legacy_feed
  ON showcase_persons(feature_rank DESC, sort_order ASC, id ASC)
  WHERE deleted_at IS NULL;
