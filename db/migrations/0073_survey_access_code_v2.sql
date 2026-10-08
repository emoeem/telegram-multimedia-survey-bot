-- Security rollout marker for salted survey access-code hashes.
-- Data rehashing is intentionally performed by scripts/rehash-survey-access-codes.mjs:
-- D1 migrations are schema-oriented and must not contain per-row secret material.
SELECT 1;
