CREATE TABLE IF NOT EXISTS image_generators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  template_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  background_mode TEXT NOT NULL DEFAULT 'preset' CHECK (background_mode IN ('preset', 'upload', 'both')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES visual_templates(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS image_generator_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generator_id INTEGER NOT NULL,
  variable_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'long_text', 'image')),
  required INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (generator_id) REFERENCES image_generators(id) ON DELETE CASCADE,
  UNIQUE(generator_id, variable_name)
);
CREATE TABLE IF NOT EXISTS image_generator_backgrounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generator_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (generator_id) REFERENCES image_generators(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS image_generator_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generator_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  template_version INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  background_asset_id INTEGER,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (generator_id) REFERENCES image_generators(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES visual_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (background_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_image_generators_status ON image_generators(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_image_generator_questions_generator ON image_generator_questions(generator_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_status ON image_generator_jobs(status, created_at);
