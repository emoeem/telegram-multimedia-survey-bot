-- Store provisioning inputs encrypted at rest so the web control plane can hand
-- customer credentials to the authorized deployment runner without exposing them
-- in plaintext in D1.
ALTER TABLE deployment_tasks ADD COLUMN payload_json TEXT;
