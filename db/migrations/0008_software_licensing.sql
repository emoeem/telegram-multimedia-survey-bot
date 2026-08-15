CREATE TABLE IF NOT EXISTS software_licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  license_key_hash TEXT NOT NULL UNIQUE,
  customer_name TEXT,
  customer_contact TEXT,
  license_type TEXT NOT NULL CHECK (license_type IN ('timed', 'perpetual')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  starts_at TEXT NOT NULL,
  expires_at TEXT,
  updates_until TEXT,
  max_activations INTEGER NOT NULL DEFAULT 1 CHECK (max_activations > 0),
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS software_license_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  installation_id TEXT NOT NULL,
  installation_name TEXT,
  app_version TEXT,
  metadata_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  deactivated_at TEXT,
  FOREIGN KEY (license_id) REFERENCES software_licenses(id) ON DELETE CASCADE,
  UNIQUE (license_id, installation_id)
);

CREATE TABLE IF NOT EXISTS software_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'stable',
  released_at TEXT NOT NULL,
  minimum_version TEXT,
  download_url TEXT,
  checksum_sha256 TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_software_licenses_status
  ON software_licenses(status);
CREATE INDEX IF NOT EXISTS idx_software_licenses_customer
  ON software_licenses(customer_name);
CREATE INDEX IF NOT EXISTS idx_license_activations_license
  ON software_license_activations(license_id, deactivated_at);
CREATE INDEX IF NOT EXISTS idx_software_releases_released_at
  ON software_releases(released_at);

INSERT OR IGNORE INTO software_releases (
  version, channel, released_at, notes, created_at, updated_at
) VALUES (
  '0.2.0',
  'stable',
  '2026-08-15T00:00:00.000Z',
  'Initial commercial licensing release',
  '2026-08-15T00:00:00.000Z',
  '2026-08-15T00:00:00.000Z'
);
