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

export async function getActiveResponseBySurveyAndUser(
  db: D1Database,
  surveyId: number,
  userId: number,
): Promise<SurveyResponse | null> {
  const row = await db
    .prepare(
      `SELECT * FROM survey_responses
       WHERE survey_id = ? AND user_id = ? AND status = 'in_progress'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(surveyId, userId)
    .first<SurveyResponseRow>();

  return row ? mapResponse(row) : null;
}

export async function countCompletedResponsesBySurveyAndUser(
  db: D1Database,
  surveyId: number,
  userId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM survey_responses
       WHERE survey_id = ? AND user_id = ? AND status = 'completed'`,
    )
    .bind(surveyId, userId)
    .first<{ count: number }>();

  return row?.count ?? 0;
}

export async function getResponseBySurveyAndHash(
  db: D1Database,
  surveyId: number,
  participantHash: string,
): Promise<SurveyResponse | null> {
  const row = await db
    .prepare(
      `SELECT * FROM survey_responses
       WHERE survey_id = ? AND participant_hash = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(surveyId, participantHash)
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

export async function restartResponse(
  db: D1Database,
  id: number,
  currentQuestionId: number,
): Promise<SurveyResponse> {
  const timestamp = nowIso();
  await db.batch([
    db
      .prepare(
        `DELETE FROM answer_media
         WHERE answer_id IN (SELECT id FROM answers WHERE response_id = ?)`,
      )
      .bind(id),
    db
      .prepare(
        `DELETE FROM answer_options
         WHERE answer_id IN (SELECT id FROM answers WHERE response_id = ?)`,
      )
      .bind(id),
    db.prepare("DELETE FROM answers WHERE response_id = ?").bind(id),
    db
      .prepare(
        `UPDATE survey_responses
         SET status = 'in_progress',
             started_at = ?,
             completed_at = NULL,
             submitted_at = NULL,
             current_question_id = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(timestamp, currentQuestionId, timestamp, id),
  ]);

  const response = await getResponseById(db, id);
  if (!response) {
    throw new Error("Failed to restart survey response");
  }
  return response;
}

interface AnswerValues {
  textValue?: string | null;
  numberValue?: number | null;
  booleanValue?: boolean | null;
  ratingValue?: number | null;
  dateValue?: string | null;
  timeValue?: string | null;
  jsonValue?: string | null;
}

async function upsertAnswerValues(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    values: AnswerValues;
  },
): Promise<number> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO answers (
        response_id, question_id, text_value, number_value,
        boolean_value, rating_value, date_value, time_value,
        json_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(response_id, question_id) DO UPDATE SET
        text_value = excluded.text_value,
        number_value = excluded.number_value,
        boolean_value = excluded.boolean_value,
        rating_value = excluded.rating_value,
        date_value = excluded.date_value,
        time_value = excluded.time_value,
        json_value = excluded.json_value,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.responseId,
      input.questionId,
      input.values.textValue ?? null,
      input.values.numberValue ?? null,
      input.values.booleanValue === undefined ||
        input.values.booleanValue === null
        ? null
        : input.values.booleanValue
          ? 1
          : 0,
      input.values.ratingValue ?? null,
      input.values.dateValue ?? null,
      input.values.timeValue ?? null,
      input.values.jsonValue ?? null,
      timestamp,
      timestamp,
    )
    .run();

  const answer = await db
    .prepare(
      "SELECT id FROM answers WHERE response_id = ? AND question_id = ? LIMIT 1",
    )
    .bind(input.responseId, input.questionId)
    .first<{ id: number }>();

  if (!answer) {
    throw new Error("Failed to upsert answer");
  }
  return answer.id;
}

export async function upsertTextAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    textValue: string;
  },
): Promise<void> {
  await upsertAnswerValues(db, {
    responseId: input.responseId,
    questionId: input.questionId,
    values: { textValue: input.textValue },
  });
}

export async function upsertNumberAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    numberValue: number;
  },
): Promise<void> {
  await upsertAnswerValues(db, {
    responseId: input.responseId,
    questionId: input.questionId,
    values: { numberValue: input.numberValue },
  });
}

export async function upsertDateAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    dateValue: string;
  },
): Promise<void> {
  await upsertAnswerValues(db, {
    responseId: input.responseId,
    questionId: input.questionId,
    values: { dateValue: input.dateValue },
  });
}

export async function upsertTimeAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    timeValue: string;
  },
): Promise<void> {
  await upsertAnswerValues(db, {
    responseId: input.responseId,
    questionId: input.questionId,
    values: { timeValue: input.timeValue },
  });
}

export async function upsertOptionAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    selectedOptionIds: number[];
    booleanValue?: boolean | null;
    ratingValue?: number | null;
  },
): Promise<void> {
  const timestamp = nowIso();
  const answerId = await upsertAnswerValues(db, {
    responseId: input.responseId,
    questionId: input.questionId,
    values: {
      ...(input.booleanValue !== undefined
        ? { booleanValue: input.booleanValue }
        : {}),
      ...(input.ratingValue !== undefined
        ? { ratingValue: input.ratingValue }
        : {}),
      jsonValue: JSON.stringify(input.selectedOptionIds),
    },
  });

  await db
    .prepare("DELETE FROM answer_options WHERE answer_id = ?")
    .bind(answerId)
    .run();

  if (input.selectedOptionIds.length > 0) {
    await db.batch(
      input.selectedOptionIds.map((optionId) =>
        db
          .prepare(
            `INSERT INTO answer_options (
              answer_id, question_option_id, created_at
            ) VALUES (?, ?, ?)`,
          )
          .bind(answerId, optionId, timestamp),
      ),
    );
  }
}

export async function upsertMediaAnswer(
  db: D1Database,
  input: {
    responseId: number;
    questionId: number;
    mediaAssetId: number;
  },
): Promise<number> {
  const answerId = await upsertAnswerValues(db, {
    responseId: input.responseId,
    questionId: input.questionId,
    values: {
      jsonValue: JSON.stringify({ mediaAssetId: input.mediaAssetId }),
    },
  });

  await db
    .prepare("DELETE FROM answer_media WHERE answer_id = ?")
    .bind(answerId)
    .run();

  return answerId;
}

export async function deleteAnswer(
  db: D1Database,
  responseId: number,
  questionId: number,
): Promise<void> {
  const answer = await db
    .prepare(
      "SELECT id FROM answers WHERE response_id = ? AND question_id = ? LIMIT 1",
    )
    .bind(responseId, questionId)
    .first<{ id: number }>();
  if (!answer) {
    return;
  }

  await db.batch([
    db.prepare("DELETE FROM answer_media WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answer_options WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answers WHERE id = ?").bind(answer.id),
  ]);
}
