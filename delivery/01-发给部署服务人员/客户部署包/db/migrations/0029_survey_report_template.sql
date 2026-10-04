-- Optional per-survey report template binding. The value references the
-- built-in template registry id (e.g. 'classic', 'magazine-dark'); NULL means
-- the platform default template is used.
ALTER TABLE surveys ADD COLUMN report_template_id TEXT;
