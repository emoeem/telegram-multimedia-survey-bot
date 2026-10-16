import type { Env } from "../index";
import { fail, json, resolveParticipant } from "./survey-api";
import { loadSystemSettings } from "../services/system-settings.service";
import { getPublishedGalleryProfile } from "../services/profile-gallery.service";
import { loadAchievementOverview, markAchievementsSeen } from "../services/achievement.service";
import { syncShowcasePersonFromProfile } from "../services/showcase-profile.service";
import { createReportAccessTokens } from "../services/report-access-token.service";
import { getAgeAttestation, setAgeVerified } from "../services/content-rating.service";
import { checkRateLimit, rateLimitResponse } from "../services/rate-limit.service";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getResultProfileByResponseId } from "../db/repositories/result-profile.repository";
import { revokeReportShare, upsertReportShare } from "../services/report-share.service";
import { hashesFor } from "../services/identity-link.service";
import { listNotifications, markNotificationsSeen } from "../services/series-follow.service";
import { getActiveProfileShareFor, revokeProfileShare, upsertProfileShare } from "../services/profile-share.service";

/** 一次最多返回的报告数：`/me` 是移动端列表，50 条足够回溯到很久以前。 */
const MY_REPORTS_LIMIT = 50;

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
    // 0082 并集：绑定前的旧身份数据（web_*/email_*）原地保留，这里一次查全。
    const myHashes = await hashesFor(env.DB, hash);
    const hashPlaceholders = myHashes.map(() => "?").join(",");

    const [settings, responseStats, myProfileRow, trialStats, achievements] = await Promise.all([
      loadSystemSettings(env.DB),
      env.DB.prepare(
        `SELECT COUNT(*) AS completed FROM survey_responses
         WHERE participant_hash IN (${hashPlaceholders}) AND status = 'completed'`,
      )
        .bind(...myHashes)
        .first<{ completed: number }>(),
      env.DB.prepare(
        `SELECT id FROM survey_responses
         WHERE participant_hash IN (${hashPlaceholders}) AND gallery_published = 1
         ORDER BY COALESCE(gallery_published_at, created_at) DESC
         LIMIT 1`,
      )
        .bind(...myHashes)
        .first<{ id: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(MAX(score), 0) AS bestScore
         FROM task_runs WHERE participant_hash IN (${hashPlaceholders})`,
      )
        .bind(...myHashes)
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
        : await env.DB.prepare(
            "SELECT id, published FROM showcase_persons WHERE response_id = ? AND deleted_at IS NULL LIMIT 1",
          )
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

  /**
   * 「我的报告」：参与者自己找回已完成答卷的报告入口。
   *
   * 完成页只出现过一次带 token 的报告链接，离开之后就再也拿不到——用户要求
   * "填完之后能查看/下载自己的报告"。这里按参与者身份列出已完成的答卷，并为
   * 每条**现铸**一个 30 天 token（HMAC 是无状态签名，现铸没有存储成本）。
   *
   * 归属与 /answers 一样只认服务端解析出的 participantHash：匿名浏览器 key、
   * 邮箱会话、Telegram initData 各对应自己的 hash，谁也无法列出别人的报告；
   * 该 hash 本来就允许续答与读取本人答案，信任级别不变。被作者删除的问卷
   * （deleted_at 非空）连同其报告一起不再出现——删除是作者的明确意图。
   */
  if (request.method === "GET" && url.pathname === "/api/me/reports") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const myHashes = await hashesFor(env.DB, participant.participantHash);
    const rows = await env.DB.prepare(
      `SELECT r.id responseId, r.survey_id surveyId, r.completed_at completedAt,
              COALESCE(s.title, '问卷 #' || r.survey_id) title
         FROM survey_responses r
         JOIN surveys s ON s.id = r.survey_id AND s.deleted_at IS NULL
        WHERE r.participant_hash IN (${myHashes.map(() => "?").join(",")})
          AND r.status IN ('completed', 'archived')
        ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.id DESC
        LIMIT ?`,
    )
      .bind(...myHashes, MY_REPORTS_LIMIT)
      .all<{ responseId: number; surveyId: number; completedAt: string | null; title: string }>();
    const reportRows = rows.results ?? [];
    // Token 批量铸造：只 importKey 一次（50 个逐个铸造 ≈9.6ms CPU，顶到 Workers
    // 免费版单请求 10ms 上限；批量 ≈1ms）。
    const tokens = await createReportAccessTokens(
      env.WEBHOOK_SECRET,
      reportRows.map((row) => row.responseId),
    );
    const reports = reportRows.map((row) => {
      const encoded = encodeURIComponent(tokens.get(row.responseId) ?? "");
      return {
        responseId: row.responseId,
        surveyId: row.surveyId,
        title: row.title,
        completedAt: row.completedAt,
        reportUrl: `/report/${row.responseId}?t=${encoded}`,
        pdfUrl: `/report/${row.responseId}.pdf?t=${encoded}`,
      };
    });
    return json({ reports });
  }

  /**
   * 报告分享卡（0081）：为某份本人答卷创建/查询公开结局卡链接。幂等——
   * 重复调用返回同一链接；撤销后再调用会换新 token 复活。创建需要答卷归属
   * 当前身份且已完成；快照字段（结局名/卷名/分级）在创建时刻定格。
   */
  if (request.method === "POST" && /^\/api\/me\/reports\/\d+\/share$/.test(url.pathname)) {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const responseId = Number(url.pathname.match(/^\/api\/me\/reports\/(\d+)\/share$/)![1]);
    const limiter = await checkRateLimit(env.CACHE, "report-share", participant.participantHash, 5, 24 * 3600);
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    const myHashes = await hashesFor(env.DB, participant.participantHash);
    const owned = await env.DB.prepare(
      `SELECT id, survey_id surveyId FROM survey_responses
       WHERE id = ? AND participant_hash IN (${myHashes.map(() => "?").join(",")})
         AND status IN ('completed', 'archived') LIMIT 1`,
    )
      .bind(responseId, ...myHashes)
      .first<{ id: number; surveyId: number }>();
    if (!owned) return fail(404, "report_not_found", "答卷不存在或未完成");
    const [survey, profile] = await Promise.all([
      getSurveyById(env.DB, owned.surveyId),
      getResultProfileByResponseId(env.DB, responseId),
    ]);
    const share = await upsertReportShare(env.DB, {
      responseId,
      participantHash: participant.participantHash,
      surveyId: owned.surveyId,
      surveyTitle: survey?.title ?? null,
      resultType: profile?.resultType ?? null,
      resultTitle: profile?.title ?? null,
      contentRating: survey?.contentRating === "r18" ? "r18" : "all",
    });
    return json({
      share: {
        url: `/r/${share.token}`,
        ogUrl: `/r/${share.token}/og.png`,
        createdAt: share.createdAt,
        viewCount: share.viewCount,
      },
    });
  }

  if (request.method === "DELETE" && /^\/api\/me\/reports\/\d+\/share$/.test(url.pathname)) {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const responseId = Number(url.pathname.match(/^\/api\/me\/reports\/(\d+)\/share$/)![1]);
    const revoked = await revokeReportShare(env.DB, responseId, participant.participantHash);
    return json({ ok: true, revoked });
  }

  // 内容分级偏好（0080）：年龄确认是 r18 公开面/入口的唯一钥匙。匿名浏览器
  // key 也允许确认（attestation 按 participant_hash 记录，换设备需重新确认）；
  // 撤销只影响今后可见性，不改变已产生的答卷归属。
  if (request.method === "GET" && url.pathname === "/api/me/preferences") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const attestation = await getAgeAttestation(env.DB, participant.participantHash);
    return json({ ageVerifiedAt: attestation?.ageVerifiedAt ?? null });
  }

  if (request.method === "POST" && url.pathname === "/api/me/preferences") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const body = (await request.json().catch(() => null)) as { ageVerified?: unknown } | null;
    if (typeof body?.ageVerified !== "boolean") {
      return fail(400, "validation_failed", "ageVerified 必须是布尔值");
    }
    await setAgeVerified(env.DB, participant.participantHash, body.ageVerified);
    const attestation = await getAgeAttestation(env.DB, participant.participantHash);
    return json({ ageVerifiedAt: attestation?.ageVerifiedAt ?? null });
  }

  // 站内通知（0084）：连载更新、召回入口。未读数常驻「我的」页红点。
  if (request.method === "GET" && url.pathname === "/api/me/notifications") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    return json(await listNotifications(env.DB, participant.participantHash));
  }

  if (request.method === "POST" && url.pathname === "/api/me/notifications/seen") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const marked = await markNotificationsSeen(env.DB, participant.participantHash);
    return json({ ok: true, marked });
  }

  // 个人画像分享（0085）：幂等创建/刷新（token 不变、快照更新）、撤销。
  if (request.method === "POST" && url.pathname === "/api/me/profile-share") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const share = await upsertProfileShare(env.DB, {
      participantHash: participant.participantHash,
      displayName: await displayNameOrEmpty(env, participant),
    });
    return json({ share: { url: `/u/${share.token}`, updatedAt: share.updatedAt, snapshot: share.snapshot } });
  }

  if (request.method === "DELETE" && url.pathname === "/api/me/profile-share") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const revoked = await revokeProfileShare(env.DB, participant.participantHash);
    return json({ ok: true, revoked });
  }

  if (request.method === "GET" && url.pathname === "/api/me/profile-share") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const share = await getActiveProfileShareFor(env.DB, participant.participantHash);
    return json({ share: share ? { url: `/u/${share.token}`, snapshot: share.snapshot, updatedAt: share.updatedAt } : null });
  }

  // Opening 「我的」 is what "reads" the badges: the response above carries the
  // unseen flag so the client can show the dot before this lands.
  if (request.method === "POST" && url.pathname === "/api/me/achievements/seen") {    const participant = await resolveParticipant(request, env);
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

/** 画像昵称：TG first_name（平台昵称语义），其余身份匿名展示。 */
async function displayNameOrEmpty(env: Env, participant: { kind: string; dbUserId: number | null }): Promise<string> {
  if (participant.kind !== "telegram" || participant.dbUserId === null) return "";
  try {
    const { getUserById } = await import("../db/repositories/user.repository");
    const user = await getUserById(env.DB, participant.dbUserId);
    return (user?.firstName ?? "").slice(0, 24);
  } catch {
    return "";
  }
}
