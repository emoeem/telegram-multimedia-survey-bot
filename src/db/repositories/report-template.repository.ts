import type { ReportTemplateSpec } from "../../services/report/template";

interface ReportTemplateRow {
  id: string;
  name: string;
  spec_json: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ReportTemplateRow): { id: string; name: string; spec: ReportTemplateSpec } {
  return {
    id: row.id,
    name: row.name,
    spec: JSON.parse(row.spec_json) as ReportTemplateSpec,
  };
}

export async function listCustomReportTemplates(db: D1Database): Promise<
  Array<{ id: string; name: string; spec: ReportTemplateSpec }>
> {
  const result = await db
    .prepare(
      `SELECT id, name, spec_json, created_by, created_at, updated_at
       FROM report_templates
       ORDER BY updated_at DESC, id ASC`,
    )
    .all<ReportTemplateRow>();
  return (result.results ?? []).map(mapRow);
}

export async function getCustomReportTemplate(
  db: D1Database,
  id: string,
): Promise<{ id: string; name: string; spec: ReportTemplateSpec } | null> {
  const row = await db
    .prepare(
      `SELECT id, name, spec_json, created_by, created_at, updated_at
       FROM report_templates WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<ReportTemplateRow>();
  return row ? mapRow(row) : null;
}

export async function upsertCustomReportTemplate(
  db: D1Database,
  input: { id: string; name: string; spec: ReportTemplateSpec; createdBy: number },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO report_templates (id, name, spec_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         spec_json = excluded.spec_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.name,
      JSON.stringify(input.spec),
      input.createdBy,
      timestamp,
      timestamp,
    )
    .run();
}

export async function deleteCustomReportTemplate(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM report_templates WHERE id = ?").bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}
