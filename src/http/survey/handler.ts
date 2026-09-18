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
} from "../../db/repositories/response.repository";
import { getFirstQuestion } from "../../survey/engine";
import { readCachedJson, writeCachedJson } from "../../services/kv-cache.service";
import { resolveSubmissionBotUrl } from "../../services/contact-links.service";
import { loadSystemSettings } from "../../services/system-settings.service";
import { checkRateLimit, rateLimitResponse } from "../../services/rate-limit.service";
import { enqueueReportDelivery } from "../../services/report-delivery.service";
import { createReportAccessToken } from "../../services/report-access-token.service";
import { publishProfileResponse } from "../../services/profile-gallery.service";
import { fail, json } from "../api-response";
import { findMissingRequiredQuestion, saveWebAnswer } from "./answers";
import {
  ANONYMOUS_KEY_PATTERN,
  enrichBrowserInfo,
  resolveParticipant,
  sanitizeHeader,
} from "./participant";
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
import { handleSurveyMediaUpload, serveSurveyMedia } from "./media";
import { answerValue } from "./presentation";

export async function handleSurveyApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/surveys") {
    const q = (url.searchParams.get("q") ?? "").trim();
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
    return json(await loadSurveyDefinition(env, request, survey));
  }

  if (request.method === "POST" && rest === "/access") {
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    if (!loaded.survey.accessCode) {
      return json({ ok: true });
    }
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : "";
    const valid = await verifySurveyAccessCode(loaded.survey.accessCode, code);
    if (!valid) return fail(403, "invalid_access_code", "访问密码错误");
    return json({ ok: true });
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
      const valid = await verifySurveyAccessCode(survey.accessCode, code);
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
    const response = await createResponse(env.DB, {
      surveyId,
      userId: participant.dbUserId,
      participantHash: participant.participantHash,
      currentQuestionId: firstQuestion.id,
      deviceFingerprint: sanitizeHeader(request.headers.get("x-device-fingerprint"), 128),
      browserInfo: enrichBrowserInfo(request.headers.get("x-browser-info"), request),
      ipAddress: sanitizeHeader(request.headers.get("cf-connecting-ip"), 64),
    });
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
    const limiter = await checkRateLimit(
      env.CACHE,
      "answer",
      request.headers.get("cf-connecting-ip") ?? "unknown",
      120,
      60,
    );
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
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
    } | null;
    const publishToGallery = Boolean(body?.publishToGallery);
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
        return fail(400, "profile_publish_failed", error instanceof Error ? error.message : "发布到个人画廊失败");
      }
    }
    await completeResponse(env.DB, responseId);
    try {
      await enqueueReportDelivery(env.DB, env.EXPORT_QUEUE, { responseId });
    } catch (error) {
      // Answer data is already committed; report archiving is retried by the
      // queue pipeline, so a transient enqueue failure must not fail submit.
      console.error("Report delivery enqueue failed", { responseId, error });
    }
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, responseId);
    return json({
      ok: true,
      completed: true,
      reportUrl: `/report/${responseId}?t=${token}`,
      galleryPublished: publishToGallery,
    });
  }

  return null;
}
