-- P1 soft delete / recycle bin.
-- Keep deleted rows for 30 days before the maintenance sweep physically removes them.
-- showcase_persons is included because it is the root entity for showcase_items:
-- without a root tombstone, deleting a person could not be restored with its full item set.

ALTER TABLE surveys ADD COLUMN deleted_at TEXT;
ALTER TABLE showcase_persons ADD COLUMN deleted_at TEXT;
ALTER TABLE showcase_items ADD COLUMN deleted_at TEXT;
ALTER TABLE plaza_posts ADD COLUMN deleted_at TEXT;
ALTER TABLE report_templates ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_surveys_deleted_at
  ON surveys(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_persons_deleted_at
  ON showcase_persons(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_items_deleted_at
  ON showcase_items(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plaza_posts_deleted_at
  ON plaza_posts(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_report_templates_deleted_at
  ON report_templates(deleted_at, id) WHERE deleted_at IS NOT NULL;

-- Active-feed indexes keep the common NULL path selective without indexing
-- tombstoned rows. The existing showcase feed index remains valid for ordering.
CREATE INDEX IF NOT EXISTS idx_showcase_persons_active_feed
  ON showcase_persons(published, feature_rank, sort_order, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_items_active_person
  ON showcase_items(person_id, sort_order, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plaza_posts_active_feed
  ON plaza_posts(status, id)
  WHERE deleted_at IS NULL;
