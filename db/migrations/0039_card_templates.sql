-- Custom card face templates ("卡面模板"): an admin-designed arrangement of
-- text/image slots over an optional background image, rendered to a 900x1200
-- PNG by the same browser pipeline as identity cards. Roleplay documents must
-- always carry the fictional-use disclaimer, so it is stored on the template
-- and rendered by the pipeline rather than drawn as a removable slot.
CREATE TABLE IF NOT EXISTS card_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  background_asset_id INTEGER REFERENCES media_assets(id) ON DELETE SET NULL,
  background_color TEXT NOT NULL DEFAULT '#ffffff',
  canvas_width INTEGER NOT NULL DEFAULT 900,
  canvas_height INTEGER NOT NULL DEFAULT 1200,
  slots_json TEXT NOT NULL DEFAULT '[]',
  disclaimer_text TEXT NOT NULL DEFAULT '虚构证件 · 仅供娱乐',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_templates_enabled
  ON card_templates(enabled, sort_order, id);
