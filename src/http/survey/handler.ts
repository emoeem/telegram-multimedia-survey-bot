import type { Env } from "../../index";
import { verifySurveyAccessCode } from "../../core/security";
import { getSurveyByIdStatement, mapSurveyStatementResult } from "../../db/repositories/survey.repository";
import { getUserById } from "../../db/repositories/user.repository";
import { getParticipantLink, participantHashForKey } from "../../db/repositories/participant-link.repository";
import {
  completeResponse,
  countCompletedResponsesBySurveyAndUser,
  createResponse,
  getActiveResponse,
  getActiveResponseBySurveyAndUser,
  getCompletedResponseBySurveyAndUser,
  getResponseBySurveyAndHash,
  listAnswersByResponseId,
  listAnswersForInProgressResponseStatement,
  mapAnswerRows,
  setResponseReportPublication,
} from "../../db/repositories/response.repository";
import { getFirstQuestion } from "../../survey/engine";
import { readCachedJson, writeCachedJson } from "../../services/kv-cache.service";
import { resolveSubmissionBotUrl } from "../../services/contact-links.service";
import { loadSystemSettings } from "../../services/system-settings.service";
import {
  atomicRateLimitWindow,
  buildAtomicRateLimitStatement,
  checkAtomicRateLimit,
  checkRateLimit,
  rateLimitResponse,
  readAtomicRateLimitCountFromBatch,
} from "../../services/rate-limit.service";
import { enqueueReportDelivery } from "../../services/report-delivery.service";
import { settingsFromRows } from "../../services/system-settings.service";
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
import { findMissingRequiredQuestion, planWebAnswer } from "./answers";
import {
  ANONYMOUS_KEY_PATTERN,
  bannedResponse,
  enrichBrowserInfo,
  resolveParticipant,
  sanitizeHeader,
  type Participant,
} from "./participant";
import { resolveCoinGate } from "../../services/coin/unlock.service";
import {
  beginPublishedFlowRead,
  loadPublishedSurvey,
  loadPublishedSurveyList,
  loadPublishedSurveyListStamp,
  resolvePublishedFlow,
  resolveParticipantLinkBotUsername,
  SURVEY_LIST_CACHE_TTL_SECONDS,
  SURVEY_LIST_CACHE_VERSION,
  type PublishedSurveyListItem,
} from "./catalog";
import { loadSurveyDefinition } from "./definition";
import { handleSurveyMediaUpload, serveSurveyMedia, temporaryStore } from "./media";
import { answerValue } from "./presentation";
import { UNKNOWN_CLIENT_IP, resolveClientIdentity } from "../../services/client-identity.service";

interface ResolvedPublicationTarget {
  id: number | null;
  chatId: string;
  threadId: number | null;
}

/**
 * Abuse damping for answer saves.
 *
 * Counted per participant rather than per address: the write is an idempotent
 * upsert into the participant's own in-progress response, so it has little
 * abuse value, while a shared address turns a per-IP bucket into collateral
 * damage — mainland respondents routinely share VPN egresses and campus NATs,
 * where one busy household could otherwise throttle everyone behind it. The
 * modest ceiling still stops a runaway client loop; creating the response the
 * limit depends on stays capped per address (`/responses`).
 */
const ANSWER_RATE_LIMIT_MAX_PER_WINDOW = 120;
const ANSWER_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Abuse damping for starting a response, per address: this is what allocates a
 * row, so it is worth a per-address bucket even though the shared-address
 * problem above applies. Same shape as the limits it replaces.
 */
const START_RESPONSE_MAX_PER_WINDOW = 10;
const START_RESPONSE_WINDOW_SECONDS = 60;

/**
 * 每日开卷上限（按地址）：分钟级限流（10/分钟）本身允许 ≈14,400 次/天，而匿名
 * 答卷者的身份是浏览器本地生成的 key——脚本**每请求换一个 key** 就能绕过所有按
 * 人的限流（`maxResponsesPerUser`、答案保存的 120/分钟都形同虚设）。只有地址是
 * 脚本绕不开的，所以用两道按地址的日上限兜住"刷答卷"：
 *   - 同一问卷 40 次/天：正常分享场景（一个群几十人各填一次）够用；
 *   - 该地址全部问卷 100 次/天：拦住"换问卷继续刷"。
 * 取值刻意宽松：本平台大量用户共用 VPN/校园出口，误伤真实填写者的代价远大于
 * 放过一个刷子（且 10/分钟的分钟级限流仍在）。
 */
const START_RESPONSE_SURVEY_DAILY_MAX = 40;
const START_RESPONSE_IP_DAILY_MAX = 100;
const START_RESPONSE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * 防「恶意填写刷数据/污染」的提交侧闸门。
 *
 * 匿名答卷者的身份是浏览器本地 key，脚本换 key 即绕过所有按人限流，因此防御重心
 * 放在**地址与设备**这两个脚本不易伪造的维度（设备指纹由 FingerprintJS 生成，
 * 可以伪造，但伪造者需要刻意为之——它拦的是"最省事的那种刷子"）：
 *   - 同设备（指纹）同一问卷每天最多完成 5 份；
 *   - 「公开发布到 Telegram」按身份 2 次/天、按地址 6 次/天（频道污染的主闸门；
 *     画廊发布已有 Telegram 身份门槛）。
 * 以及一道按题目数放缩的最短填写时间（见 submit 里的说明）。
 */
const SUBMIT_PER_DEVICE_DAILY_MAX = 5;
const PUBLISH_TELEGRAM_IDENTITY_DAILY_MAX = 2;
const PUBLISH_TELEGRAM_IP_DAILY_MAX = 6;
const PUBLISH_TELEGRAM_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

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
      resolveClientIdentity(request, env).ip,
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
    // Three independent reads, one round trip: the survey row (which carries
    // the definition cache stamp), the coin-unlock switch, and the system
    // settings the definition projection needs. Each used to be its own
    // sequential round trip before the KV lookup.
    const [surveyResult, coinResult, settingsResult] = await env.DB.batch([
      getSurveyByIdStatement(env.DB, surveyId),
      env.DB.prepare(`SELECT enabled FROM survey_coin_access WHERE survey_id = ?`).bind(surveyId),
      env.DB.prepare(`SELECT key, value FROM system_settings ORDER BY key ASC`),
    ]);
    const survey = mapSurveyStatementResult(surveyResult);
    if (!survey || survey.status !== "published") {
      return fail(404, "survey_unavailable", "问卷不存在或未发布");
    }
    const system = settingsFromRows((settingsResult?.results ?? []) as Array<{ key: string; value: string }>);
    // A published survey with an access code must not hand out its questions,
    // options or media until the caller proves the code. The grant is minted
    // by POST /access and is bound to this survey + short-lived.
    const accessGranted = survey.accessCode
      ? await verifySurveyAccessGrant(env.WEBHOOK_SECRET, surveyId, url.searchParams.get("grant"))
      : true;
    // 金币解锁是独立于密码的第二道作者自主访问层：启用后，未解锁的访问者
    // 只能看到元数据与价格。作者本人与管理员豁免；已解锁者直接放行。
    // 未启用的问卷（绝大多数）不再付任何参与者解析/查询成本——开关已经
    // 在上面那趟 batch 里顺手读掉了。
    const coinEnabled = Number(((coinResult?.results ?? [])[0] as { enabled?: number } | undefined)?.enabled ?? 0) > 0;
    if (coinEnabled) {
      const participantResolved = await resolveParticipant(request, env);
      const participant = participantResolved instanceof Response ? null : participantResolved;
      const adminIds = (env.ADMIN_IDS ?? "")
        .split(",")
        .map((value: string) => Number(value.trim()))
        .filter((value: number) => Number.isInteger(value));
      const coinGate = await resolveCoinGate(env.DB, survey, participant, adminIds);
      if (!coinGate.unlocked) {
        const locked = await loadSurveyDefinition(env, request, survey, false, system);
        return json({
          ...locked,
          coinUnlock: { required: true, price: coinGate.price },
        });
      }
    }
    return json(await loadSurveyDefinition(env, request, survey, accessGranted, system));
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
    const clientIp = resolveClientIdentity(request, env).ip;
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
    // Abuse damping on the public start endpoint, per address (10 per minute):
    // this is the write that allocates a response, so it stays address-keyed
    // rather than participant-keyed, unlike the answer saves below. The counter
    // rides in the same batch as the survey read — one D1 round trip for both.
    // The question flow comes from the edge KV cache (see catalog.ts), so the
    // batch no longer drags every question and option row along.
    const limiterNow = Date.now();
    const identity = resolveClientIdentity(request, env);
    const flowRead = beginPublishedFlowRead(env, surveyId);
    // The coin-unlock switch rides in this batch too: it used to be its own
    // round trip before the participant was even resolved, and it is a plain
    // per-survey flag (free surveys are the overwhelming majority). 两道日上限
    //（每问卷 / 每地址）同样搭车，不增加任何往返。
    const [startLimitResult, surveyResult, coinResult, surveyDailyResult, ipDailyResult] = await env.DB.batch([
      buildAtomicRateLimitStatement(env.DB, "start_response", identity.ip, START_RESPONSE_WINDOW_SECONDS, limiterNow),
      getSurveyByIdStatement(env.DB, surveyId),
      env.DB.prepare(`SELECT enabled FROM survey_coin_access WHERE survey_id = ?`).bind(surveyId),
      buildAtomicRateLimitStatement(
        env.DB,
        "start_response_survey_daily",
        `${identity.ip}:${surveyId}`,
        START_RESPONSE_DAILY_WINDOW_SECONDS,
        limiterNow,
      ),
      buildAtomicRateLimitStatement(
        env.DB,
        "start_response_ip_daily",
        identity.ip,
        START_RESPONSE_DAILY_WINDOW_SECONDS,
        limiterNow,
      ),
    ]);
    if (readAtomicRateLimitCountFromBatch(startLimitResult) > START_RESPONSE_MAX_PER_WINDOW) {
      return rateLimitResponse(
        atomicRateLimitWindow("start_response", identity.ip, START_RESPONSE_WINDOW_SECONDS, limiterNow)
          .retryAfterSeconds,
      );
    }
    // 日上限触发：日志留痕（运营可在 tail 里看到是哪个出口在刷），用户拿到可重试提示。
    if (readAtomicRateLimitCountFromBatch(surveyDailyResult) > START_RESPONSE_SURVEY_DAILY_MAX) {
      console.warn("start_response daily survey cap reached", { ip: identity.ip, surveyId });
      return rateLimitResponse(
        atomicRateLimitWindow(
          "start_response_survey_daily",
          `${identity.ip}:${surveyId}`,
          START_RESPONSE_DAILY_WINDOW_SECONDS,
          limiterNow,
        ).retryAfterSeconds,
      );
    }
    if (readAtomicRateLimitCountFromBatch(ipDailyResult) > START_RESPONSE_IP_DAILY_MAX) {
      console.warn("start_response daily ip cap reached", { ip: identity.ip });
      return rateLimitResponse(
        atomicRateLimitWindow(
          "start_response_ip_daily",
          identity.ip,
          START_RESPONSE_DAILY_WINDOW_SECONDS,
          limiterNow,
        ).retryAfterSeconds,
      );
    }
    const survey = mapSurveyStatementResult(surveyResult);
    if (!survey || survey.status !== "published") {
      return fail(404, "survey_unavailable", "问卷不存在或未发布");
    }
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;

    // 金币门：未解锁的问卷不能开始作答（与定义读取同一判定）。开关已随上面的
    // batch 读回；仅启用时再走一次完整的解锁判定。
    const coinEnabled = Number(((coinResult?.results ?? [])[0] as { enabled?: number } | undefined)?.enabled ?? 0) > 0;
    if (coinEnabled) {
      const coinAdminIds = (env.ADMIN_IDS ?? "")
        .split(",")
        .map((value: string) => Number(value.trim()))
        .filter((value: number) => Number.isInteger(value));
      const coinGate = await resolveCoinGate(env.DB, survey, participant, coinAdminIds);
      if (!coinGate.unlocked) {
        return fail(402, "coin_unlock_required", `该问卷需要金币解锁（${coinGate.price} 金币）后才能填写`);
      }
    }

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

    /** Resume lookup, and the policy guard the survey's settings imply. */
    const activeStatement =
      participant.kind === "telegram"
        ? env.DB.prepare(
            `SELECT id, current_question_id currentQuestionId, status FROM survey_responses
               WHERE survey_id = ? AND user_id = ? AND status = 'in_progress'
               ORDER BY id DESC LIMIT 1`,
          ).bind(surveyId, participant.dbUserId)
        : env.DB.prepare(
            `SELECT id, current_question_id currentQuestionId, status FROM survey_responses
               WHERE survey_id = ? AND participant_hash = ? AND status = 'in_progress'
               ORDER BY id DESC LIMIT 1`,
          ).bind(surveyId, participant.participantHash);
    const policyStatement = !isAdminParticipant
      ? !survey.allowMultipleResponses
        ? participant.dbUserId !== null
          ? env.DB.prepare(
              "SELECT 1 AS blocked FROM survey_responses WHERE survey_id = ? AND user_id = ? AND status = 'completed' LIMIT 1",
            ).bind(surveyId, participant.dbUserId)
          : env.DB.prepare(
              "SELECT 1 AS blocked FROM survey_responses WHERE survey_id = ? AND participant_hash = ? LIMIT 1",
            ).bind(surveyId, participant.participantHash)
        : participant.kind === "telegram" && participant.dbUserId !== null && survey.maxResponsesPerUser > 0
          ? env.DB.prepare(
              `SELECT 1 AS blocked FROM survey_responses
                 WHERE survey_id = ? AND user_id = ? AND status = 'completed'
                 GROUP BY survey_id HAVING COUNT(*) >= ?`,
            ).bind(surveyId, participant.dbUserId, survey.maxResponsesPerUser)
          : null
      : null;

    // Resume lookup, the policy guard, and the resumed answers are independent
    // reads: one round trip covers all three. The answers statement is empty
    // unless a resume actually happens, and lets the resume branch return the
    // saved answers inline — the client no longer pays a second round trip to
    // GET /responses before it can render the question it stopped on.
    const resumeAnswersStatement = listAnswersForInProgressResponseStatement(
      env.DB,
      surveyId,
      participant.participantHash,
    );
    const secondBatch = policyStatement
      ? [activeStatement, policyStatement, resumeAnswersStatement]
      : [activeStatement, resumeAnswersStatement];
    const batchResults = await env.DB.batch(secondBatch);
    const activeResult = batchResults[0];
    const policyResult = policyStatement ? batchResults[1] : undefined;
    const resumeAnswers = mapAnswerRows(batchResults[batchResults.length - 1]);
    const active = ((activeResult?.results ?? []) as Array<{
      id: number;
      currentQuestionId: number | null;
      status: string;
    }>)[0];
    if (active) {
      return json({
        responseId: active.id,
        currentQuestionId: active.currentQuestionId,
        status: active.status,
        resumed: true,
        answers: Object.fromEntries(resumeAnswers.map((answer) => [String(answer.questionId), answerValue(answer)])),
      });
    }
    if ((policyResult?.results ?? []).length > 0) {
      return survey.allowMultipleResponses
        ? fail(409, "response_limit_reached", "已达到填写次数上限")
        : fail(409, "already_completed", "你已经完成过该问卷，不能重复提交");
    }

    const firstQuestion = getFirstQuestion(await resolvePublishedFlow(env, survey, flowRead));
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
        browserInfo: enrichBrowserInfo(request.headers.get("x-browser-info"), request, identity),
        // Behind the relay the peer address is the relay itself, which is not
        // worth storing as "where this answer came from".
        ipAddress: identity.ip === UNKNOWN_CLIENT_IP ? null : sanitizeHeader(identity.ip, 64),
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
      resolveClientIdentity(request, env).ip,
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
    // Identity first, without touching the database: Telegram and email
    // identities still resolve through resolveParticipant (their participant
    // hash embeds the DB user id), but an anonymous web participant's hash is
    // pure string concatenation (`web_<key>`), so the link/ban lookup can ride
    // in the main batch below instead of costing its own round trip — every
    // "next question" click used to pay one extra trip just for it. Linked
    // participants keep their browser hash either way; only kind/dbUserId/ban
    // depend on the joined row.
    const hasVerifiedIdentity =
      request.headers.get("x-telegram-init-data") ||
      request.headers.get("x-participant-token") ||
      request.headers.get("x-email-session");
    const anonKeyHeader = hasVerifiedIdentity ? null : request.headers.get("x-participant-key");

    let participant: Participant;
    let linkStatement: D1PreparedStatement | null = null;
    if (anonKeyHeader !== null && ANONYMOUS_KEY_PATTERN.test(anonKeyHeader)) {
      participant = {
        kind: "anonymous",
        dbUserId: null,
        telegramUserId: null,
        participantKey: anonKeyHeader,
        participantHash: participantHashForKey(anonKeyHeader),
      };
      linkStatement = env.DB.prepare(
        `SELECT u.id userId, u.banned_at bannedAt, u.telegram_user_id telegramUserId
           FROM participant_links pl
           LEFT JOIN users u ON u.id = pl.user_id
          WHERE pl.participant_key = ?
          LIMIT 1`,
      ).bind(anonKeyHeader);
    } else {
      const resolved = await resolveParticipant(request, env);
      if (resolved instanceof Response) return resolved;
      participant = resolved;
    }

    // Reads for one answer, plus the abuse counter, as one D1 round trip. The
    // counter rides along rather than running as its own request (each
    // statement sent on its own costs a round trip to the database's region,
    // and answering is the one interaction a respondent repeats per question).
    // The question flow itself comes from the edge KV cache, fired here so it
    // runs in parallel with the batch below and is validated against the
    // freshly-read survey row (see resolvePublishedFlow) — re-reading every
    // question and option in the batch burned hundreds of D1 rows per click on
    // story surveys.
    const flowRead = beginPublishedFlowRead(env, surveyId);
    const limiterNow = Date.now();
    const statements: D1PreparedStatement[] = [
      buildAtomicRateLimitStatement(
        env.DB,
        "answers",
        participant.participantHash,
        ANSWER_RATE_LIMIT_WINDOW_SECONDS,
        limiterNow,
      ),
      getSurveyByIdStatement(env.DB, surveyId),
    ];
    let linkIndex = -1;
    if (linkStatement) {
      linkIndex = statements.length;
      statements.push(linkStatement);
    }
    const responseIndex = statements.length;
    statements.push(
      env.DB.prepare(
        `SELECT id, status FROM survey_responses
           WHERE id = ? AND survey_id = ? AND participant_hash = ? AND status = 'in_progress'
           LIMIT 1`,
      ).bind(responseId, surveyId, participant.participantHash),
    );
    const batchResults = await env.DB.batch(statements);
    const limitResult = batchResults[0];
    const surveyResult = batchResults[1];
    const responseResult = batchResults[responseIndex];
    if (readAtomicRateLimitCountFromBatch(limitResult) > ANSWER_RATE_LIMIT_MAX_PER_WINDOW) {
      return rateLimitResponse(
        atomicRateLimitWindow("answers", participant.participantHash, ANSWER_RATE_LIMIT_WINDOW_SECONDS, limiterNow)
          .retryAfterSeconds,
      );
    }
    const survey = mapSurveyStatementResult(surveyResult);
    if (!survey || survey.status !== "published") {
      return fail(404, "survey_unavailable", "问卷不存在或未发布");
    }
    if (!((responseResult?.results ?? []) as unknown[]).length) {
      return fail(404, "response_not_found", "答卷不存在或已提交");
    }
    if (linkIndex >= 0) {
      const linked = ((batchResults[linkIndex]?.results ?? [])[0] ?? null) as {
        userId: number | null;
        bannedAt: string | null;
        telegramUserId: number | null;
      } | null;
      // Mirrors resolveParticipant's linked branch: the hash this request is
      // keyed on is the same whether or not the link exists (it is derived from
      // the browser key, not the user row), so the only enforcement this folded
      // lookup owes is the account-wide ban. A dangling link row (user gone)
      // stays anonymous.
      if (linked && typeof linked.userId === "number") {
        const banned = bannedResponse(env, {
          bannedAt: linked.bannedAt ?? null,
          telegramUserId: linked.telegramUserId ?? null,
        });
        if (banned) return banned;
      }
    }
    // Resolved last: a cache hit costs nothing extra, and only a stamp mismatch
    // or miss pays for the database read.
    const flow = await resolvePublishedFlow(env, survey, flowRead);

    const body = (await request.json().catch(() => null)) as {
      questionId?: unknown;
      value?: unknown;
    } | null;
    if (!body || !Number.isInteger(body.questionId)) {
      return fail(400, "invalid_body", "questionId 必须是整数");
    }
    const question = flow.questions.find((item) => item.id === Number(body.questionId));
    if (!question) return fail(404, "question_not_found", "题目不存在");

    const plan = await planWebAnswer(env, responseId, question, body.value);
    if ("error" in plan) return plan.error;
    // The answer and the resume pointer are one batch, so a respondent who
    // closes the tab mid-save never resumes on a question whose answer was
    // written but not recorded.
    await env.DB.batch([
      ...plan.statements,
      env.DB.prepare("UPDATE survey_responses SET current_question_id = ?, updated_at = ? WHERE id = ?").bind(
        question.id,
        new Date().toISOString(),
        responseId,
      ),
    ]);
    return json({ ok: true });
  }

  if (request.method === "POST" && responseRest === "/submit") {
    // Survey row plus a parallel-started flow cache read: the required check
    // below walks the flow, and the row the gallery guard needs comes from the
    // same batch.
    const flowRead = beginPublishedFlowRead(env, surveyId);
    const [surveyRowResult] = await env.DB.batch([getSurveyByIdStatement(env.DB, surveyId)]);
    const survey = mapSurveyStatementResult(surveyRowResult);
    if (!survey || survey.status !== "published") {
      return fail(404, "survey_unavailable", "问卷不存在或未发布");
    }
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
    // Ownership check, full answer read and (when publishing) the settings for
    // the gallery guard are independent reads: one round trip instead of the
    // previous two-to-three sequential ones. 反刷的三道计数（同设备日上限、
    // 公开发布的身份/IP 日上限）同样搭车——提交是一次性动作，多一趟往返就多
    // 一份等待，而这些计数本来就要和归属校验一起读。
    const submitLimiterNow = Date.now();
    const submitReads: D1PreparedStatement[] = [
      env.DB.prepare(
        `SELECT id, status, started_at startedAt FROM survey_responses
           WHERE id = ? AND survey_id = ? AND participant_hash = ? AND status = 'in_progress'
           LIMIT 1`,
      ).bind(responseId, surveyId, participant.participantHash),
      env.DB.prepare("SELECT * FROM answers WHERE response_id = ? ORDER BY id ASC").bind(responseId),
      // 同一设备指纹 + 同一问卷的完成次数：脚本通常复用同一个（或伪造同一个）指纹；
      // 正常用户一台设备填一次。指纹缺失（首屏未等到 FingerprintJS）时跳过该计数。
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM survey_responses
          WHERE survey_id = ? AND device_fingerprint = ? AND device_fingerprint IS NOT NULL
            AND status IN ('completed', 'archived')
            AND completed_at >= datetime('now', '-1 day')`,
      ).bind(surveyId, sanitizeHeader(request.headers.get("x-device-fingerprint"), 128) ?? ""),
    ];
    if (publishToGallery) {
      submitReads.push(env.DB.prepare("SELECT key, value FROM system_settings ORDER BY key ASC"));
    }
    if (publishToTelegram) {
      // 「公开发布到 Telegram」是唯一能把内容推进公开频道的出口（画廊有 Telegram
      // 身份门槛，这里此前没有任何门槛）：匿名脚本可以刷垃圾报告进频道。按身份
      // （若可见）与按地址各记一道日计数。
      submitReads.push(
        buildAtomicRateLimitStatement(
          env.DB,
          "publish_telegram_identity_daily",
          participant.participantHash,
          PUBLISH_TELEGRAM_DAILY_WINDOW_SECONDS,
          submitLimiterNow,
        ),
      );
      submitReads.push(
        buildAtomicRateLimitStatement(
          env.DB,
          "publish_telegram_ip_daily",
          resolveClientIdentity(request, env).ip,
          PUBLISH_TELEGRAM_DAILY_WINDOW_SECONDS,
          submitLimiterNow,
        ),
      );
    }
    const batchResults = await env.DB.batch(submitReads);
    const responseResult = batchResults[0];
    const answersResult = batchResults[1];
    const fingerprintResult = batchResults[2];
    const settingsResult = publishToGallery ? batchResults[3] : undefined;
    const publishIdentityResult = publishToTelegram
      ? batchResults[publishToGallery ? 4 : 3]
      : undefined;
    const publishIpResult = publishToTelegram ? batchResults[publishToGallery ? 5 : 4] : undefined;
    const response = ((responseResult?.results ?? [])[0] ?? null) as {
      id: number;
      status: string;
      startedAt: string | null;
    } | null;
    if (!response) return fail(404, "response_not_found", "答卷不存在或已提交");
    const answers = mapAnswerRows(answersResult);
    const answersByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    const flow = await resolvePublishedFlow(env, survey, flowRead);
    const missing = findMissingRequiredQuestion(flow.questions, answersByQuestion);
    if (missing) {
      return fail(400, "required_missing", `请完成必答题目：${missing.title}`);
    }

    // ── 反刷与防污染 ────────────────────────────────────────────────────
    // 1) 最短填写时间：脚本可以在一秒内 start→answers→submit。阈值按题目数放缩且
    //    刻意很小（基础 2 秒 + 每题 0.5 秒，封顶 15 秒），误伤的用户（手速极快的
    //    真人也可能撞上）只需再点一次提交即可通过——检查的是"距开卷的时长"，
    //    重试时自然满足。
    const elapsedSeconds = response.startedAt
      ? (submitLimiterNow - Date.parse(response.startedAt)) / 1000
      : Number.POSITIVE_INFINITY;
    const minSeconds = Math.min(15, 2 + flow.questions.length * 0.5);
    if (elapsedSeconds < minSeconds) {
      console.warn("submit too fast", { responseId, elapsedSeconds, minSeconds });
      return fail(400, "submitted_too_fast", "提交过于仓促，请确认内容后重新提交");
    }
    // 2) 同一设备指纹 + 同一问卷一天最多完成 5 份：一台设备（一个人）反复刷同一
    //    份问卷是刷数据的典型形态；正常用户不会。
    const fingerprintCompletions = Number(
      ((fingerprintResult?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0,
    );
    if (fingerprintCompletions >= SUBMIT_PER_DEVICE_DAILY_MAX) {
      console.warn("submit device daily cap reached", { responseId, surveyId, fingerprintCompletions });
      return fail(429, "device_daily_cap", "该设备今日提交次数过多，请明天再试");
    }
    // 3) 公开发布限额：频道污染的闸门。
    if (publishToTelegram) {
      if (readAtomicRateLimitCountFromBatch(publishIdentityResult) > PUBLISH_TELEGRAM_IDENTITY_DAILY_MAX) {
        console.warn("publish to telegram identity cap reached", { responseId });
        return fail(429, "publish_limit_reached", "今日公开发布次数已达上限，报告仍可保存与查看");
      }
      if (readAtomicRateLimitCountFromBatch(publishIpResult) > PUBLISH_TELEGRAM_IP_DAILY_MAX) {
        console.warn("publish to telegram ip cap reached", { responseId });
        return fail(429, "publish_limit_reached", "今日公开发布次数已达上限，报告仍可保存与查看");
      }
    }
    if (publishToGallery) {
      const system = settingsFromRows((settingsResult?.results ?? []) as Array<{ key: string; value: string }>);
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
        reportPdfUrl: `/report/${responseId}.pdf?t=${token}`,
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
      reportPdfUrl: `/report/${responseId}.pdf?t=${token}`,
      galleryPublished: publishToGallery,
      newAchievements,
    });
  }

  return null;
}
