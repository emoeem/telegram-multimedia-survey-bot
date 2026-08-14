import type { Survey } from "../db/schema";
import { getSurveyById, listSurveysByOwner } from "../db/repositories/survey.repository";

export async function getPublishedSurveys(
  db: D1Database,
): Promise<Survey[]> {
  const result = await db
    .prepare(
      "SELECT * FROM surveys WHERE status = 'published' ORDER BY id DESC",
    )
    .all();

  return (result.results ?? []).map((row) => {
    const surveyRow = row as Record<string, unknown>;
    return {
      id: Number(surveyRow["id"]),
      ownerId: Number(surveyRow["owner_id"]),
      title: String(surveyRow["title"]),
      description: surveyRow["description"] === null ? null : String(surveyRow["description"]),
      coverMediaId: surveyRow["cover_media_id"] === null ? null : Number(surveyRow["cover_media_id"]),
      status: String(surveyRow["status"]) as Survey["status"],
      anonymous: Number(surveyRow["anonymous"]) === 1,
      allowMultipleResponses: Number(surveyRow["allow_multiple_responses"]) === 1,
      maxResponsesPerUser: Number(surveyRow["max_responses_per_user"]),
      version: Number(surveyRow["version"]),
      createdAt: String(surveyRow["created_at"]),
      updatedAt: String(surveyRow["updated_at"]),
      publishedAt: surveyRow["published_at"] === null ? null : String(surveyRow["published_at"]),
      closedAt: surveyRow["closed_at"] === null ? null : String(surveyRow["closed_at"]),
      archivedAt: surveyRow["archived_at"] === null ? null : String(surveyRow["archived_at"]),
    };
  });
}

export async function getSurveyDetail(
  db: D1Database,
  surveyId: number,
): Promise<Survey | null> {
  return getSurveyById(db, surveyId);
}

export async function listMySurveys(
  db: D1Database,
  ownerId: number,
): Promise<Survey[]> {
  return listSurveysByOwner(db, ownerId);
}
