import type { SurveyPage } from "../schema";
import { nowIso } from "../client";

interface PageRow {
  id: number;
  survey_id: number;
  title: string | null;
  description: string | null;
  order: number;
  created_at: string;
  updated_at: string;
}

function mapPage(row: PageRow): SurveyPage {
  return {
    id: row.id,
    surveyId: row.survey_id,
    title: row.title,
    description: row.description,
    order: row.order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSurveyPages(
  db: D1Database,
  surveyId: number,
): Promise<SurveyPage[]> {
  const result = await db
    .prepare(
      `SELECT * FROM survey_pages
       WHERE survey_id = ?
       ORDER BY "order" ASC, id ASC`,
    )
    .bind(surveyId)
    .all<PageRow>();
  return (result.results ?? []).map(mapPage);
}

export async function getSurveyPageById(
  db: D1Database,
  id: number,
): Promise<SurveyPage | null> {
  const row = await db
    .prepare("SELECT * FROM survey_pages WHERE id = ? LIMIT 1")
    .bind(id)
    .first<PageRow>();
  return row ? mapPage(row) : null;
}

export async function createSurveyPage(
  db: D1Database,
  input: {
    surveyId: number;
    title?: string | null;
    description?: string | null;
    order: number;
  },
): Promise<number> {
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO survey_pages (
        survey_id, title, description, "order", created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.surveyId,
      input.title ?? null,
      input.description ?? null,
      input.order,
      timestamp,
      timestamp,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("Failed to create survey page");
  return id;
}

export async function updateSurveyPage(
  db: D1Database,
  id: number,
  input: { title?: string | null; description?: string | null; order?: number },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.title !== undefined) {
    sets.push("title = ?");
    binds.push(input.title);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    binds.push(input.description);
  }
  if (input.order !== undefined) {
    sets.push('"order" = ?');
    binds.push(input.order);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  binds.push(nowIso(), id);
  await db
    .prepare(`UPDATE survey_pages SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function deleteSurveyPage(
  db: D1Database,
  id: number,
): Promise<void> {
  const page = await getSurveyPageById(db, id);
  if (!page) return;
  const timestamp = nowIso();
  await db.batch([
    db.prepare("DELETE FROM survey_pages WHERE id = ?").bind(id),
    db
      .prepare(
        `UPDATE survey_questions
         SET page_id = NULL, updated_at = ?
         WHERE page_id = ?`,
      )
      .bind(timestamp, id),
    db
      .prepare(
        `UPDATE survey_pages
         SET "order" = "order" - 1, updated_at = ?
         WHERE survey_id = ? AND "order" > ?`,
      )
      .bind(timestamp, page.surveyId, page.order),
  ]);
}

export async function normalizePageOrder(
  db: D1Database,
  surveyId: number,
  orderedIds: number[],
): Promise<void> {
  const timestamp = nowIso();
  await db.batch(
    orderedIds.map((id, index) =>
      db
        .prepare(
          `UPDATE survey_pages SET "order" = ?, updated_at = ?
           WHERE id = ? AND survey_id = ?`,
        )
        .bind(index, timestamp, id, surveyId),
    ),
  );
}
