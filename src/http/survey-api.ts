import type { Env } from "../index";
import { verifyTelegramWebAppProfile } from "./admin-api";
import { verifySurveyParticipantToken } from "../services/participant-session.service";
import { getUserById, getUserByTelegramId, upsertUser } from "../db/repositories/user.repository";
import { getParticipantLink, participantHashForKey } from "../db/repositories/participant-link.repository";
import { getBotUsername } from "../bot/telegram";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getQuestionById } from "../db/repositories/question.repository";
import { getSurveyFlow } from "../services/question.service";
import { verifySurveyAccessCode } from "../core/security";
import {
  createResponse,
  getActiveResponse,
  getActiveResponseBySurveyAndUser,
  getCompletedResponseBySurveyAndUser,
  getResponseBySurveyAndHash,
  listAnswersByResponseId,
  completeResponse,
  upsertDateAnswer,
  upsertJsonAnswer,
  upsertMediaAnswer,
  upsertNumberAnswer,
  upsertOptionAnswer,
  upsertTextAnswer,
  upsertTimeAnswer,
} from "../db/repositories/response.repository";
import { countCompletedResponsesBySurveyAndUser } from "../db/repositories/response.repository";
import { createAnswerMedia, createMediaAsset, getMediaAssetById } from "../db/repositories/media.repository";
import type { Answer, QuestionType, SurveyQuestion } from "../db/schema";
import { getMatrixColumns } from "../survey/question-presentation";
import { getFirstQuestion, getNextQuestionAfterOption } from "../survey/engine";
import {
  countTemporaryMediaBytesForResponse,
  storeTemporaryMedia,
  TEMP_IMAGE_MIME_TYPES,
} from "../services/media/temporary-media.service";
import { KVMediaStore } from "../services/media/temporary-media-store";
import { enqueueReportDelivery } from "../services/report-delivery.service";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { createReportAccessToken } from "../services/report-access-token.service";
import { normalizeSurveyTheme } from "../survey/theme";
import { loadSystemSettings } from "../services/system-settings.service";
import { checkRateLimit, rateLimitResponse } from "../services/rate-limit.service";
import { publishProfileResponse } from "../services/profile-gallery.service";

const ANONYMOUS_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PARTICIPANT_LINK_BOT_USERNAME_CACHE_KEY = "participant-link-bot-username";
const TEMP_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const TEMP_AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg"]);
const TEMP_MEDIA_TYPE_LABELS: Record<string, { label: string; mediaType: "photo" | "video" | "audio" | "document" }> = {
  image: { label: "仅支持 JPEG / PNG / WebP 图片", mediaType: "photo" },
  video: { label: "仅支持 MP4 / WebM / MOV 视频", mediaType: "video" },
  audio: { label: "仅支持 MP3 / M4A / WAV / OGG 音频", mediaType: "audio" },
  file: { label: "该文件类型不支持", mediaType: "document" },
};
const TEMP_FILE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function temporaryStore(env: Env): KVMediaStore {
  return new KVMediaStore(env.MEDIA_KV);
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function fail(status: number, code: string, message: string): Response {
  return json({ ok: false, code, message }, status);
}

async function resolveParticipantLinkBotUsername(env: Env): Promise<string | null> {
  try {
    const cached = await env.CACHE.get(PARTICIPANT_LINK_BOT_USERNAME_CACHE_KEY);
    if (cached) return cached;
    const username = await getBotUsername(env.BOT_TOKEN);
    if (!username) return null;
    await env.CACHE.put(PARTICIPANT_LINK_BOT_USERNAME_CACHE_KEY, username, {
      expirationTtl: 7 * 24 * 60 * 60,
    });
    return username;
  } catch (error) {
    console.warn("Resolve participant-link bot username failed", error);
    return null;
  }
}

async function loadPublishedSurvey(
  env: Env,
  surveyId: number,
): Promise<
  | { survey: NonNullable<Awaited<ReturnType<typeof getSurveyById>>>; flow: Awaited<ReturnType<typeof getSurveyFlow>> }
  | Response
> {
  const survey = await getSurveyById(env.DB, surveyId);
  if (!survey || survey.status !== "published") {
    return fail(404, "survey_unavailable", "问卷不存在或未发布");
  }
  const flow = await getSurveyFlow(env.DB, surveyId);
  return { survey, flow };
}

interface Participant {
  kind: "telegram" | "anonymous";
  dbUserId: number | null;
  telegramUserId: number | null;
  participantKey: string | null;
  participantHash: string;
}

export async function resolveParticipant(request: Request, env: Env): Promise<Participant | Response> {
  const initDataHeader = request.headers.get("x-telegram-init-data");
  if (initDataHeader) {
    const profile = await verifyTelegramWebAppProfile(request, env.BOT_TOKEN);
    if (!profile || profile.telegramUserId <= 0) {
      return fail(401, "invalid_identity", "Telegram 身份验证失败");
    }
    await upsertUser(env.DB, {
      telegramUserId: profile.telegramUserId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      languageCode: profile.languageCode,
      systemRole: "participant",
    });
    const user = await getUserByTelegramId(env.DB, profile.telegramUserId);
    if (!user) {
      return fail(500, "identity_lookup_failed", "无法创建用户身份");
    }
    return {
      kind: "telegram",
      dbUserId: user.id,
      telegramUserId: profile.telegramUserId,
      participantKey: null,
      participantHash: `user_${user.id}`,
    };
  }

  const participantToken = request.headers.get("x-participant-token");
  if (participantToken) {
    const profile = await verifySurveyParticipantToken(env.WEBHOOK_SECRET, participantToken);
    if (!profile || profile.telegramUserId <= 0) {
      return fail(401, "invalid_identity", "登录状态已失效，请重新从 Telegram 打开问卷。");
    }
    await upsertUser(env.DB, {
      telegramUserId: profile.telegramUserId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      languageCode: profile.languageCode,
      systemRole: "participant",
    });
    const user = await getUserByTelegramId(env.DB, profile.telegramUserId);
    if (!user) {
      return fail(500, "identity_lookup_failed", "无法创建用户身份");
    }
    return {
      kind: "telegram",
      dbUserId: user.id,
      telegramUserId: profile.telegramUserId,
      participantKey: null,
      participantHash: `user_${user.id}`,
    };
  }

  const participantKey = request.headers.get("x-participant-key");
  if (!participantKey || !ANONYMOUS_KEY_PATTERN.test(participantKey)) {
    return fail(401, "identity_required", "缺少答卷者身份标识");
  }
  // A participant who opted in from the completion page (link_<key> deep link)
  // keeps their browser participant hash for resume/continuity, but every
  // response is attached to the real Telegram user.
  const linked = await getParticipantLink(env.DB, participantKey);
  if (linked) {
    const user = await getUserById(env.DB, linked.userId);
    if (user) {
      return {
        kind: "telegram",
        dbUserId: user.id,
        telegramUserId: user.telegramUserId,
        participantKey,
        participantHash: participantHashForKey(participantKey),
      };
    }
  }
  return {
    kind: "anonymous",
    dbUserId: null,
    telegramUserId: null,
    participantKey,
    participantHash: participantHashForKey(participantKey),
  };
}

function mediaPublicUrl(mediaId: number): string {
  return `/api/survey/media/${mediaId}`;
}

function parseValidation(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sanitizeHeader(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * Merges Cloudflare request geo metadata and referrer into the client-provided
 * browser info JSON so anonymous web responses show more useful context.
 */
function enrichBrowserInfo(raw: string | null, request: Request): string {
  let info: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        info = parsed as Record<string, unknown>;
      }
    } catch {
      info = { raw };
    }
  }
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  const geo: Record<string, string> = {};
  for (const key of ["country", "region", "regionCode", "city", "postalCode", "metroCode", "timezone", "asn", "colo"]) {
    const value = cf[key];
    if (value !== undefined && value !== null && value !== "") {
      geo[key] = String(value);
    }
  }
  if (Object.keys(geo).length) info.geo = geo;
  if (!info.referrer) {
    const referer = request.headers.get("referer") ?? request.headers.get("referrer");
    if (referer) info.referrer = referer.replace(/[\r\n]/g, "").slice(0, 500);
  }
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) info.acceptLanguage = acceptLanguage.slice(0, 200);
  const secChUa = request.headers.get("sec-ch-ua");
  if (secChUa) info.secChUa = secChUa.slice(0, 200);

  // Environment consistency: compare IP-derived country against the browser's
  // timezone and language. This never proves real location, but mismatches are
  // a useful proxy/VPN/geo-inconsistency signal.
  const ipCountry = geo.country;
  const timezone = typeof info.timezone === "string" ? info.timezone : "";
  const language = typeof info.language === "string" ? info.language : "";
  const signals = envConsistencySignals(ipCountry, timezone, language);
  if (signals.length > 0 || ipCountry) {
    const matched = signals.filter((signal) => signal.includes("一致")).length;
    const total = signals.length;
    info.envRisk = {
      score: total ? Math.round((matched / total) * 100) : null,
      signals,
    };
  }
  return JSON.stringify(info).slice(0, 16384);
}

const TZ_COUNTRY: Record<string, string> = {
  "Asia/Shanghai": "CN",
  "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR",
  "Asia/Hong_Kong": "HK",
  "Asia/Taipei": "TW",
  "Asia/Singapore": "SG",
  "Europe/London": "GB",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Madrid": "ES",
  "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Vienna": "AT",
  "Europe/Zurich": "CH",
  "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ",
  "Europe/Budapest": "HU",
  "Europe/Bucharest": "RO",
  "Europe/Athens": "GR",
  "Europe/Lisbon": "PT",
  "Europe/Moscow": "RU",
  "Europe/Istanbul": "TR",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Los_Angeles": "US",
  "America/Denver": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Sao_Paulo": "BR",
  "America/Mexico_City": "MX",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Pacific/Auckland": "NZ",
  "Asia/Kolkata": "IN",
  "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD",
  "Asia/Bangkok": "TH",
  "Asia/Jakarta": "ID",
  "Asia/Kuala_Lumpur": "MY",
  "Asia/Manila": "PH",
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Dubai": "AE",
  "Asia/Tehran": "IR",
  "Asia/Jerusalem": "IL",
  "Asia/Colombo": "LK",
};

const LANG_COUNTRY: Record<string, string> = {
  zh: "CN",
  "zh-tw": "TW",
  "zh-hk": "HK",
  ja: "JP",
  ko: "KR",
  en: "US",
  de: "DE",
  fr: "FR",
  es: "ES",
  it: "IT",
  pt: "PT",
  ru: "RU",
  th: "TH",
  vi: "VN",
  id: "ID",
  ms: "MY",
  ar: "AE",
  tr: "TR",
  nl: "NL",
  pl: "PL",
  sv: "SE",
  cs: "CZ",
  hu: "HU",
  ro: "RO",
  fi: "FI",
  da: "DK",
  no: "NO",
  el: "GR",
  he: "IL",
  hi: "IN",
  ur: "PK",
  bn: "BD",
  ta: "IN",
  uk: "UA",
  fa: "IR",
};

function envConsistencySignals(ipCountry: string | undefined, timezone: string, language: string): string[] {
  const tzCountry = TZ_COUNTRY[timezone];
  const langCountry = LANG_COUNTRY[language.split("-")[0]?.toLowerCase() ?? ""];
  const signals: string[] = [];
  if (ipCountry && tzCountry) {
    signals.push(ipCountry === tzCountry ? "IP 国家与时区一致" : "IP 国家与时区不一致");
  }
  if (ipCountry && langCountry) {
    signals.push(ipCountry === langCountry ? "IP 国家与浏览器语言一致" : "IP 国家与浏览器语言不一致");
  }
  if (tzCountry && langCountry) {
    signals.push(tzCountry === langCountry ? "时区与浏览器语言一致" : "时区与浏览器语言不一致");
  }
  return signals;
}

function parseSettings(value: string | null): Record<string, unknown> | null {
  return parseValidation(value);
}

function questionView(
  question: SurveyQuestion,
  options: Array<{ id: number; label: string; media: Array<{ mediaAssetId: number }> }>,
  questionMedia: Array<{ mediaAssetId: number }>,
): Record<string, unknown> {
  return {
    id: question.id,
    type: question.type,
    title: question.title,
    ...(question.description ? { description: question.description } : {}),
    required: question.required,
    order: question.order,
    pageId: question.pageId,
    validation: parseValidation(question.validationJson),
    settings: parseSettings(question.settingsJson),
    condition: parseValidation(question.conditionJson),
    skipToQuestionId: question.skipToQuestionId,
    media: questionMedia.map((entry) => ({ url: mediaPublicUrl(entry.mediaAssetId) })),
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      media: option.media.map((entry) => ({ url: mediaPublicUrl(entry.mediaAssetId) })),
    })),
  };
}

function answerValue(answer: Answer): unknown {
  if (answer.jsonValue !== null) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { kind?: unknown }).kind === "matrix"
      ) {
        return (parsed as { selections?: unknown }).selections ?? null;
      }
      if (Array.isArray(parsed)) return parsed;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { mediaAssetId?: unknown }).mediaAssetId === "number"
      ) {
        return { mediaAssetId: (parsed as { mediaAssetId: number }).mediaAssetId };
      }
    } catch {
      // fall through to typed columns
    }
  }
  if (answer.textValue !== null) return answer.textValue;
  if (answer.numberValue !== null) return answer.numberValue;
  if (answer.booleanValue !== null) return answer.booleanValue;
  if (answer.ratingValue !== null) return answer.ratingValue;
  if (answer.dateValue !== null) return answer.dateValue;
  if (answer.timeValue !== null) return answer.timeValue;
  return null;
}

export async function handleSurveyApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/surveys") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const conditions = ["s.status = 'published'"];
    const binds: string[] = [];
    if (q) {
      conditions.push("(lower(s.title) LIKE ? OR lower(COALESCE(s.description,'')) LIKE ?)");
      binds.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
    }
    const rows = await env.DB.prepare(
      `SELECT s.id, s.title, s.description, s.access_code accessCode,
                s.published_at publishedAt, s.settings_json settingsJson,
                m.id coverMediaId, m.url coverUrl,
                (SELECT COUNT(*) FROM survey_questions q
                 WHERE q.survey_id = s.id) questionCount
         FROM surveys s
         LEFT JOIN media_assets m ON m.id = s.cover_media_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY s.published_at DESC, s.id DESC
         LIMIT 200`,
    )
      .bind(...binds)
      .all<{
        id: number;
        title: string;
        description: string | null;
        accessCode: string | null;
        publishedAt: string | null;
        questionCount: number;
        settingsJson: string | null;
        coverMediaId: number | null;
        coverUrl: string | null;
      }>();
    return json({
      communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
      surveys: (rows.results ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        ...(row.description ? { description: row.description } : {}),
        accessCodeRequired: Boolean(row.accessCode),
        publishedAt: row.publishedAt,
        questionCount: Number(row.questionCount ?? 0),
        // Always serve the cover through the media endpoint so KV/R2/data-URL
        // covers share one path and the public list stays small.
        ...(typeof row.coverMediaId === "number" ? { coverUrl: mediaPublicUrl(Number(row.coverMediaId)) } : {}),
        theme: normalizeSurveyTheme(parseSettings(row.settingsJson)),
      })),
    });
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
    const loaded = await loadPublishedSurvey(env, surveyId);
    if (loaded instanceof Response) return loaded;
    const { survey, flow } = loaded;
    const system = await loadSystemSettings(env.DB);
    const gallerySurveyId = Number(system.profileGallerySurveyId);
    const isGallerySurvey = Number.isInteger(gallerySurveyId) && gallerySurveyId > 0 && gallerySurveyId === surveyId;
    let canPublishProfile = false;
    if (isGallerySurvey) {
      const participant = await resolveParticipant(request, env);
      canPublishProfile = !(participant instanceof Response) && participant.kind === "telegram";
    }

    const pages = await env.DB.prepare(
      `SELECT id, title, description, "order"
         FROM survey_pages
         WHERE survey_id = ?
         ORDER BY "order" ASC, id ASC`,
    )
      .bind(surveyId)
      .all<{ id: number; title: string | null; description: string | null; order: number }>();

    const questions: unknown[] = [];
    const questionIds = flow.questions.map((question) => question.id);
    const optionMediaByOption = new Map<number, Array<{ mediaAssetId: number }>>();
    const questionMediaByQuestion = new Map<number, Array<{ mediaAssetId: number }>>();
    if (questionIds.length > 0) {
      // json_each keeps this at a single bind regardless of question count;
      // D1 rejects queries with more than 100 bound variables.
      const questionIdsJson = JSON.stringify(questionIds);
      const [questionMedia, optionMedia] = (await env.DB.batch([
        env.DB.prepare(
          `SELECT qm.question_id questionId, m.id mediaAssetId
           FROM question_media qm
           JOIN media_assets m ON m.id = qm.media_asset_id
           JOIN json_each(?) AS q ON q.value = qm.question_id
           ORDER BY qm.sort_order ASC, qm.id ASC`,
        ).bind(questionIdsJson),
        env.DB.prepare(
          `SELECT om.question_option_id optionId, m.id mediaAssetId
           FROM option_media om
           JOIN media_assets m ON m.id = om.media_asset_id
           JOIN question_options o ON o.id = om.question_option_id
           JOIN json_each(?) AS q ON q.value = o.question_id
           ORDER BY om.sort_order ASC, om.id ASC`,
        ).bind(questionIdsJson),
      ])) as [
        D1Result<{ questionId: number; mediaAssetId: number }>,
        D1Result<{ optionId: number; mediaAssetId: number }>,
      ];
      for (const row of questionMedia.results ?? []) {
        const list = questionMediaByQuestion.get(row.questionId) ?? [];
        list.push({ mediaAssetId: row.mediaAssetId });
        questionMediaByQuestion.set(row.questionId, list);
      }
      for (const row of optionMedia.results ?? []) {
        const list = optionMediaByOption.get(row.optionId) ?? [];
        list.push({ mediaAssetId: row.mediaAssetId });
        optionMediaByOption.set(row.optionId, list);
      }
    }
    for (const question of flow.questions) {
      questions.push(
        questionView(
          question,
          question.options.map((option) => ({
            id: option.id,
            label: option.label,
            media: optionMediaByOption.get(option.id) ?? [],
          })),
          questionMediaByQuestion.get(question.id) ?? [],
        ),
      );
    }

    return json({
      id: survey.id,
      title: survey.title,
      ...(survey.description ? { description: survey.description } : {}),
      accessCodeRequired: Boolean(survey.accessCode),
      anonymous: survey.anonymous,
      allowMultiple: survey.allowMultipleResponses,
      maxResponses: survey.maxResponsesPerUser,
      theme: normalizeSurveyTheme(parseSettings(survey.settingsJson)),
      communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
      pages: (pages.results ?? []).map((page) => ({
        id: page.id,
        title: page.title,
        description: page.description,
        order: page.order,
      })),
      questions,
      ...(isGallerySurvey ? { galleryProfile: { enabled: true, canPublish: canPublishProfile } } : {}),
    });
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

async function saveWebAnswer(
  env: Env,
  responseId: number,
  question: Awaited<ReturnType<typeof getSurveyFlow>>["questions"][number],
  value: unknown,
): Promise<Response | null> {
  const type = question.type as QuestionType;
  if (type === "single" || type === "yes_no" || type === "rating") {
    const optionId = Number(value);
    if (!Number.isInteger(optionId) || !question.options.some((option) => option.id === optionId)) {
      return fail(400, "invalid_answer", "选项无效");
    }
    await upsertOptionAnswer(env.DB, {
      responseId,
      questionId: question.id,
      selectedOptionIds: [optionId],
      ...(type === "yes_no" ? { booleanValue: question.options[0]?.id === optionId } : {}),
      ...(type === "rating" ? { ratingValue: ratingOptionValue(question, optionId) } : {}),
    });
    return null;
  }

  if (type === "multiple") {
    if (!Array.isArray(value) || value.some((entry) => !Number.isInteger(Number(entry)))) {
      return fail(400, "invalid_answer", "多选答案必须是选项 ID 数组");
    }
    const selectedOptionIds = value
      .map(Number)
      .filter((optionId) => question.options.some((option) => option.id === optionId));
    if (selectedOptionIds.length === 0) {
      await deleteWebAnswer(env.DB, responseId, question.id);
    } else {
      await upsertOptionAnswer(env.DB, {
        responseId,
        questionId: question.id,
        selectedOptionIds,
      });
    }
    return null;
  }

  if (type === "matrix") {
    const selections =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const columns = getMatrixColumns(question);
    const normalized: Record<string, number> = {};
    for (const row of question.options) {
      const raw = selections[String(row.id)];
      if (raw === undefined || raw === null) continue;
      const columnIndex = Number(raw);
      if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columns.length) {
        return fail(400, "invalid_answer", `矩阵题 ${row.label} 的列无效`);
      }
      normalized[String(row.id)] = columnIndex;
    }
    if (Object.keys(normalized).length === 0) {
      await deleteWebAnswer(env.DB, responseId, question.id);
    } else {
      await upsertJsonAnswer(env.DB, {
        responseId,
        questionId: question.id,
        jsonValue: JSON.stringify({ kind: "matrix", selections: normalized }),
      });
    }
    return null;
  }

  if (type === "text" || type === "long_text") {
    if (typeof value !== "string") return fail(400, "invalid_answer", "文本答案必须是字符串");
    await upsertTextAnswer(env.DB, { responseId, questionId: question.id, textValue: value });
    return null;
  }

  if (type === "number") {
    const numberValue = Number(value);
    if (typeof value !== "number" || !Number.isFinite(numberValue)) {
      return fail(400, "invalid_answer", "数字答案必须是数字");
    }
    await upsertNumberAnswer(env.DB, { responseId, questionId: question.id, numberValue });
    return null;
  }

  if (type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return fail(400, "invalid_answer", "日期格式必须为 YYYY-MM-DD");
    }
    await upsertDateAnswer(env.DB, { responseId, questionId: question.id, dateValue: value });
    return null;
  }

  if (type === "time") {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
      return fail(400, "invalid_answer", "时间格式必须为 HH:MM");
    }
    await upsertTimeAnswer(env.DB, { responseId, questionId: question.id, timeValue: value });
    return null;
  }

  if (type === "image" || type === "video" || type === "audio" || type === "file") {
    const mediaAssetId =
      value && typeof value === "object" && !Array.isArray(value)
        ? Number((value as { mediaAssetId?: unknown }).mediaAssetId)
        : Number(value);
    if (!Number.isInteger(mediaAssetId) || mediaAssetId <= 0) {
      return fail(400, "invalid_answer", "媒体答案无效");
    }
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset || asset.scope !== "response") {
      return fail(404, "media_not_found", "媒体不存在");
    }
    // Ownership: response media is stored under "media:temp:<responseId>:…";
    // refuse assets uploaded for a different response so a participant cannot
    // attach (and thereby read) someone else's upload by enumerating ids.
    if (!asset.storageKey?.startsWith(`media:temp:${responseId}:`)) {
      return fail(403, "media_forbidden", "媒体不属于当前答卷");
    }
    const answerId = await upsertMediaAnswer(env.DB, {
      responseId,
      questionId: question.id,
      mediaAssetId,
    });
    await createAnswerMedia(env.DB, { answerId, mediaAssetId });
    return null;
  }

  return fail(400, "unsupported_type", `不支持的题型：${type}`);
}

function ratingOptionValue(
  question: Awaited<ReturnType<typeof getSurveyFlow>>["questions"][number],
  optionId: number,
): number | null {
  const option = question.options.find((item) => item.id === optionId);
  const candidate = Number(option?.value ?? option?.label ?? optionId);
  return Number.isFinite(candidate) ? candidate : null;
}

async function deleteWebAnswer(db: D1Database, responseId: number, questionId: number): Promise<void> {
  const answer = await db
    .prepare("SELECT id FROM answers WHERE response_id = ? AND question_id = ? LIMIT 1")
    .bind(responseId, questionId)
    .first<{ id: number }>();
  if (!answer) return;
  await db.batch([
    db.prepare("DELETE FROM answer_media WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answer_options WHERE answer_id = ?").bind(answer.id),
    db.prepare("DELETE FROM answers WHERE id = ?").bind(answer.id),
  ]);
}

function findMissingRequiredQuestion(
  flowQuestions: Awaited<ReturnType<typeof getSurveyFlow>>["questions"],
  answersByQuestion: Map<number, Answer>,
): SurveyQuestion | null {
  const visited = new Set<number>();
  let current = getFirstQuestion({ questions: flowQuestions });
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const answer = answersByQuestion.get(current.id);
    if (current.required && !isWebAnswerPresent(answer)) {
      return current;
    }
    const selectedOptionId = selectedWebOptionId(current, answer);
    current = getNextQuestionAfterOption({ questions: flowQuestions }, current.id, selectedOptionId);
  }
  return null;
}

function isWebAnswerPresent(answer: Answer | undefined): boolean {
  if (!answer) return false;
  if (answer.jsonValue !== null) {
    try {
      const parsed = JSON.parse(answer.jsonValue) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "matrix") {
        const selections = (parsed as { selections?: Record<string, unknown> }).selections ?? {};
        return Object.keys(selections).length > 0;
      }
    } catch {
      return true;
    }
    return true;
  }
  // A whitespace-only text answer counts as unanswered so required text
  // questions cannot be satisfied by an empty string.
  return (
    (answer.textValue !== null && answer.textValue.trim() !== "") ||
    answer.numberValue !== null ||
    answer.booleanValue !== null ||
    answer.ratingValue !== null ||
    answer.dateValue !== null ||
    answer.timeValue !== null
  );
}

function selectedWebOptionId(question: SurveyQuestion, answer: Answer | undefined): number | null {
  if (question.type !== "single" && question.type !== "yes_no" && question.type !== "rating") {
    return null;
  }
  if (!answer?.jsonValue) return null;
  try {
    const parsed = JSON.parse(answer.jsonValue) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const optionId = Number(parsed[0]);
      return Number.isInteger(optionId) && optionId > 0 ? optionId : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function serveSurveyMedia(request: Request, env: Env, mediaId: number): Promise<Response> {
  const asset = await getMediaAssetById(env.DB, mediaId);
  if (!asset) return fail(404, "media_not_found", "媒体不存在");

  if (asset.scope === "survey") {
    // Admin-uploaded temporary media (e.g. background music) is allowed
    // before it is attached to any published question/option.
    if (asset.storageKind !== "temporary") {
      let linked = await env.DB.prepare(
        `SELECT s.id FROM surveys s
           JOIN survey_questions q ON q.survey_id = s.id
           JOIN question_media qm ON qm.question_id = q.id
           WHERE s.status = 'published' AND qm.media_asset_id = ?
           UNION
           SELECT s.id FROM surveys s
           JOIN survey_questions q ON q.survey_id = s.id
           JOIN question_options o ON o.question_id = q.id
           JOIN option_media om ON om.question_option_id = o.id
           WHERE s.status = 'published' AND om.media_asset_id = ?`,
      )
        .bind(mediaId, mediaId)
        .first<{ id: number }>();
      if (!linked) {
        linked = await env.DB.prepare(
          `SELECT s.id FROM surveys s
             WHERE s.status = 'published' AND s.cover_media_id = ?`,
        )
          .bind(mediaId)
          .first<{ id: number }>();
      }
      if (!linked) return fail(404, "media_not_found", "媒体不属于已发布问卷");
    }
  } else if (asset.scope === "response") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const owned = await env.DB.prepare(
      `SELECT r.id FROM survey_responses r
         JOIN answers a ON a.response_id = r.id
         JOIN answer_media am ON am.answer_id = a.id
         WHERE am.media_asset_id = ? AND r.participant_hash = ?
         LIMIT 1`,
    )
      .bind(mediaId, participant.participantHash)
      .first<{ id: number }>();
    if (!owned) return fail(403, "media_forbidden", "无权访问该媒体");
  } else {
    return fail(403, "media_forbidden", "媒体不可公开访问");
  }

  const mediaResponse = await buildMediaResponse(env, asset);
  if (!mediaResponse) {
    return fail(404, "media_unavailable", "媒体不可用");
  }
  return mediaResponse;
}

export async function handleSurveyMediaUpload(request: Request, env: Env, surveyId: number): Promise<Response> {
  const loaded = await loadPublishedSurvey(env, surveyId);
  if (loaded instanceof Response) return loaded;
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const response = await env.DB.prepare(
    `SELECT id FROM survey_responses
       WHERE survey_id = ? AND participant_hash = ? AND status = 'in_progress'
       ORDER BY id DESC LIMIT 1`,
  )
    .bind(surveyId, participant.participantHash)
    .first<{ id: number }>();
  if (!response) return fail(404, "response_not_found", "请先开始填写问卷");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "invalid_upload", "上传内容无效");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail(400, "invalid_upload", "缺少 file 字段");
  }

  // The upload endpoint is shared by all media question types; the current
  // question decides which MIME kinds and size limits apply.
  const questionIdRaw = form.get("questionId");
  let questionType = "image" as QuestionType;
  let allowedMimeTypes: Set<string> | null = null;
  let maxSizeMb: number | null = null;
  if (questionIdRaw !== null) {
    const questionId = Number(String(questionIdRaw));
    if (!Number.isInteger(questionId) || questionId <= 0) {
      return fail(400, "invalid_question", "题目编号无效");
    }
    const question = await getQuestionById(env.DB, questionId);
    if (!question || question.surveyId !== surveyId) {
      return fail(400, "invalid_question", "题目不存在");
    }
    questionType = question.type;
    if (question.validationJson) {
      try {
        const parsed = JSON.parse(question.validationJson) as {
          allowed_mime_types?: unknown;
          max_size_mb?: unknown;
        };
        if (
          Array.isArray(parsed.allowed_mime_types) &&
          parsed.allowed_mime_types.every((value) => typeof value === "string")
        ) {
          allowedMimeTypes = new Set(parsed.allowed_mime_types.map((value) => value.toLowerCase()));
        }
        if (typeof parsed.max_size_mb === "number" && Number.isFinite(parsed.max_size_mb) && parsed.max_size_mb > 0) {
          maxSizeMb = parsed.max_size_mb;
        }
      } catch {
        // Malformed validation is ignored; type-level defaults still apply.
      }
    }
  }
  const policy = TEMP_MEDIA_TYPE_LABELS[questionType];
  if (!policy) {
    return fail(400, "invalid_question", "该题目不是媒体上传题");
  }
  const mimeType = (file.type || (questionType === "file" ? "application/octet-stream" : "")).toLowerCase();
  const typeAllowlist =
    questionType === "image"
      ? TEMP_IMAGE_MIME_TYPES
      : questionType === "video"
        ? TEMP_VIDEO_MIME_TYPES
        : questionType === "audio"
          ? TEMP_AUDIO_MIME_TYPES
          : null;
  if (
    !mimeType ||
    (typeAllowlist && !typeAllowlist.has(mimeType)) ||
    (allowedMimeTypes && !allowedMimeTypes.has(mimeType))
  ) {
    return fail(400, "invalid_media_type", allowedMimeTypes ? "该文件类型不符合本题要求" : policy.label);
  }

  const settings = await loadSystemSettings(env.DB);
  const typeDefaultBytes = questionType === "image" ? settings.maxUploadMb * 1024 * 1024 : TEMP_FILE_UPLOAD_MAX_BYTES;
  const maxUploadBytes = Math.min(
    maxSizeMb !== null ? maxSizeMb * 1024 * 1024 : typeDefaultBytes,
    TEMP_FILE_UPLOAD_MAX_BYTES,
  );
  if (file.size > maxUploadBytes) {
    return fail(413, "upload_too_large", `单个文件不能超过 ${Math.floor(maxUploadBytes / 1024 / 1024)}MB`);
  }
  const currentBytes = await countTemporaryMediaBytesForResponse(env.DB, response.id);
  const maxResponseBytes = settings.maxResponseMediaMb * 1024 * 1024;
  if (currentBytes + file.size > maxResponseBytes) {
    return fail(413, "response_media_limit", `单份答卷媒体总量不能超过 ${settings.maxResponseMediaMb}MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const asset = await storeTemporaryMedia(env.DB, temporaryStore(env), {
    responseId: response.id,
    bytes,
    mimeType,
    fileName: file.name || null,
    mediaType: policy.mediaType,
    ttlSeconds: settings.mediaTtlSeconds,
  });
  return json({ ok: true, mediaAssetId: asset.id, url: mediaPublicUrl(asset.id) }, 201);
}
