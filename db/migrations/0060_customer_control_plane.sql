-- Replace the temporary PC/agent-oriented managed-device model with customer Worker deployments.
DROP TABLE IF EXISTS device_tasks;
DROP TABLE IF EXISTS managed_devices;

CREATE TABLE customer_deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES software_licenses(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  worker_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','deploying','online','offline','disabled','failed')),
  current_version TEXT,
  desired_version TEXT,
  last_seen_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(license_id, installation_id),
  UNIQUE(worker_name)
);

CREATE INDEX idx_customer_deployments_license ON customer_deployments(license_id, status, updated_at DESC);
CREATE INDEX idx_customer_deployments_status ON customer_deployments(status, updated_at DESC);

CREATE TABLE deployment_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id INTEGER NOT NULL REFERENCES customer_deployments(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('deploy','update','rollback','disable','enable')),
  target_version TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  requested_by INTEGER,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  log_text TEXT,
  result_json TEXT,
  error_message TEXT
);

CREATE INDEX idx_deployment_tasks_queue ON deployment_tasks(status, requested_at ASC);
CREATE INDEX idx_deployment_tasks_deployment ON deployment_tasks(deployment_id, id DESC);
