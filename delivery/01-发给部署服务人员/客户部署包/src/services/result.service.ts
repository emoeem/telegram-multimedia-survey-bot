import type {
  Answer,
  SurveyResponse,
  SurveyResponseStatus,
} from "../db/schema";

export interface ResponseListItem {
  id: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  respondent: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

export interface ResponseDetail {
  response: SurveyResponse;
  answers: Answer[];
  respondent: {
    telegramUserId: number;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

export async function listResponses(
  db: D1Database,
  surveyId: number,
  limit = 20,
  offset = 0,
  status?: SurveyResponseStatus,
): Promise<ResponseListItem[]> {
  const statusClause = status ? "AND status = ?" : "";
  const bindings = status
    ? [surveyId, status, limit, offset]
    : [surveyId, limit, offset];
  const result = await db
    .prepare(
      `SELECT r.id, r.status, r.started_at, r.completed_at,
              u.telegram_user_id, u.username, u.first_name, u.last_name
       FROM survey_responses r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.survey_id = ?
       ${statusClause}
       ORDER BY r.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings)
    .all<{
      id: number;
      status: string;
      started_at: string;
      completed_at: string | null;
      telegram_user_id: number | null;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    respondent: row.telegram_user_id === null
      ? null
      : {
          telegramUserId: row.telegram_user_id,
          username: row.username,
          firstName: row.first_name,
          lastName: row.last_name,
        },
  }));
}

export async function getResponseDetail(
  db: D1Database,
  responseId: number,
  anonymous = false,
): Promise<ResponseDetail | null> {
  const response = await db
    .prepare("SELECT * FROM survey_responses WHERE id = ? LIMIT 1")
    .bind(responseId)
    .first<Record<string, unknown>>();

  if (!response) {
    return null;
  }

  const answersResult = await db
    .prepare("SELECT * FROM answers WHERE response_id = ? ORDER BY id ASC")
    .bind(responseId)
    .all<Record<string, unknown>>();

  const answers: Answer[] = (answersResult.results ?? []).map((row) => ({
    id: Number(row["id"]),
    responseId: Number(row["response_id"]),
    questionId: Number(row["question_id"]),
    textValue: row["text_value"] === null ? null : String(row["text_value"]),
    numberValue: row["number_value"] === null ? null : Number(row["number_value"]),
    booleanValue: row["boolean_value"] === null ? null : Number(row["boolean_value"]) === 1,
    ratingValue: row["rating_value"] === null ? null : Number(row["rating_value"]),
    dateValue: row["date_value"] === null ? null : String(row["date_value"]),
    timeValue: row["time_value"] === null ? null : String(row["time_value"]),
    jsonValue: row["json_value"] === null ? null : String(row["json_value"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  }));

  const mappedResponse = {
    response: {
      id: Number(response["id"]),
      surveyId: Number(response["survey_id"]),
      userId: anonymous ? null : response["user_id"] === null ? null : Number(response["user_id"]),
      participantHash: anonymous ? "" : String(response["participant_hash"]),
      status: String(response["status"]) as SurveyResponse["status"],
      startedAt: String(response["started_at"]),
      completedAt: response["completed_at"] === null ? null : String(response["completed_at"]),
      submittedAt: response["submitted_at"] === null ? null : String(response["submitted_at"]),
      currentQuestionId: response["current_question_id"] === null ? null : Number(response["current_question_id"]),
      version: Number(response["version"]),
      createdAt: String(response["created_at"]),
      updatedAt: String(response["updated_at"]),
    },
    answers,
  };

  const respondent =
    !anonymous && mappedResponse.response.userId !== null
      ? await db
          .prepare(
            `SELECT telegram_user_id, username, first_name, last_name
             FROM users
             WHERE id = ?
             LIMIT 1`,
          )
          .bind(mappedResponse.response.userId)
          .first<{
            telegram_user_id: number;
            username: string | null;
            first_name: string | null;
            last_name: string | null;
          }>()
      : null;

  return {
    response: {
      ...mappedResponse.response,
      userId: anonymous ? null : mappedResponse.response.userId,
      participantHash: anonymous ? "" : mappedResponse.response.participantHash,
    },
    answers,
    respondent: respondent
      ? {
          telegramUserId: respondent.telegram_user_id,
          username: respondent.username,
          firstName: respondent.first_name,
          lastName: respondent.last_name,
        }
      : null,
  };
}
