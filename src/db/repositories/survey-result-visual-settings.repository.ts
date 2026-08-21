import type { SurveyResultVisualSettings } from "../schema";

interface SettingsRow {
  survey_id: number;
  enabled: number;
  auto_generate: number;
  template_id: number | null;
  updated_at: string;
}

function mapSettings(row: SettingsRow): SurveyResultVisualSettings {
  return {
    surveyId: row.survey_id,
    enabled: row.enabled === 1,
    autoGenerate: row.auto_generate === 1,
    templateId: row.template_id,
    updatedAt: row.updated_at,
  };
}

export async function getSurveyResultVisualSettings(
  db: D1Database,
  surveyId: number,
): Promise<SurveyResultVisualSettings> {
  const row = await db
    .prepare("SELECT * FROM survey_result_visual_settings WHERE survey_id = ? LIMIT 1")
    .bind(surveyId)
    .first<SettingsRow>();
  return row ? mapSettings(row) : {
    surveyId,
    enabled: false,
    autoGenerate: false,
    templateId: null,
    updatedAt: "",
  };
}

export async function saveSurveyResultVisualSettings(
  db: D1Database,
  input: Omit<SurveyResultVisualSettings, "updatedAt">,
): Promise<SurveyResultVisualSettings> {
  const timestamp = new Date().toISOString();
  await db.prepare(
    `INSERT INTO survey_result_visual_settings (
      survey_id, enabled, auto_generate, template_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(survey_id) DO UPDATE SET
      enabled = excluded.enabled, auto_generate = excluded.auto_generate,
      template_id = excluded.template_id, updated_at = excluded.updated_at`,
  ).bind(
    input.surveyId,
    input.enabled ? 1 : 0,
    input.autoGenerate ? 1 : 0,
    input.templateId,
    timestamp,
  ).run();
  return { ...input, updatedAt: timestamp };
}
