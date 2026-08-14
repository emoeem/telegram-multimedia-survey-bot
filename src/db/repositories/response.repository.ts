import type { Answer, SurveyResponse, SurveyResponseStatus } from "../schema";
import { nowIso, toBoolean } from "../client";

interface SurveyResponseRow {
  id: number;
  survey_id: number;
  user_id: number | null;
  participant_hash: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  submitted_at: string | null;
  current_question_id: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AnswerRow {
  id: number;
  response_id: number;
  question_id: number;
  text_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
  rating_value: number | null;
  date_value: string | null;
  time_value: string | null;
  json_value: string | null;
  created_at: string;
  updated_at: string;
}

function mapResponse(row: SurveyResponseRow): SurveyResponse {
  return {
    id: row.id,
    surveyId: row.survey_id,
    userId: row.user_id,
    participantHash: row.participant_hash,
    status: row.status as SurveyResponseStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    submittedAt: row.submitted_at,
    currentQuestionId: row.current_question_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAnswer(row: AnswerRow): Answer {
  return {
    id: row.id,
    responseId: row.response_id,
    questionId: row.question_id,
    textValue: row.text_value,
    numberValue: row.number_value,
    booleanValue: toBoolean(row.boolean_value),
    ratingValue: row.rating_value,
    dateValue: row.date_value,
    timeValue: row.time_value,
    jsonValue: row.json_value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createResponse(
  db: D1Database,
  input: {
    surveyId: number;
    userId: number | null;
    participantHash: string;
    currentQuestionId?: number | null;
  },
): Promise<SurveyResponse> {
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO survey_responses (
        survey_id, user_id, participant_hash, status,
        started_at, current_question_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'in_progress', ?, ?, 1, ?, ?)`,
    )
    .bind(
      input.surveyId,
      input.userId,
      input.participantHash,
      timestamp,
      input.currentQuestionId ?? null,
      timestamp,
      timestamp,
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to create survey response");
  }

  const response = await getResponseById(db, id);
  if (!response) {
    throw new Error("Failed to load created response");
  }

  return response;
}

export async function getResponseById(
  db: D1Database,
  id: number,
): Promise<SurveyResponse | null> {
  const row = await db
    .prepare("SELECT * FROM survey_responses WHERE id = ? LIMIT 1")
    .bind(id)
    .first<SurveyResponseRow>();

  return row ? mapResponse(row) : null;
}

export async function getActiveResponse(
  db: D1Database,
  surveyId: number,
  participantHash: string,
): Promise<SurveyResponse | null> {
  const row = await db
    .prepare(
      `SELECT * FROM survey_responses
       WHERE survey_id = ? AND participant_hash = ? AND status = 'in_progress'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(surveyId, participantHash)
    .first<SurveyResponseRow>();

  return row ? mapResponse(row) : null;
}

export async function getActiveResponseByUser(
  db: D1Database,
  userId: number,
): Promise<SurveyResponse | null> {
  const row = await db
    .prepare(
      `SELECT * FROM survey_responses
       WHERE user_id = ? AND status = 'in_progress'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<SurveyResponseRow>();

  return row ? mapResponse(row) : null;
}

export async function getAnswer(
  db: D1Database,
  responseId: number,
  questionId: number,
): Promise<Answer | null> {
  const row = await db
    .prepare(
      "SELECT * FROM answers WHERE response_id = ? AND question_id = ? LIMIT 1",
    )
    .bind(responseId, questionId)
    .first<AnswerRow>();

  return row ? mapAnswer(row) : null;
}

export async function updateResponseCurrentQuestion(
  db: D1Database,
  id: number,
  questionId: number | null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE survey_responses SET current_question_id = ?, updated_at = ? WHERE id = ?",
    )
    .bind(questionId, nowIso(), id)
    .run();
}

export async function completeResponse(
  db: D1Database,
  id: number,
): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `UPDATE survey_responses
       SET status = 'completed', completed_at = ?, submitted_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(timestamp, timestamp, timestamp, id)
    .run();
}

export async function cancelResponse(
  db: D1Database,
  id: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE survey_responses SET status = 'cancelled', updated_at = ? WHERE id = ?",
    )
    .bind(nowIso(), id)
    .run();
}

export async function upsertTextAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    textValue: string;
  },
): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO answers (
        response_id, question_id, text_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(response_id, question_id) DO UPDATE SET
        text_value = excluded.text_value,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.responseId,
      input.questionId,
      input.textValue,
      timestamp,
      timestamp,
    )
    .run();
}

export async function upsertOptionAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    selectedOptionIds: number[];
  },
): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO answers (
        response_id, question_id, json_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(response_id, question_id) DO UPDATE SET
        json_value = excluded.json_value,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.responseId,
      input.questionId,
      JSON.stringify(input.selectedOptionIds),
      timestamp,
      timestamp,
    )
    .run();
}

export async function upsertMediaAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    mediaAssetId: number;
  },
): Promise<number> {
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO answers (
        response_id, question_id, json_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(response_id, question_id) DO UPDATE SET
        json_value = excluded.json_value,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.responseId,
      input.questionId,
      JSON.stringify({ mediaAssetId: input.mediaAssetId }),
      timestamp,
      timestamp,
    )
    .run();

  const existing = await db
    .prepare(
      "SELECT id FROM answers WHERE response_id = ? AND question_id = ? LIMIT 1",
    )
    .bind(input.responseId, input.questionId)
    .first<{ id: number }>();

  if (!existing) {
    throw new Error("Failed to upsert media answer");
  }

  return existing.id;
}
