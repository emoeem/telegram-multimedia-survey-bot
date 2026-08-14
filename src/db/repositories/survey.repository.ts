import type { Survey, SurveyStatus } from "../schema";
import { nowIso, toBoolean } from "../client";

interface SurveyRow {
  id: number;
  owner_id: number;
  title: string;
  description: string | null;
  cover_media_id: number | null;
  status: string;
  anonymous: number;
  allow_multiple_responses: number;
  max_responses_per_user: number;
  version: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  closed_at: string | null;
  archived_at: string | null;
}

function mapSurvey(row: SurveyRow): Survey {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    coverMediaId: row.cover_media_id,
    status: row.status as SurveyStatus,
    anonymous: toBoolean(row.anonymous),
    allowMultipleResponses: toBoolean(row.allow_multiple_responses),
    maxResponsesPerUser: row.max_responses_per_user,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    closedAt: row.closed_at,
    archivedAt: row.archived_at,
  };
}

export async function createSurvey(
  db: D1Database,
  input: {
    ownerId: number;
    title: string;
    description?: string | null;
    anonymous?: boolean;
    allowMultipleResponses?: boolean;
    maxResponsesPerUser?: number;
  },
): Promise<Survey> {
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO surveys (
        owner_id, title, description, anonymous,
        allow_multiple_responses, max_responses_per_user,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      input.ownerId,
      input.title,
      input.description ?? null,
      input.anonymous ? 1 : 0,
      input.allowMultipleResponses ? 1 : 0,
      input.maxResponsesPerUser ?? 1,
      timestamp,
      timestamp,
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to create survey");
  }

  const survey = await getSurveyById(db, id);
  if (!survey) {
    throw new Error("Failed to load created survey");
  }

  return survey;
}

export async function getSurveyById(
  db: D1Database,
  id: number,
): Promise<Survey | null> {
  const row = await db
    .prepare("SELECT * FROM surveys WHERE id = ? LIMIT 1")
    .bind(id)
    .first<SurveyRow>();

  return row ? mapSurvey(row) : null;
}

export async function listSurveysByOwner(
  db: D1Database,
  ownerId: number,
): Promise<Survey[]> {
  const result = await db
    .prepare("SELECT * FROM surveys WHERE owner_id = ? ORDER BY id DESC")
    .bind(ownerId)
    .all<SurveyRow>();

  return (result.results ?? []).map(mapSurvey);
}

export async function listAllSurveys(db: D1Database): Promise<Survey[]> {
  const result = await db
    .prepare("SELECT * FROM surveys ORDER BY id DESC")
    .all<SurveyRow>();

  return (result.results ?? []).map(mapSurvey);
}

export async function updateSurveyStatus(
  db: D1Database,
  id: number,
  status: SurveyStatus,
): Promise<Survey | null> {
  const timestamp = nowIso();
  await db
    .prepare(
      `UPDATE surveys SET
        status = ?,
        version = version + 1,
        updated_at = ?,
        published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END,
        closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END
       WHERE id = ?`,
    )
    .bind(status, timestamp, status, timestamp, status, timestamp, id)
    .run();

  return getSurveyById(db, id);
}

export async function deleteSurvey(
  db: D1Database,
  id: number,
): Promise<void> {
  await db.prepare("DELETE FROM surveys WHERE id = ?").bind(id).run();
}
