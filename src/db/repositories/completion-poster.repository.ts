export type CompletionPosterStyle = "clean" | "cute" | "editorial" | "bold";

export interface CompletionPosterSetting {
  surveyId: number;
  enabled: boolean;
  style: CompletionPosterStyle;
  updatedAt: string;
}

const styles = new Set<CompletionPosterStyle>(["clean", "cute", "editorial", "bold"]);

function map(row: { survey_id: number; enabled: number; style: string; updated_at: string }): CompletionPosterSetting {
  return {
    surveyId: row.survey_id,
    enabled: row.enabled === 1,
    style: styles.has(row.style as CompletionPosterStyle) ? row.style as CompletionPosterStyle : "clean",
    updatedAt: row.updated_at,
  };
}

export async function getCompletionPosterSetting(db: D1Database, surveyId: number): Promise<CompletionPosterSetting> {
  const row = await db.prepare("SELECT * FROM survey_completion_posters WHERE survey_id = ? LIMIT 1").bind(surveyId).first<{ survey_id: number; enabled: number; style: string; updated_at: string }>();
  return row ? map(row) : { surveyId, enabled: false, style: "clean", updatedAt: "" };
}

export async function saveCompletionPosterSetting(
  db: D1Database,
  input: { surveyId: number; enabled: boolean; style: CompletionPosterStyle },
): Promise<CompletionPosterSetting> {
  const timestamp = new Date().toISOString();
  await db.prepare(`INSERT INTO survey_completion_posters (survey_id, enabled, style, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(survey_id) DO UPDATE SET enabled = excluded.enabled, style = excluded.style, updated_at = excluded.updated_at`)
    .bind(input.surveyId, input.enabled ? 1 : 0, input.style, timestamp).run();
  return { ...input, updatedAt: timestamp };
}
