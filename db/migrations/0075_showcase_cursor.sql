-- Keyset pagination for the showcase feed. The cursor mode sorts by created_at/id
-- and never uses OFFSET; the old offset mode keeps its historical sort order.
CREATE INDEX IF NOT EXISTS idx_showcase_persons_public_cursor
  ON showcase_persons(created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND published = 1;
-- Admin cursor pages use the same all-visible keyset index defined in 0076.
-- No owner filter is applied by the admin route, so an owner-prefixed index
-- would not narrow the scan and would only add write/storage overhead.
