-- Device management is deliberately separate from license activations:
-- an activation proves entitlement; a managed device is the control-plane
-- identity used for heartbeat/task/update operations.
CREATE TABLE managed_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES software_licenses(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT,
  hostname TEXT,
  platform TEXT,
  arch TEXT,
  app_version TEXT,
  agent_version TEXT,
  status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','disabled')),
  last_seen_at TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(license_id, device_id),
  UNIQUE(license_id, installation_id)
);

CREATE INDEX idx_managed_devices_license_status
  ON managed_devices(license_id, status, last_seen_at DESC);
CREATE INDEX idx_managed_devices_last_seen
  ON managed_devices(last_seen_at DESC);

CREATE TABLE device_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('update','restart','stop','start','diagnostics','collect_logs','sync_config')),
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','completed','failed','cancelled')),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  result_json TEXT,
  error_message TEXT
);

CREATE INDEX idx_device_tasks_poll
  ON device_tasks(device_id, status, id ASC);
CREATE INDEX idx_device_tasks_created
  ON device_tasks(created_at DESC);
