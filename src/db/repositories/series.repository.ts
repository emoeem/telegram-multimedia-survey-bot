import { nowIso } from "../client";

/**
 * 系列/连载（0083）：问卷 = 一章。仓库层只管 series 行与章节归属；
 * 可见性/续读推导在 series.service。
 */

export type SeriesStatus = "draft" | "published";

export interface SurveySeries {
  id: number;
  slug: string;
  title: string;
  description: string;
  coverMediaId: number | null;
  ownerId: number;
  status: SeriesStatus;
  createdAt: string;
  updatedAt: string;
}

interface SeriesRow {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  cover_media_id: number | null;
  owner_id: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapSeries(row: SeriesRow): SurveySeries {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? "",
    coverMediaId: row.cover_media_id,
    ownerId: row.owner_id,
    status: row.status === "draft" ? "draft" : "published",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SERIES_COLUMNS = "id, slug, title, description, cover_media_id, owner_id, status, created_at, updated_at";

export interface CreateSeriesInput {
  ownerId: number;
  slug: string;
  title: string;
  description?: string | null;
  coverMediaId?: number | null;
  status?: SeriesStatus;
}

export async function createSeries(db: D1Database, input: CreateSeriesInput): Promise<SurveySeries> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO survey_series (slug, title, description, cover_media_id, owner_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.slug,
      input.title,
      input.description ?? "",
      input.coverMediaId ?? null,
      input.ownerId,
      input.status ?? "published",
      timestamp,
      timestamp,
    )
    .run();
  const created = await getSeriesBySlug(db, input.slug);
  if (!created) throw new Error("series_insert_failed");
  return created;
}

export async function updateSeries(
  db: D1Database,
  id: number,
  patch: { title?: string; description?: string | null; coverMediaId?: number | null; status?: SeriesStatus },
): Promise<SurveySeries | null> {
  const updates: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    updates.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.description !== undefined) {
    updates.push("description = ?");
    binds.push(patch.description ?? "");
  }
  if (patch.coverMediaId !== undefined) {
    updates.push("cover_media_id = ?");
    binds.push(patch.coverMediaId ?? null);
  }
  if (patch.status !== undefined) {
    updates.push("status = ?");
    binds.push(patch.status);
  }
  if (!updates.length) return getSeriesById(db, id);
  updates.push("updated_at = ?");
  binds.push(nowIso(), id);
  await db
    .prepare(`UPDATE survey_series SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getSeriesById(db, id);
}

export async function getSeriesById(db: D1Database, id: number): Promise<SurveySeries | null> {
  const row = await db
    .prepare(`SELECT ${SERIES_COLUMNS} FROM survey_series WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<SeriesRow>();
  return row ? mapSeries(row) : null;
}

export async function getSeriesBySlug(db: D1Database, slug: string): Promise<SurveySeries | null> {
  const row = await db
    .prepare(`SELECT ${SERIES_COLUMNS} FROM survey_series WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<SeriesRow>();
  return row ? mapSeries(row) : null;
}

export async function listSeriesByOwner(db: D1Database, ownerId: number): Promise<SurveySeries[]> {
  const result = await db
    .prepare(`SELECT ${SERIES_COLUMNS} FROM survey_series WHERE owner_id = ? ORDER BY id DESC`)
    .bind(ownerId)
    .all<SeriesRow>();
  return (result.results ?? []).map(mapSeries);
}

/** 已发布的系列（公开书架），新章节优先。 */
export async function listPublishedSeries(db: D1Database, limit = 50): Promise<SurveySeries[]> {
  const result = await db
    .prepare(`SELECT ${SERIES_COLUMNS} FROM survey_series WHERE status = 'published' ORDER BY updated_at DESC LIMIT ?`)
    .bind(limit)
    .all<SeriesRow>();
  return (result.results ?? []).map(mapSeries);
}

export async function slugExists(db: D1Database, slug: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM survey_series WHERE slug = ? LIMIT 1").bind(slug).first();
  return Boolean(row);
}

// ---- 章节归属 ----

export interface SeriesChapter {
  surveyId: number;
  title: string;
  order: number;
  status: string;
  contentRating: string;
  accessCodeRequired: boolean;
  coverMediaId: number | null;
  publishedAt: string | null;
}

/** 章节列表：已发布系列取 published；作者视图（includeDrafts）取全部。 */
export async function listChapters(
  db: D1Database,
  seriesId: number,
  options: { includeDrafts?: boolean } = {},
): Promise<SeriesChapter[]> {
  const statusCondition = options.includeDrafts ? "" : " AND s.status = 'published'";
  const result = await db
    .prepare(
      `SELECT s.id surveyId, s.title, s.series_order AS "order", s.status, s.content_rating contentRating,
              s.access_code accessCode, s.cover_media_id coverMediaId, s.published_at publishedAt
       FROM surveys s
       WHERE s.series_id = ? AND s.deleted_at IS NULL${statusCondition}
       ORDER BY COALESCE(s.series_order, 999), s.id`,
    )
    .bind(seriesId)
    .all<{
      surveyId: number;
      title: string;
      order: number | null;
      status: string;
      contentRating: string | null;
      accessCode: string | null;
      coverMediaId: number | null;
      publishedAt: string | null;
    }>();
  return (result.results ?? []).map((row) => ({
    surveyId: row.surveyId,
    title: row.title,
    order: row.order ?? 0,
    status: row.status,
    contentRating: row.contentRating === "r18" ? "r18" : "all",
    accessCodeRequired: Boolean(row.accessCode),
    coverMediaId: row.coverMediaId,
    publishedAt: row.publishedAt,
  }));
}

/**
 * 多个系列的章节一次查回（按 seriesId 分组），列与排序语义同 {@link listChapters}。
 *
 * 管理端系列列表原先对每个系列单独 `listChapters`（N+1）；作者系列数会一直涨，
 * 这里一条 IN 查询取全量后在内存里分组（组内仍按 series_order, id 排序）。
 */
export async function listChaptersForSeries(
  db: D1Database,
  seriesIds: number[],
  options: { includeDrafts?: boolean } = {},
): Promise<Map<number, SeriesChapter[]>> {
  const grouped = new Map<number, SeriesChapter[]>();
  if (!seriesIds.length) return grouped;
  const statusCondition = options.includeDrafts ? "" : " AND s.status = 'published'";
  const result = await db
    .prepare(
      `SELECT s.id AS surveyId, s.series_id AS ownerSeriesId, s.title, s.series_order AS "order", s.status, s.content_rating contentRating,
              s.access_code accessCode, s.cover_media_id coverMediaId, s.published_at publishedAt
       FROM surveys s
       WHERE s.series_id IN (${seriesIds.map(() => "?").join(",")}) AND s.deleted_at IS NULL${statusCondition}
       ORDER BY COALESCE(s.series_order, 999), s.id`,
    )
    .bind(...seriesIds)
    .all<{
      surveyId: number;
      ownerSeriesId: number;
      title: string;
      order: number | null;
      status: string;
      contentRating: string | null;
      accessCode: string | null;
      coverMediaId: number | null;
      publishedAt: string | null;
    }>();
  for (const row of result.results ?? []) {
    const list = grouped.get(row.ownerSeriesId) ?? [];
    list.push({
      surveyId: row.surveyId,
      title: row.title,
      order: row.order ?? 0,
      status: row.status,
      contentRating: row.contentRating === "r18" ? "r18" : "all",
      accessCodeRequired: Boolean(row.accessCode),
      coverMediaId: row.coverMediaId,
      publishedAt: row.publishedAt,
    });
    grouped.set(row.ownerSeriesId, list);
  }
  return grouped;
}

/** 章节计数（公开列表徽章用）：只数 published。 */
export async function countPublishedChapters(db: D1Database, seriesIds: number[]): Promise<Map<number, number>> {
  if (!seriesIds.length) return new Map();
  const placeholders = seriesIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT series_id AS seriesId, COUNT(*) AS n FROM surveys
       WHERE series_id IN (${placeholders}) AND status = 'published' AND deleted_at IS NULL
       GROUP BY series_id`,
    )
    .bind(...seriesIds)
    .all<{ seriesId: number; n: number }>();
  const map = new Map<number, number>();
  for (const row of result.results ?? []) map.set(Number(row.seriesId), Number(row.n));
  return map;
}

/** 把问卷挂到/摘出系列。挂载时按入参落顺序。 */
export async function attachSurveyToSeries(
  db: D1Database,
  surveyId: number,
  seriesId: number | null,
  order: number | null,
): Promise<void> {
  await db
    .prepare("UPDATE surveys SET series_id = ?, series_order = ?, updated_at = ? WHERE id = ?")
    .bind(seriesId, order, nowIso(), surveyId)
    .run();
}

/** 系列 ID 反查（作者归属校验用）。 */
export async function getSurveySeriesRef(
  db: D1Database,
  surveyId: number,
): Promise<{ seriesId: number | null; order: number | null }> {
  const row = await db
    .prepare('SELECT series_id AS seriesId, series_order AS "order" FROM surveys WHERE id = ? LIMIT 1')
    .bind(surveyId)
    .first<{ seriesId: number | null; order: number | null }>();
  return { seriesId: row?.seriesId ?? null, order: row?.order ?? null };
}
