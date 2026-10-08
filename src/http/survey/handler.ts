import type { Env } from "../../index";
import { verifySurveyAccessCode } from "../../core/security";
import { getSurveyById } from "../../db/repositories/survey.repository";
import { getUserById } from "../../db/repositories/user.repository";
import { getParticipantLink } from "../../db/repositories/participant-link.repository";
import {
  completeResponse,
  countCompletedResponsesBySurveyAndUser,
  createResponse,
  getActiveResponse,
  getActiveResponseBySurveyAndUser,
  getCompletedResponseBySurveyAndUser,
  getResponseBySurveyAndHash,
  listAnswersByResponseId,
  setResponseReportPublication,
} from "../../db/repositories/response.repository";
import { getFirstQuestion } from "../../survey/engine";
import { readCachedJson, writeCachedJson } from "../../services/kv-cache.service";
import { resolveSubmissionBotUrl } from "../../services/contact-links.service";
import { loadSystemSettings } from "../../services/system-settings.service";
import { checkAtomicRateLimit, checkRateLimit, rateLimitResponse } from "../../services/rate-limit.service";
import { enqueueReportDelivery } from "../../services/report-delivery.service";
import { createReportAccessToken } from "../../services/report-access-token.service";
import { createSurveyAccessGrant, verifySurveyAccessGrant } from "../../services/survey-access-grant.service";
import { publishProfileResponse } from "../../services/profile-gallery.service";
import {
  evaluateAchievements,
  evaluateTimeOfDayAchievements,
  serializeUnlockedAchievements,
} from "../../services/achievement.service";
import { getDefaultPublicationTarget } from "../../db/repositories/publication-target.repository";
import { promoteResponseMediaToDurable } from "../../services/media/temporary-media.service";
import { fail, json } from "../api-response";
import { findMissingRequiredQuestion, saveWebAnswer } from "./answers";
import { ANONYMOUS_KEY_PATTERN, enrichBrowserInfo, resolveParticipant, sanitizeHeader } from "./participant";
import {
  loadPublishedSurvey,
  loadPublishedSurveyList,
  loadPublishedSurveyListStamp,
  resolveParticipantLinkBotUsername,
  SURVEY_LIST_CACHE_TTL_SECONDS,
  SURVEY_LIST_CACHE_VERSION,
  type PublishedSurveyListItem,
} from "./catalog";
import { loadSurveyDefinition } from "./definition";
import { handleSurveyMediaUpload, serveSurveyMedia, temporaryStore } from "./media";
import { answerValue } from "./presentation";

interface ResolvedPublicationTarget {
  id: number | null;
  chatId: string;
  threadId: number | null;
}

async function resolvePublicationTarget(env: Env): Promise<ResolvedPublicationTarget | null> {
  if (env.DEPLOYMENT_ROLE === "customer" && env.LICENSE_SERVER_URL && env.LICENSE_KEY && env.INSTALLATION_ID) {
    const response = await fetch(env.LICENSE_SERVER_URL.replace(/\/+$/, "") + "/api/control/customer/publication-target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: env.LICENSE_KEY, installationId: env.INSTALLATION_ID, appVersion: env.APP_VERSION ?? "0.0.0" }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { target?: { chatId?: string; threadId?: number | null } } | null;
    if (!payload?.target?.chatId) return null;
    return { id: null, chatId: payload.target.chatId, threadId: payload.target.threadId ?? null };
  }
  const target = await getDefaultPublicationTarget(env.DB);
  return target ? { id: target.id, chatId: target.chatId, threadId: target.threadId } : null;
}

export async function handleSurveyApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/surveys") {
    // Cap the query: the search path runs a correlated COUNT(*) per row and is
    // the most expensive read on the public surface, so a hostile `?q=` must
    // neither be unbounded in length nor unthrottled.
    const rawQ = (url.searchParams.get("q") ?? "").trim().slice(0, 64);
    const q = rawQ;
    const communityGroupUrl = env.COMMUNITY_GROUP_URL || null;
    const submissionBotUrl = resolveSubmissionBotUrl(env);
    // Search results are unbounded and rarely repeated, so only the default
    // list (what the survey home page asks for) is cached.
    if (!q) {
      const cacheKey = `survey-list:${SURVEY_LIST_CACHE_VERSION}:${await loadPublishedSurveyListStamp(env.DB)}`;
      const cached = await readCachedJson<PublishedSurveyListItem[]>(env.CACHE, cacheKey);
      if (cached) {
        return json({ communityGroupUrl, submissionBotUrl, surveys: cached });
      }
      const surveys = await loadPublishedSurveyList(env, q);
      await writeCachedJson(env.CACHE, cacheKey, surveys, SURVEY_LIST_CACHE_TTL_SECONDS);
      return json({ communityGroupUrl, submissionBotUrl, surveys });
    }
    // Abuse damping on the expensive search branch (per IP fixed window). The
    // default list stays uncapped because it is KV-cached and cheap.
    const searchLimiter = await checkRateLimit(
      env.CACHE,
      "survey-search",
      request.headers.get("cf-connecting-ip") ?? "unknown",
      30,
      60,
    );
    if (!searchLimiter.allowed) return rateLimitResponse(searchLimiter.retryAfterSeconds);
    return json({ communityGroupUrl, submissionBotUrl, surveys: await loadPublishedSurveyList(env, q) });
  }

  const participantLinkStartMatch = url.pathname.match(/^\/api\/survey\/participant-link\/start$/);
  if (participantLinkStartMatch && request.method === "GET") {
    const key = url.searchParams.get("key") ?? "";
    if (!ANONYMOUS_KEY_PATTERN.test(key)) {
      return fail(400, "validation_failed", "绑定参数无效");
    }
    const botUsername = await resolveParticipantLinkBotUsername(env);
    if (!botUsername) {
      return fail(503, "bot_unavailable", "暂时无法生成绑定链接，请稍后重试");
    }
    return json({ url: `https://t.me/${botUsername}?start=link_${key}` });
  }

  const participantLinkStatusMatch = url.pathname.match(/^\/api\/survey\/participant-link\/status$/);
  if (participantLinkStatusMatch && request.method === "GET") {
    const key = url.searchParams.get("key") ?? "";
    if (!ANONYMOUS_KEY_PATTERN.test(key)) {
      return fail(400, "validation_failed", "绑定参数无效");
    }
    const link = await getParticipantLink(env.DB, key);
    if (!link) return json({ linked: false });
    const user = await getUserById(env.DB, link.userId);
    return json({
      linked: true,
      username: user?.username ?? null,
      firstName: user?.firstName ?? null,
      telegramUserId: user?.telegramUserId ?? null,
    });
  }

  const mediaMatch = url.pathname.match(/^\/api\/survey\/media\/(\d+)$/);
  if (mediaMatch) {
    if (request.method !== "GET") return fail(405, "method_not_allowed", "仅支持 GET");
    return serveSurveyMedia(request, env, Number(mediaMatch[1]));
  }

  const surveyMatch = url.pathname.match(/^\/api\/survey\/(\d+)(\/.*)?$/);
  if (!surveyMatch) return null;
  const surveyId = Number(surveyMatch[1]);
  const rest = surveyMatch[2] ?? "";

  if (request.method === "GET" && rest === "") {
    // One indexed row lookup: it carries the cache stamp, and its version of
    // the survey fields is what the cached payload is keyed on.
    const survey = await getSurveyById(env.DB, surveyId);
    if (!survey || survey.status !== "published") {
      return fail(404, "survey_unavailable", "问卷不存在或未发布");
    }
    // A published survey with an access code must not hand out its questions,
    // options or media until the caller proves the code. The grant is minted
    // by POST /access and is bound to this survey + short-lived.
    const accessGranted = survey.accessCode
      ? await verifySurveyAccessGrant(env.WEBHOOK_SECRET, surveyId, url.searchParams.get("grant"))
      : true;
    return json(await loadSurveyDefinition(env, request, survey, accessGranted));
  }

  if (request.method === "POST" && rest === "/access") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    if (!loaded.survey.accessCode) {
      return json({ ok: true, grant: null });
    }
    // Abuse damping on the code check: per IP + per survey, so a 4-digit code
    // cannot be walked in one burst. KV fixed window (same trade-offs as the
    // other public endpoints).
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limiter = await checkAtomicRateLimit(env.DB, env.CACHE, "survey-access", `${clientIp}:${surveyId}`, 20, 300);
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : "";
    const valid = await verifySurveyAccessCode(loaded.survey.accessCode, code, env.SURVEY_CODE_PEPPER ?? "");
    if (!valid) return fail(403, "invalid_access_code", "访问密码错误");
    const grant = await createSurveyAccessGrant(env.WEBHOOK_SECRET, surveyId);
    return json({ ok: true, grant });
  }

  if (request.method === "POST" && rest === "/responses") {
    // Abuse damping on the public start endpoint (KV fixed window per IP).
    const limiter = await checkRateLimit(
      env.CACHE,
      "start_response",
      request.headers.get("cf-connecting-ip") ?? "unknown",
      10,
      60,
    );
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const { survey, flow } = loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;

    if (survey.accessCode) {
      const body = (await request.json().catch(() => null)) as { accessCode?: unknown } | null;
      const code = typeof body?.accessCode === "string" ? body.accessCode : "";
      const valid = await verifySurveyAccessCode(survey.accessCode, code, env.SURVEY_CODE_PEPPER ?? "");
      if (!valid) return fail(403, "invalid_access_code", "访问密码错误");
    }

    // Admins can re-fill a published survey any number of times to inspect
    // the current effect; each submission creates a fresh response.
    const isAdminParticipant =
      participant.kind === "telegram" &&
      participant.telegramUserId !== null &&
      env.ADMIN_IDS.split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value))
        .includes(participant.telegramUserId);

    const active =
      participant.kind === "telegram"
        ? await getActiveResponseBySurveyAndUser(env.DB, surveyId, participant.dbUserId!)
        : await getActiveResponse(env.DB, surveyId, participant.participantHash);
    if (active) {
      return json({
        responseId: active.id,
        currentQuestionId: active.currentQuestionId,
        status: active.status,
        resumed: true,
      });
    }

    if (!survey.allowMultipleResponses) {
      const existing =
        participant.dbUserId !== null
          ? await getCompletedResponseBySurveyAndUser(env.DB, surveyId, participant.dbUserId)
          : await getResponseBySurveyAndHash(env.DB, surveyId, participant.participantHash);
      if (existing && !isAdminParticipant) {
        return fail(409, "already_completed", "你已经完成过该问卷，不能重复提交");
      }
    } else if (participant.kind === "telegram" && participant.dbUserId !== null && !isAdminParticipant) {
      const completedCount = await countCompletedResponsesBySurveyAndUser(env.DB, surveyId, participant.dbUserId);
      if (survey.maxResponsesPerUser > 0 && completedCount >= survey.maxResponsesPerUser) {
        return fail(409, "response_limit_reached", "已达到填写次数上限");
      }
    }

    const firstQuestion = getFirstQuestion(flow);
    if (!firstQuestion) {
      return fail(400, "empty_survey", "问卷还没有题目");
    }
    let response: Awaited<ReturnType<typeof createResponse>>;
    try {
      response = await createResponse(env.DB, {
        surveyId,
        userId: participant.dbUserId,
        participantHash: participant.participantHash,
        currentQuestionId: firstQuestion.id,
        deviceFingerprint: sanitizeHeader(request.headers.get("x-device-fingerprint"), 128),
        browserInfo: enrichBrowserInfo(request.headers.get("x-browser-info"), request),
        ipAddress: sanitizeHeader(request.headers.get("cf-connecting-ip"), 64),
      });
    } catch (error) {
      // A double-tap or a retried request passes the "is there an active
      // response?" check twice; the partial unique index on
      // (survey_id, participant_hash) WHERE status='in_progress' then makes the
      // second INSERT fail. That is a resume, not a server error — look up the
      // winning row and continue it.
      const raced = await getActiveResponse(env.DB, surveyId, participant.participantHash);
      if (!raced) throw error;
      return json({
        responseId: raced.id,
        currentQuestionId: raced.currentQuestionId,
        status: raced.status,
        resumed: true,
      });
    }
    return json(
      {
        responseId: response.id,
        currentQuestionId: firstQuestion.id,
        status: response.status,
        resumed: false,
      },
      201,
    );
  }

  if (request.method === "POST" && rest === "/media") {
    const limiter = await checkRateLimit(
      env.CACHE,
      "upload",
      request.headers.get("cf-connecting-ip") ?? "unknown",
      20,
      60,
    );
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    return handleSurveyMediaUpload(request, env, surveyId);
  }

  const responseMatch = rest.match(/^\/responses\/(\d+)(\/.*)?$/);
  if (!responseMatch) return null;
  const responseId = Number(responseMatch[1]);
  const responseRest = responseMatch[2] ?? "";

  if (request.method === "GET" && responseRest === "") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const row = await env.DB.prepare(
      `SELECT id FROM survey_responses
         WHERE id = ? AND survey_id = ? AND participant_hash = ?
         LIMIT 1`,
    )
      .bind(responseId, surveyId, participant.participantHash)
      .first<{ id: number }>();
    if (!row) return fail(404, "response_not_found", "答卷不存在");
    const answers = await listAnswersByResponseId(env.DB, responseId);
    return json({
      answers: Object.fromEntries(answers.map((answer) => [String(answer.questionId), answerValue(answer)])),
    });
  }

  if (request.method === "POST" && responseRest === "/answers") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const response = await env.DB.prepare(
      `SELECT id, status FROM survey_responses
         WHERE id = ? AND survey_id = ? AND participant_hash = ? AND status = 'in_progress'
         LIMIT 1`,
    )
      .bind(responseId, surveyId, participant.participantHash)
      .first<{ id: number; status: string }>();
    if (!response) return fail(404, "response_not_found", "答卷不存在或已提交");

    const body = (await request.json().catch(() => null)) as {
      questionId?: unknown;
      value?: unknown;
    } | null;
    if (!body || !Number.isInteger(body.questionId)) {
      return fail(400, "invalid_body", "questionId 必须是整数");
    }
    const question = loaded.flow.questions.find((item) => item.id === Number(body.questionId));
    if (!question) return fail(404, "question_not_found", "题目不存在");

    const saveError = await saveWebAnswer(env, responseId, question, body.value);
    if (saveError) return saveError;
    await env.DB.prepare("UPDATE survey_responses SET current_question_id = ?, updated_at = ? WHERE id = ?")
      .bind(question.id, new Date().toISOString(), responseId)
      .run();
    return json({ ok: true });
  }

  if (request.method === "POST" && responseRest === "/submit") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const body = (await request.json().catch(() => null)) as {
      publishToGallery?: unknown;
      galleryCoverMediaId?: unknown;
      galleryVisibleQuestionIds?: unknown;
      galleryShowUsername?: unknown;
      publishToTelegram?: unknown;
    } | null;
    const publishToGallery = Boolean(body?.publishToGallery);
    const publishToTelegram = Boolean(body?.publishToTelegram);
    const galleryCoverMediaId =
      typeof body?.galleryCoverMediaId === "number" && Number.isInteger(body.galleryCoverMediaId)
        ? body.galleryCoverMediaId
        : null;
    const galleryVisibleQuestionIds = Array.isArray(body?.galleryVisibleQuestionIds)
      ? body.galleryVisibleQuestionIds.filter(
          (id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0,
        )
      : undefined;
    const galleryShowUsername = body?.galleryShowUsername === true;
    const response = await env.DB.prepare(
      `SELECT id, status FROM survey_responses
         WHERE id = ? AND survey_id = ? AND participant_hash = ? AND status = 'in_progress'
         LIMIT 1`,
    )
      .bind(responseId, surveyId, participant.participantHash)
      .first<{ id: number; status: string }>();
    if (!response) return fail(404, "response_not_found", "答卷不存在或已提交");

    const answers = await listAnswersByResponseId(env.DB, responseId);
    const answersByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    const missing = findMissingRequiredQuestion(loaded.flow.questions, answersByQuestion);
    if (missing) {
      return fail(400, "required_missing", `请完成必答题目：${missing.title}`);
    }
    if (publishToGallery) {
      const system = await loadSystemSettings(env.DB);
      if (Number(system.profileGallerySurveyId) !== surveyId) {
        return fail(400, "profile_gallery_not_configured", "该问卷未启用个人画廊");
      }
      if (participant.kind !== "telegram" || participant.dbUserId === null) {
        return fail(
          403,
          "profile_publish_identity_required",
          "发布到个人画廊需要 Telegram 身份，请从机器人打开问卷后再发布",
        );
      }
      try {
        await publishProfileResponse({ DB: env.DB, MEDIA_KV: env.MEDIA_KV }, responseId, {
          coverMediaId: galleryCoverMediaId,
          ...(galleryVisibleQuestionIds ? { visibleQuestionIds: galleryVisibleQuestionIds } : {}),
          showUsername: galleryShowUsername,
        });
      } catch (error) {
        console.error("Profile gallery publish failed", { responseId, error });
        return fail(400, "profile_publish_failed", "发布到个人画廊失败，请稍后重试。");
      }
    }
    const publicationTarget = publishToTelegram ? await resolvePublicationTarget(env) : null;
    const completed = await completeResponse(env.DB, responseId);
    if (!completed) {
      // A concurrent submit already completed this response. Return the same
      // success shape without re-running the post-completion side effects
      // (media promotion, report enqueue) — the winning request runs them. The
      // gallery copy insert above is idempotent via its partial unique index.
      const token = await createReportAccessToken(env.WEBHOOK_SECRET, responseId);
      return json({
        ok: true,
        completed: true,
        reportUrl: `/report/${responseId}?t=${token}`,
        galleryPublished: publishToGallery,
      });
    }
    // The response is now an immutable record: keep its attachments readable
    // for previews instead of letting the temporary-media TTL expire them.
    // A failure here must not fail the submission — the temp copy still
    // serves the report for the rest of its retention window.
    try {
      const promotion = await promoteResponseMediaToDurable(env.DB, temporaryStore(env), responseId);
      if (promotion.promoted > 0 || promotion.discarded > 0) {
        console.log("Response media retained", { responseId, ...promotion });
      }
    } catch (error) {
      console.error("Response media retention failed", { responseId, error });
    }
    try {
      await enqueueReportDelivery(env.DB, env.EXPORT_QUEUE, { responseId });
    } catch (error) {
      // Answer data is already committed; report archiving is retried by the
      // queue pipeline, so a transient enqueue failure must not fail submit.
      console.error("Report delivery enqueue failed", { responseId, error });
    }
    if (publishToTelegram) {
      try {
        if (!publicationTarget) throw new Error("Web 管理后台尚未配置公开报告发布目标");
        await setResponseReportPublication(
          env.DB,
          responseId,
          true,
          "pending",
          publicationTarget.id,
          publicationTarget.chatId,
          publicationTarget.threadId,
        );
        await env.EXPORT_QUEUE.send({ kind: "public_report", responseId });
      } catch (error) {
        await setResponseReportPublication(
          env.DB,
          responseId,
          true,
          "failed",
          publicationTarget?.id ?? null,
          publicationTarget?.chatId ?? null,
          publicationTarget?.threadId ?? null,
        );
        console.error("Public Telegram report enqueue failed", { responseId, error });
      }
    }
    // 成就：答卷已经落库，徽章只是装饰——统计失败绝不能反过来让提交失败。
    // 时间彩蛋（深夜/早起）必须在「刚刚完成」的这一刻判定，事后无法重建。
    let newAchievements: ReturnType<typeof serializeUnlockedAchievements> = [];
    try {
      const achievementCtx = {
        participantHash: participant.participantHash,
        userId: participant.dbUserId ?? null,
      };
      const unlocked = [
        ...(await evaluateAchievements(env.DB, achievementCtx)),
        ...(await evaluateTimeOfDayAchievements(env.DB, achievementCtx)),
      ];
      newAchievements = serializeUnlockedAchievements(unlocked);
    } catch (error) {
      console.error("Achievement grant failed", { responseId, error });
    }
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, responseId);
    return json({
      ok: true,
      completed: true,
      reportUrl: `/report/${responseId}?t=${token}`,
      galleryPublished: publishToGallery,
      newAchievements,
    });
  }

  return null;
}
