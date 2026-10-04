-- Retain a customer instance's Cloudflare account credentials (account id +
-- scoped API token), encrypted with the control-plane runner secret, so the
-- center can queue follow-up `update` tasks for a customer deployed into its
-- OWN account.
--
-- Before this, those credentials existed only inside the one-off `deploy` task
-- payload. An `update` task carried no payload at all, so the runner fell back
-- to its own wrangler login and redeployed a cross-account customer into the
-- VENDOR's account.
--
-- Stored as an opaque AES-GCM envelope; `mapDeployment` lists its columns
-- explicitly, so this never reaches an API response.
ALTER TABLE customer_deployments ADD COLUMN credentials_json TEXT;

-- Per-instance secret shared with the customer Worker, used to sign the
-- short-lived read-only tokens the vendor console presents to `/api/remote/*`.
-- The instance reports it on its first heartbeat; stored encrypted like the
-- account credentials. A separate column because the account credentials are
-- also handed to the deployment runner, and the runner has no business holding
-- this one.
ALTER TABLE customer_deployments ADD COLUMN remote_secret_json TEXT;

