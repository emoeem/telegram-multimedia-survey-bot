-- Generic per-survey settings JSON. Carries the reserved import theme payload
-- today; the Phase-3 SurveyTheme system (background/font/colors/buttons) will
-- consume it once the survey UI renders themes. NULL means defaults.
ALTER TABLE surveys ADD COLUMN settings_json TEXT;
