-- Showcase (展示区): an immersive, mobile-first gallery of people and their
-- work. It is deliberately decoupled from the profile gallery: a showcase entry
-- stores its own copy of the displayed fields, so an operator (or, later, the
-- owner themselves) can curate a page without the participant having to publish
-- a survey response first. A person may still point at a survey / gallery
-- response for "查看我的问卷".
--
-- Media is referenced by id into media_assets (scope 'survey', the long-lived
-- KV-backed scope the admin uploader already writes) and served through
-- /api/showcase/media/:id, which only serves assets referenced by a PUBLISHED
-- person — the join is the authorization boundary, exactly like the gallery.

CREATE TABLE IF NOT EXISTS showcase_persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  -- Per-person atmosphere: the stage background cross-fades between people, so
  -- each one can carry its own palette without touching the global theme.
  accent_color TEXT,
  background_from TEXT,
  background_to TEXT,
  background_media_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  illustration_media_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  avatar_media_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  -- Optional external artwork, for people who host their own CDN images.
  background_url TEXT,
  illustration_url TEXT,
  tags_json TEXT,
  links_json TEXT,
  -- "查看我的问卷" and "查看我的个人资料" entry points.
  survey_id INTEGER,
  response_id INTEGER REFERENCES survey_responses(id) ON DELETE SET NULL,
  -- Reserved for participant self-service: NULL means an operator-authored page.
  owner_user_id INTEGER,
  feature_rank INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_showcase_persons_feed
  ON showcase_persons(published, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_showcase_persons_owner
  ON showcase_persons(owner_user_id);

CREATE TABLE IF NOT EXISTS showcase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES showcase_persons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  -- image | article | video | project | github | website | social | survey | other
  kind TEXT NOT NULL DEFAULT 'link',
  cover_media_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  cover_url TEXT,
  url TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_showcase_items_person
  ON showcase_items(person_id, sort_order, id);
