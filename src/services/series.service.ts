import { nowIso } from "../db/client";
import { HASH_SET_SQL } from "./identity-link.service";
import {
  countPublishedChapters,
  getSeriesBySlug,
  listChapters,
  listPublishedSeries,
  type SeriesChapter,
} from "../db/repositories/series.repository";
import { hasUnlock } from "./coin/unlock.service";

/**
 * 系列读侧（0083/0084）：可见性过滤与续读推导。
 *
 * 内容分级沿用 0080 的规则：未确认年龄的查看者看不到 r18 章节；一个系列
 * 只要有至少一个可见章节就出现在书架里。续读按查看者答卷状态推导
 * （canonical + sources 并集），不落存储。
 */

export interface SeriesChapterView extends SeriesChapter {
  completed: boolean;
  locked: boolean;
  coinPrice: number | null;
}

export interface SeriesListView {
  id: number;
  slug: string;
  title: string;
  description: string;
  coverUrl: string | null;
  chapterCount: number;
  completedCount: number;
  updatedAt: string;
}

export interface SeriesDetailView {
  id: number;
  slug: string;
  title: string;
  description: string;
  coverUrl: string | null;
  chapters: SeriesChapterView[];
  /** 续读目标：第一个未完成的可见章节；全部完成则为 null。 */
  nextChapterId: number | null;
  following: boolean;
  followerCount: number;
}

/** 查看者已完成章节的 survey_id 集合。 */
async function completedSurveyIds(db: D1Database, participantHash: string): Promise<Set<number>> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT survey_id AS surveyId FROM survey_responses
       WHERE participant_hash ${HASH_SET_SQL} AND status IN ('completed', 'archived')`,
    )
    .bind(participantHash, participantHash)
    .all<{ surveyId: number }>();
  return new Set((rows.results ?? []).map((row) => Number(row.surveyId)));
}

/** 章/系列可见性：0080 的年龄确认判定复用入口（由调用方解析后传入）。 */
function filterChaptersByRating(chapters: SeriesChapter[], ageVerified: boolean): SeriesChapter[] {
  return ageVerified ? chapters : chapters.filter((chapter) => chapter.contentRating !== "r18");
}

export async function listSeriesShelf(
  db: D1Database,
  viewer: { participantHash: string; ageVerified: boolean } | null,
): Promise<SeriesListView[]> {
  const seriesList = await listPublishedSeries(db);
  if (!seriesList.length) return [];
  const counts = await countPublishedChapters(db, seriesList.map((series) => series.id));
  const completed = viewer ? await completedSurveyIds(db, viewer.participantHash) : new Set<number>();
  const views: SeriesListView[] = [];
  for (const series of seriesList) {
    const total = counts.get(series.id) ?? 0;
    if (total === 0) continue;
    const chapters = filterChaptersByRating(await listChapters(db, series.id), viewer?.ageVerified ?? false);
    if (!chapters.length) continue;
    const completedCount = chapters.filter((chapter) => completed.has(chapter.surveyId)).length;
    views.push({
      id: series.id,
      slug: series.slug,
      title: series.title,
      description: series.description,
      coverUrl: series.coverMediaId === null ? null : `/api/survey/media/${series.coverMediaId}`,
      chapterCount: chapters.length,
      completedCount,
      updatedAt: series.updatedAt,
    });
  }
  return views;
}

export async function getSeriesDetail(
  db: D1Database,
  slug: string,
  viewer: { participantHash: string; ageVerified: boolean } | null,
  coinPrices: Map<number, number>,
): Promise<SeriesDetailView | null> {
  const series = await getSeriesBySlug(db, slug);
  if (!series || series.status !== "published") return null;
  const chapters = filterChaptersByRating(await listChapters(db, series.id), viewer?.ageVerified ?? false);
  const completed = viewer ? await completedSurveyIds(db, viewer.participantHash) : new Set<number>();
  const chapterViews: SeriesChapterView[] = [];
  for (const chapter of chapters) {
    const price = coinPrices.get(chapter.surveyId) ?? null;
    // 价格 0 = 活动免费开放，不算锁；真实解锁状态走 unlock.service 的并集判定
    //（0082：合并前用旧身份买过的解锁继续有效）。
    const unlocked = price === null || price <= 0 ? true : viewer ? await hasUnlock(db, chapter.surveyId, viewer.participantHash) : false;
    chapterViews.push({
      ...chapter,
      completed: completed.has(chapter.surveyId),
      locked: !unlocked,
      coinPrice: price,
    });
  }
  const next = chapterViews.find((chapter) => !chapter.completed);
  const followRow = viewer
    ? await db
        .prepare("SELECT 1 AS found FROM series_follows WHERE participant_hash = ? AND series_id = ? LIMIT 1")
        .bind(viewer.participantHash, series.id)
        .first()
    : null;
  const followerCount = await db
    .prepare("SELECT COUNT(*) AS n FROM series_follows WHERE series_id = ?")
    .bind(series.id)
    .first<{ n: number }>();
  return {
    id: series.id,
    slug: series.slug,
    title: series.title,
    description: series.description,
    coverUrl: series.coverMediaId === null ? null : `/api/survey/media/${series.coverMediaId}`,
    chapters: chapterViews,
    nextChapterId: next?.surveyId ?? null,
    following: Boolean(followRow),
    followerCount: Number(followerCount?.n ?? 0),
  };
}


