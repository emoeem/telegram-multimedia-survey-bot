-- Custom report templates managed from the Web Admin template editor.
-- System templates stay code-registered (src/services/report/template.ts);
-- rows here are user-defined specs validated by validateReportTemplateSpec.
CREATE TABLE IF NOT EXISTS report_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_report_templates_created_by
  ON report_templates(created_by);
