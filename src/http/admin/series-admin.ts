import type { Env } from "../../index";
import { getSurveyById } from "../../db/repositories/survey.repository";
import {
  attachSurveyToSeries,
  createSeries,
  getSeriesById,
  getSurveySeriesRef,
  listChapters,
  listSeriesByOwner,
  slugExists,
  updateSeries,
} from "../../db/repositories/series.repository";
import type { WriteContext } from "./helpers";

/**
 * 系列管理（0083，作者侧）：创建/编辑系列、挂载/摘除章节。
 * 归属校验与问卷编辑一致：作者只动自己的系列与问卷，管理员豁免。
 */
export async function handleAdminSeriesWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;
  if (!url.pathname.startsWith("/api/admin/series")) return null;

  const requireSeriesOwnership = async (seriesId: number) => {
    const series = await getSeriesById(db, seriesId);
    if (!series) return fail(404, "series_not_found", "系列不存在");
    if (!isAdmin && series.ownerId !== user.id) return fail(403, "forbidden", "无权管理该系列");
    return series;
  };

  if (request.method === "GET" && url.pathname === "/api/admin/series") {
    const seriesList = await listSeriesByOwner(db, user.id);
    const withChapters = await Promise.all(
      seriesList.map(async (series) => ({
        ...series,
        chapters: await listChapters(db, series.id, { includeDrafts: true }),
      })),
    );
    return json({ series: withChapters });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/series") {
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!title) return fail(400, "validation_failed", "系列标题不能为空");
    let slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    if (slug) {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return fail(400, "validation_failed", "slug 只能是小写字母、数字与连字符");
      if (await slugExists(db, slug)) return fail(409, "slug_taken", "该 slug 已被使用");
    } else {
      do {
        slug = `s-${crypto.randomUUID().slice(0, 8)}`;
      } while (await slugExists(db, slug));
    }
    const description = typeof body.description === "string" ? body.description.slice(0, 1000) : "";
    const coverMediaId = typeof body.coverMediaId === "number" ? body.coverMediaId : null;
    const status = body.status === "draft" ? "draft" : "published";
    const series = await createSeries(db, {
      ownerId: user.id,
      slug,
      title,
      description,
      coverMediaId,
      status,
    });
    return new Response(JSON.stringify({ series }), { status: 201, headers: { "Content-Type": "application/json" } });
  }

  const seriesMatch = url.pathname.match(/^\/api\/admin\/series\/(\d+)(\/.*)?$/);
  if (!seriesMatch) return null;
  const seriesId = Number(seriesMatch[1]);
  const rest = seriesMatch[2] ?? "";

  if (request.method === "PATCH" && rest === "") {
    const series = await requireSeriesOwnership(seriesId);
    if (series instanceof Response) return series;
    const patch: { title?: string; description?: string | null; status?: "draft" | "published" } = {};
    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
      if (!title) return fail(400, "validation_failed", "系列标题不能为空");
      patch.title = title;
    }
    if (body.description !== undefined) {
      patch.description = typeof body.description === "string" ? body.description.slice(0, 1000) : "";
    }
    if (body.status !== undefined) {
      if (body.status !== "draft" && body.status !== "published") return fail(400, "validation_failed", "状态无效");
      patch.status = body.status;
    }
    const updated = await updateSeries(db, seriesId, patch);
    return json({ series: updated });
  }

  // 挂载章节：{surveyId, order}。一份问卷只属于一个系列；重复挂载视为改序。
  if (request.method === "POST" && rest === "/chapters") {
    const series = await requireSeriesOwnership(seriesId);
    if (series instanceof Response) return series;
    const surveyId = Number(body.surveyId);
    if (!Number.isInteger(surveyId) || surveyId <= 0) return fail(400, "validation_failed", "surveyId 无效");
    const survey = await getSurveyById(db, surveyId);
    if (!survey) return fail(404, "survey_not_found", "问卷不存在");
    if (!isAdmin && survey.ownerId !== user.id) return fail(403, "forbidden", "只能挂载自己的问卷");
    const order = Number(body.order);
    if (!Number.isInteger(order) || order < 1 || order > 999) {
      return fail(400, "validation_failed", "章节序号必须是 1-999 的整数");
    }
    await attachSurveyToSeries(db, surveyId, seriesId, order);
    return json({ ok: true, chapters: await listChapters(db, seriesId, { includeDrafts: true }) });
  }

  const detachMatch = rest.match(/^\/chapters\/(\d+)$/);
  if (request.method === "DELETE" && detachMatch) {
    const series = await requireSeriesOwnership(seriesId);
    if (series instanceof Response) return series;
    const surveyId = Number(detachMatch[1]);
    const ref = await getSurveySeriesRef(db, surveyId);
    if (ref.seriesId !== seriesId) return fail(404, "chapter_not_found", "该问卷不在此系列中");
    await attachSurveyToSeries(db, surveyId, null, null);
    return json({ ok: true, chapters: await listChapters(db, seriesId, { includeDrafts: true }) });
  }

  return null;
}
