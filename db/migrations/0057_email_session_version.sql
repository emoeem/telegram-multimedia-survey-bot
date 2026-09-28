-- Email session revocation: each email session token carries the account's
-- session_version, and changing the password increments it, so a stolen token
-- does not survive a password reset. Previously the 30-day stateless token
-- stayed valid after the victim reset their password.
ALTER TABLE email_accounts ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
