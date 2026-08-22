import type { UnifiedSurveyImport } from "../survey/schema";
import { getSurveyById } from "../db/repositories/survey.repository";
import { listQuestionsBySurvey } from "../db/repositories/question.repository";
import { exportUnifiedSurveyJson } from "./survey-json.service";

export interface SurveyVersionSnapshotRecord {
  schema: UnifiedSurveyImport;
  /** DB question ids in snapshot order, so answers (which reference DB ids)
   * can be mapped back onto a historical definition. */
  questionOrderIds: number[];
}

function parseSnapshotRecord(value: string): SurveyVersionSnapshotRecord | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && parsed.schema && Array.isArray(parsed.questionOrderIds)) {
      return {
        schema: parsed.schema as UnifiedSurveyImport,
        questionOrderIds: parsed.questionOrderIds.map(Number).filter(Number.isInteger),
      };
    }
  } catch {
    // Fall through to legacy raw-JSON snapshot handling.
  }
  try {
    return {
      schema: JSON.parse(value) as UnifiedSurveyImport,
      questionOrderIds: [],
    };
  } catch {
    return null;
  }
}

/**
 * Survey definition versioning. A snapshot is written every time a survey is
 * published (including re-publishes) and responses record the survey version
 * they were submitted against, so historical answers and reports can be
 * rebuilt even if question content later changes.
 */
export async function createSurveyVersionSnapshot(
  db: D1Database,
  surveyId: number,
  createdBy: number | null,
): Promise<number> {
  const survey = await getSurveyById(db, surveyId);
  if (!survey) {
    throw new Error("Survey not found");
  }
  const snapshot = await exportUnifiedSurveyJson(db, surveyId);
  if (!snapshot) {
    throw new Error("Survey definition unavailable for snapshot");
  }
  const questions = await listQuestionsBySurvey(db, surveyId);
  const record: SurveyVersionSnapshotRecord = {
    schema: snapshot,
    questionOrderIds: questions.map((question) => question.id),
  };
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO survey_versions (
        survey_id, version, snapshot_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(survey_id, version) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        created_by = excluded.created_by,
        created_at = excluded.created_at`,
    )
    .bind(surveyId, survey.version, JSON.stringify(record), createdBy, timestamp)
    .run();
  return survey.version;
}

export async function getSurveyVersionSnapshot(
  db: D1Database,
  surveyId: number,
  version: number,
): Promise<UnifiedSurveyImport | null> {
  const row = await db
    .prepare(
      `SELECT snapshot_json
       FROM survey_versions
       WHERE survey_id = ? AND version = ?
       LIMIT 1`,
    )
    .bind(surveyId, version)
    .first<{ snapshot_json: string }>();
  if (!row) return null;
  return parseSnapshotRecord(row.snapshot_json)?.schema ?? null;
}

export async function getLatestSurveyVersionSnapshot(
  db: D1Database,
  surveyId: number,
): Promise<UnifiedSurveyImport | null> {
  const row = await db
    .prepare(
      `SELECT snapshot_json
       FROM survey_versions
       WHERE survey_id = ?
       ORDER BY version DESC
       LIMIT 1`,
    )
    .bind(surveyId)
    .first<{ snapshot_json: string }>();
  if (!row) return null;
  return parseSnapshotRecord(row.snapshot_json)?.schema ?? null;
}

export async function getResponseSurveyVersion(
  db: D1Database,
  responseId: number,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT version FROM survey_responses WHERE id = ? LIMIT 1")
    .bind(responseId)
    .first<{ version: number | null }>();
  if (!row || row.version === null || row.version === undefined) return null;
  return Number(row.version);
}

export async function getResponseSurveySnapshot(
  db: D1Database,
  responseId: number,
): Promise<SurveyVersionSnapshotRecord | null> {
  const row = await db
    .prepare(
      `SELECT sv.snapshot_json
       FROM survey_versions sv
       JOIN survey_responses r ON r.survey_id = sv.survey_id
       WHERE r.id = ? AND sv.version = r.version
       LIMIT 1`,
    )
    .bind(responseId)
    .first<{ snapshot_json: string }>();
  if (!row) return null;
  return parseSnapshotRecord(row.snapshot_json);
}

export interface SurveyVersionSummary {
  version: number;
  createdAt: string;
  createdBy: number | null;
  title: string;
  questionCount: number;
}

export async function listSurveyVersions(
  db: D1Database,
  surveyId: number,
): Promise<SurveyVersionSummary[]> {
  const rows = await db
    .prepare(
      `SELECT version, created_by createdBy, created_at createdAt, snapshot_json snapshotJson
       FROM survey_versions
       WHERE survey_id = ?
       ORDER BY version DESC`,
    )
    .bind(surveyId)
    .all<{
      version: number;
      createdBy: number | null;
      createdAt: string;
      snapshotJson: string;
    }>();
  const summaries: SurveyVersionSummary[] = [];
  for (const row of rows.results ?? []) {
    const record = parseSnapshotRecord(row.snapshotJson);
    summaries.push({
      version: row.version,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      title: record?.schema.survey.title ?? "",
      questionCount: record?.schema.survey.questions.length ?? 0,
    });
  }
  return summaries;
}

export interface SurveyVersionDiff {
  added: string[];
  removed: string[];
  changed: Array<{ id: string; from: string; to: string }>;
}

function questionFingerprint(question: {
  id?: string;
  title?: string;
  type?: string;
  options?: unknown[];
}): string {
  return JSON.stringify({
    title: question.title ?? "",
    type: question.type ?? "",
    optionCount: Array.isArray(question.options) ? question.options.length : 0,
  });
}

export function diffSurveyVersions(
  from: UnifiedSurveyImport,
  to: UnifiedSurveyImport,
): SurveyVersionDiff {
  const fromMap = new Map(
    (from.survey.questions ?? []).map((question) => [question.id, question]),
  );
  const toMap = new Map(
    (to.survey.questions ?? []).map((question) => [question.id, question]),
  );
  const added: string[] = [];
  const removed: string[] = [];
  const changed: SurveyVersionDiff["changed"] = [];
  for (const [id, question] of toMap) {
    if (!fromMap.has(id)) {
      added.push(question.title);
    }
  }
  for (const [id, question] of fromMap) {
    if (!toMap.has(id)) {
      removed.push(question.title);
    }
  }
  for (const [id, fromQuestion] of fromMap) {
    const toQuestion = toMap.get(id);
    if (toQuestion && questionFingerprint(fromQuestion) !== questionFingerprint(toQuestion)) {
      changed.push({ id, from: fromQuestion.title, to: toQuestion.title });
    }
  }
  return { added, removed, changed };
}
