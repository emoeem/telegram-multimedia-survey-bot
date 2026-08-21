import type { ResultProfile, SurveyResultRuleSet } from "../schema";

interface ResultProfileRow {
  id: number;
  survey_id: number;
  response_id: number;
  result_type: string;
  schema_version: number;
  title: string | null;
  subtitle: string | null;
  fields_json: string;
  stats_json: string;
  tags_json: string;
  images_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface RuleSetRow {
  id: number;
  survey_id: number;
  schema_version: number;
  rules_json: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

function mapResultProfile(row: ResultProfileRow): ResultProfile {
  return {
    id: row.id,
    surveyId: row.survey_id,
    responseId: row.response_id,
    resultType: row.result_type,
    schemaVersion: row.schema_version,
    title: row.title,
    subtitle: row.subtitle,
    fieldsJson: row.fields_json,
    statsJson: row.stats_json,
    tagsJson: row.tags_json,
    imagesJson: row.images_json,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuleSet(row: RuleSetRow): SurveyResultRuleSet {
  return {
    id: row.id,
    surveyId: row.survey_id,
    schemaVersion: row.schema_version,
    rulesJson: row.rules_json,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSurveyResultRuleSet(
  db: D1Database,
  surveyId: number,
): Promise<SurveyResultRuleSet | null> {
  const row = await db
    .prepare("SELECT * FROM survey_result_rule_sets WHERE survey_id = ? LIMIT 1")
    .bind(surveyId)
    .first<RuleSetRow>();

  return row ? mapRuleSet(row) : null;
}

export async function saveSurveyResultRuleSet(
  db: D1Database,
  input: {
    surveyId: number;
    schemaVersion: number;
    rulesJson: string;
    createdBy: number | null;
  },
): Promise<SurveyResultRuleSet> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO survey_result_rule_sets (
        survey_id, schema_version, rules_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(survey_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        rules_json = excluded.rules_json,
        created_by = excluded.created_by,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.surveyId,
      input.schemaVersion,
      input.rulesJson,
      input.createdBy,
      timestamp,
      timestamp,
    )
    .run();

  const saved = await getSurveyResultRuleSet(db, input.surveyId);
  if (!saved) {
    throw new Error("Failed to load saved survey result rule set");
  }
  return saved;
}

export async function getResultProfileByResponseId(
  db: D1Database,
  responseId: number,
): Promise<ResultProfile | null> {
  const row = await db
    .prepare("SELECT * FROM result_profiles WHERE response_id = ? LIMIT 1")
    .bind(responseId)
    .first<ResultProfileRow>();

  return row ? mapResultProfile(row) : null;
}

export async function getResultProfileById(
  db: D1Database,
  id: number,
): Promise<ResultProfile | null> {
  const row = await db
    .prepare("SELECT * FROM result_profiles WHERE id = ? LIMIT 1")
    .bind(id)
    .first<ResultProfileRow>();

  return row ? mapResultProfile(row) : null;
}

export async function upsertResultProfile(
  db: D1Database,
  input: {
    surveyId: number;
    responseId: number;
    resultType: string;
    schemaVersion: number;
    title: string | null;
    subtitle: string | null;
    fieldsJson: string;
    statsJson: string;
    tagsJson: string;
    imagesJson: string;
    metadataJson: string;
  },
): Promise<ResultProfile> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO result_profiles (
        survey_id, response_id, result_type, schema_version, title, subtitle,
        fields_json, stats_json, tags_json, images_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(response_id) DO UPDATE SET
        survey_id = excluded.survey_id,
        result_type = excluded.result_type,
        schema_version = excluded.schema_version,
        title = excluded.title,
        subtitle = excluded.subtitle,
        fields_json = excluded.fields_json,
        stats_json = excluded.stats_json,
        tags_json = excluded.tags_json,
        images_json = excluded.images_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.surveyId,
      input.responseId,
      input.resultType,
      input.schemaVersion,
      input.title,
      input.subtitle,
      input.fieldsJson,
      input.statsJson,
      input.tagsJson,
      input.imagesJson,
      input.metadataJson,
      timestamp,
      timestamp,
    )
    .run();

  const profile = await getResultProfileByResponseId(db, input.responseId);
  if (!profile) {
    throw new Error("Failed to load saved result profile");
  }
  return profile;
}
