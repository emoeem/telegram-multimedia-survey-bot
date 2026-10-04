import type { Env } from "../index";
import { fail, json, resolveParticipant } from "./survey-api";
import { loadSystemSettings } from "../services/system-settings.service";
import { getPublishedGalleryProfile } from "../services/profile-gallery.service";
import { loadAchievementOverview, markAchievementsSeen } from "../services/achievement.service";
import { syncShowcasePersonFromProfile } from "../services/showcase-profile.service";

/**
 * "我的" 个人中心（/me）的聚合接口。
 *
 * 所有归属都按参与者身份（participantHash）计算：匿名、邮箱、Telegram 三种
 * 身份各有独立 hash，绑定 Telegram 后历史数据不会自动合并——这与挑战排行
 * 榜的既有语义一致，接口只如实反映当前身份下的数据。
 */
export async function handleMeApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/me/")) return null;

  if (request.method === "GET" && url.pathname === "/api/me/overview") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const hash = participant.participantHash;

    const [settings, responseStats, myProfileRow, trialStats, achievements] = await Promise.all([
      loadSystemSettings(env.DB),
      env.DB.prepare(
        `SELECT COUNT(*) AS completed FROM survey_responses
         WHERE participant_hash = ? AND status = 'completed'`,
      )
        .bind(hash)
        .first<{ completed: number }>(),
      env.DB.prepare(
        `SELECT id FROM survey_responses
         WHERE participant_hash = ? AND gallery_published = 1
         ORDER BY COALESCE(gallery_published_at, created_at) DESC
         LIMIT 1`,
      )
        .bind(hash)
        .first<{ id: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(MAX(score), 0) AS bestScore
         FROM task_runs WHERE participant_hash = ?`,
      )
        .bind(hash)
        .first<{ runs: number; completed: number; bestScore: number }>(),
      loadAchievementOverview(env.DB, hash),
    ]);

    const profileSurveyId = Number(settings.profileGallerySurveyId);
    const myProfileResponseId = myProfileRow?.id ?? null;
    const profile = myProfileResponseId !== null ? await getPublishedGalleryProfile(env.DB, myProfileResponseId) : null;
    const headingIndex = profile
      ? profile.fields.findIndex((field) => /姓名|名字|昵称|称呼|name/i.test(field.title))
      : -1;
    // 展示页软连接（0065 预留的 response_id）：只有发布过资料卡才可能有。
    const showcaseRow =
      myProfileResponseId === null
        ? null
        : await env.DB.prepare("SELECT id, published FROM showcase_persons WHERE response_id = ? LIMIT 1")
            .bind(myProfileResponseId)
            .first<{ id: number; published: number }>();

    return json({
      identity: { telegram: participant.kind === "telegram" },
      completedSurveys: Number(responseStats?.completed ?? 0),
      profileSurveyId: Number.isInteger(profileSurveyId) && profileSurveyId > 0 ? profileSurveyId : null,
      myProfile:
        profile && myProfileResponseId !== null
          ? {
              responseId: myProfileResponseId,
              heading: headingIndex >= 0 ? (profile.fields[headingIndex]?.value ?? null) : null,
              publishedAt: profile.publishedAt ?? profile.createdAt,
            }
          : null,
      trial: {
        runs: Number(trialStats?.runs ?? 0),
        completed: Number(trialStats?.completed ?? 0),
        bestScore: Number(trialStats?.bestScore ?? 0),
      },
      achievements,
      showcase: showcaseRow
        ? { personId: Number(showcaseRow.id), published: Number(showcaseRow.published) === 1 }
        : null,
    });
  }

  // Opening 「我的」 is what "reads" the badges: the response above carries the
  // unseen flag so the client can show the dot before this lands.
  if (request.method === "POST" && url.pathname === "/api/me/achievements/seen") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const marked = await markAchievementsSeen(env.DB, participant.participantHash);
    return json({ ok: true, marked });
  }

  // 把自己的资料卡生成一个展示页草稿（展示区是策展空间，公开与否归管理员）。
  if (request.method === "POST" && url.pathname === "/api/me/showcase") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    if (participant.kind !== "telegram" || participant.dbUserId === null) {
      return fail(403, "identity_required", "生成展示页需要 Telegram 身份，请从机器人打开「我的」");
    }
    const profileRow = await env.DB.prepare(
      `SELECT id FROM survey_responses
       WHERE participant_hash = ? AND gallery_published = 1
       ORDER BY COALESCE(gallery_published_at, created_at) DESC
       LIMIT 1`,
    )
      .bind(participant.participantHash)
      .first<{ id: number }>();
    if (!profileRow) {
      return fail(400, "profile_required", "先填写并发布个人资料卡，才能生成展示页");
    }
    const profile = await getPublishedGalleryProfile(env.DB, Number(profileRow.id));
    if (!profile) return fail(404, "profile_not_found", "资料卡不存在或未公开");
    try {
      const result = await syncShowcasePersonFromProfile(env.DB, profile, { ownerUserId: participant.dbUserId });
      return json({
        showcase: {
          personId: result.personId,
          created: result.created,
          published: result.published,
          url: `/showcase?p=${result.personId}`,
        },
      });
    } catch (error) {
      console.error("Showcase person sync failed", { responseId: profile.responseId, error });
      return fail(500, "showcase_sync_failed", "展示页生成失败，请稍后重试");
    }
  }

  return fail(404, "not_found", "接口不存在");
}
