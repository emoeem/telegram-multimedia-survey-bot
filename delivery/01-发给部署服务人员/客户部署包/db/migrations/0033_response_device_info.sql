-- Device fingerprint / browser / IP captured when a web participant starts
-- a response. Used by the admin to correlate anonymous web responses.
ALTER TABLE survey_responses ADD COLUMN device_fingerprint TEXT;
ALTER TABLE survey_responses ADD COLUMN browser_info TEXT;
ALTER TABLE survey_responses ADD COLUMN ip_address TEXT;
