import type { Env } from "../index";
import { fail, json } from "./api-response";
import { resolveParticipant } from "./survey/participant";
import { resolveViewerAgeVerified } from "../services/content-rating.service";
import { getSeriesDetail, listSeriesShelf } from "../services/series.service";
import { resolveListCoinPrices } from "../services/coin/unlock.service";
import { toggleSeriesFollow } from "../services/series-follow.service";

/**
 * 系列/连载公开 API（0083）：书架、详情（含续读/解锁/关注状态）、关注开关。
 * 身份是可选的——匿名可浏览，登录后多了续读与关注状态。
 */
export async function handleSeriesApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/series")) return null;

  const resolveViewer = async (): Promise<{ participantHash: string; ageVerified: boolean } | null> => {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return null;
    const ageVerified = await resolveViewerAgeVerified(request, env);
    return { participantHash: participant.participantHash, ageVerified };
  };

  if (request.method === "GET" && url.pathname === "/api/series") {
    const viewer = await resolveViewer();
    return json({ series: await listSeriesShelf(env.DB, viewer) });
  }

  const detailMatch = url.pathname.match(/^\/api\/series\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && detailMatch) {
    const viewer = await resolveViewer();
    const prices = await resolveListCoinPrices(
      env.DB,
      // 价格表按卷取；这里先取该系列章节的价格——为省一次 join，直接查全量
      // 价格映射（启用解锁的问卷数很小）。
      (
        await env.DB.prepare("SELECT survey_id AS surveyId FROM survey_coin_access WHERE enabled = 1").all<{
          surveyId: number;
        }>()
      ).results?.map((row) => Number(row.surveyId)) ?? [],
    );
    const detail = await getSeriesDetail(env.DB, String(detailMatch[1]), viewer, prices);
    if (!detail) return fail(404, "series_not_found", "系列不存在或未发布");
    return json({ series: detail });
  }

  const followMatch = url.pathname.match(/^\/api\/series\/(\d+)\/follow$/);
  if (request.method === "POST" && followMatch) {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    // 关注前必须先过该系列的分级门：r18 系列对未确认年龄者不可关注。
    const ageVerified = await resolveViewerAgeVerified(request, env);
    if (!ageVerified) {
      const chapters = await env.DB.prepare(
        "SELECT content_rating AS rating FROM surveys WHERE series_id = ? AND status = 'published' AND deleted_at IS NULL LIMIT 5",
      )
        .bind(Number(followMatch[1]))
        .all<{ rating: string | null }>();
      const restricted = (chapters.results ?? []).every((row) => row.rating === "r18");
      if (restricted) return fail(451, "age_restricted", "该内容为 18+ 内容，请先确认年龄后访问。");
    }
    const result = await toggleSeriesFollow(env.DB, participant.participantHash, Number(followMatch[1]));
    return json(result);
  }

  return null;
}
