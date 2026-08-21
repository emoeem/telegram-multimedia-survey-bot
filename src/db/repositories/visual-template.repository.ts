import type { VisualTemplate, VisualTemplateStatus, VisualTemplateVersion } from "../schema";

interface TemplateRow {
  id: number;
  owner_id: number | null;
  survey_id: number | null;
  name: string;
  description: string | null;
  type: string;
  status: string;
  current_version: number | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: number;
  template_id: number;
  version: number;
  template_schema_version: number;
  definition_json: string;
  variables_json: string;
  created_by: number | null;
  created_at: string;
}

function mapTemplate(row: TemplateRow): VisualTemplate {
  return {
    id: row.id,
    ownerId: row.owner_id,
    surveyId: row.survey_id,
    name: row.name,
    description: row.description,
    type: row.type,
    status: row.status as VisualTemplateStatus,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: VersionRow): VisualTemplateVersion {
  return {
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    templateSchemaVersion: row.template_schema_version,
    definitionJson: row.definition_json,
    variablesJson: row.variables_json,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function referencedAssetIds(definitionJson: string): Array<{ assetId: number; role: string }> {
  try {
    const definition = JSON.parse(definitionJson) as unknown;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) return [];
    const background = (definition as Record<string, unknown>).background;
    if (!background || typeof background !== "object" || Array.isArray(background)) return [];
    const assetId = (background as Record<string, unknown>).assetId;
    return typeof assetId === "number" && Number.isSafeInteger(assetId) && assetId > 0
      ? [{ assetId, role: "background" }]
      : [];
  } catch {
    return [];
  }
}

export async function getVisualTemplateById(db: D1Database, id: number): Promise<VisualTemplate | null> {
  const row = await db.prepare("SELECT * FROM visual_templates WHERE id = ? LIMIT 1").bind(id).first<TemplateRow>();
  return row ? mapTemplate(row) : null;
}

export async function listVisualTemplates(
  db: D1Database,
  limit = 20,
  offset = 0,
): Promise<VisualTemplate[]> {
  const result = await db.prepare(
    `SELECT * FROM visual_templates
     ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
       updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<TemplateRow>();
  return (result.results ?? []).map(mapTemplate);
}

export async function updateVisualTemplateStatus(
  db: D1Database,
  id: number,
  status: VisualTemplateStatus,
): Promise<VisualTemplate> {
  await db.prepare(
    "UPDATE visual_templates SET status = ?, updated_at = ? WHERE id = ?",
  ).bind(status, new Date().toISOString(), id).run();
  const template = await getVisualTemplateById(db, id);
  if (!template) throw new Error("Visual template not found");
  return template;
}

export async function deleteVisualTemplate(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM visual_templates WHERE id = ?").bind(id).run();
}

export async function getVisualTemplateVersion(
  db: D1Database,
  templateId: number,
  version: number,
): Promise<VisualTemplateVersion | null> {
  const row = await db.prepare(
    "SELECT * FROM visual_template_versions WHERE template_id = ? AND version = ? LIMIT 1",
  ).bind(templateId, version).first<VersionRow>();
  return row ? mapVersion(row) : null;
}

export async function createVisualTemplate(
  db: D1Database,
  input: {
    ownerId: number | null;
    surveyId: number | null;
    name: string;
    description: string | null;
    type: string;
  },
): Promise<VisualTemplate> {
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO visual_templates (
      owner_id, survey_id, name, description, type, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).bind(input.ownerId, input.surveyId, input.name, input.description, input.type, timestamp, timestamp).run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("Failed to create visual template");
  const template = await getVisualTemplateById(db, id);
  if (!template) throw new Error("Failed to load created visual template");
  return template;
}

export async function createVisualTemplateVersion(
  db: D1Database,
  input: {
    templateId: number;
    version: number;
    templateSchemaVersion: number;
    definitionJson: string;
    variablesJson: string;
    createdBy: number | null;
  },
): Promise<VisualTemplateVersion> {
  const timestamp = new Date().toISOString();
  const versionInsert = db.prepare(
    `INSERT INTO visual_template_versions (
      template_id, version, template_schema_version, definition_json, variables_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.templateId, input.version, input.templateSchemaVersion, input.definitionJson,
    input.variablesJson, input.createdBy, timestamp,
  );
  const statements = [
    versionInsert,
    db.prepare(
      "UPDATE visual_templates SET current_version = ?, updated_at = ? WHERE id = ?",
    ).bind(input.version, timestamp, input.templateId),
    ...referencedAssetIds(input.definitionJson).map((reference) => db.prepare(
      `INSERT OR IGNORE INTO visual_template_assets
        (template_id, template_version, asset_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(input.templateId, input.version, reference.assetId, reference.role, timestamp)),
  ];
  const results = await db.batch(statements);
  const id = results[0]?.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("Failed to create visual template version");
  const version = await getVisualTemplateVersion(db, input.templateId, input.version);
  if (!version) throw new Error("Failed to load created visual template version");
  return version;
}
