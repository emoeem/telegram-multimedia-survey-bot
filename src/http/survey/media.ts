import type { Env } from "../../index";
import type { QuestionType } from "../../db/schema";
import { getMediaAssetByIdStatement, mapMediaAssetStatement } from "../../db/repositories/media.repository";
import { getQuestionById } from "../../db/repositories/question.repository";
import { buildMediaResponse } from "../../services/media/media-serve.service";
import { hasValidAdminSession } from "../admin-session";
import {
  countTemporaryMediaBytesForResponse,
  MAX_RESPONSE_MEDIA_BYTES,
  R2_MAX_PER_FILE_BYTES,
  R2_MAX_RESPONSE_MEDIA_BYTES,
  storeTemporaryMedia,
  TEMP_IMAGE_MIME_TYPES,
} from "../../services/media/temporary-media.service";
import { createMediaStore, type TemporaryMediaStore } from "../../services/media/temporary-media-store";
import {
  createStreamDirectUpload,
  STREAM_MAX_DURATION_SECONDS,
  STREAM_TICKET_TTL_SECONDS,
  streamConfigured,
} from "../../services/media/stream.service";
import { isActiveContentMime, verifyUploadContent } from "../../services/media/upload-validation.service";
import { checkRateLimit } from "../../services/rate-limit.service";
import { r18ParticipantGate } from "../../services/content-rating.service";
import { loadSystemSettings } from "../../services/system-settings.service";
import { fail, json } from "../api-response";
import { getSurveyByIdStatement, mapSurveyStatementResult } from "../../db/repositories/survey.repository";
import { mediaPublicUrl } from "./presentation";
import { resolveParticipant } from "./participant";

const TEMP_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const TEMP_AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg"]);
const TEMP_MEDIA_TYPE_LABELS: Record<string, { label: string; mediaType: "photo" | "video" | "audio" | "document" }> = {
  image: { label: "仅支持 JPEG / PNG / WebP 图片", mediaType: "photo" },
  video: { label: "仅支持 MP4 / WebM / MOV 视频", mediaType: "video" },
  audio: { label: "仅支持 MP3 / M4A / WAV / OGG 音频", mediaType: "audio" },
  file: { label: "该文件类型不支持", mediaType: "document" },
};
const TEMP_FILE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export function temporaryStore(env: Env): TemporaryMediaStore {
  return createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV });
}

/**
 * How long the edge (`caches.default`) may hold a survey-scope media response.
 *
 * Deliberately much shorter than the browser TTL: the browser copy is keyed by
 * an immutable asset id (a replacement upload gets a new id), but the *edge*
 * entry is keyed by URL alone and would keep serving an asset after its survey
 * was closed, archived or its media detached. A day bounds that exposure while
 * still absorbing the repeat-view traffic of a story survey's scene images,
 * sprites and BGM — each of which used to pay two or three D1 round trips and,
 * for Telegram-hosted assets, a live Bot API download on every cache-expired
 * view. No active purge is wired into close/archive; the honest trade-off is
 * documented instead: a detached asset can remain fetchable at the edge for up
 * to a day, which is strictly narrower than the year-long copies already held
 * by every browser that loaded it.
 */
const MEDIA_EDGE_CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * The Workers Cache API (`caches.default`). Typed indirectly because the
 * enabled lib set also brings in the standard `CacheStorage`, which has no
 * `default` property; on the Workers runtime it is the edge cache. Returns
 * null where the global is absent (unit tests run in plain Node).
 */
function edgeCache(): Cache | null {
  try {
    const cache = (caches as unknown as { default?: Cache }).default;
    return cache ?? null;
  } catch {
    return null;
  }
}

/**
 * Public media endpoint for survey and response assets.
 *
 * Authorization is scope-based: assets linked to a once-published survey
 * (published / closed / archived) are public, response assets are readable
 * only by the participant who owns the response, unlinked survey assets
 * (draft uploads, detached media) require an admin session, and everything
 * else (templates, generated results, identity cards) is refused.
 *
 * Cost shape: survey-scope assets cost ONE D1 round trip (asset row plus the
 * published-linkage checks in a single batch) and then nothing at all — an
 * edge-cached repeat view returns before the database is touched. Response
 * scope keeps its per-request participant resolution.
 */
export async function serveSurveyMedia(request: Request, env: Env, mediaId: number): Promise<Response> {
  // The edge copy is keyed by URL and only ever contains identity-independent,
  // survey-scope responses, so a hit needs no authorization and no database.
  // Misses fall through to the full auth path below.
  if (request.method === "GET") {
    try {
      const cached = await edgeCache()?.match(request);
      if (cached) return cached;
    } catch {
      // A broken edge cache must not break media serving.
    }
  }

  const [assetResult, linkedResult] = await env.DB.batch([
    getMediaAssetByIdStatement(env.DB, mediaId),
    // One statement covers both linkage shapes: attached to a
    // once-published survey's question/option media, or serving as its cover.
    // "Once-published" means published/closed/archived: a closed or archived
    // survey still has historical respondents reading their reports, and its
    // media was public while it ran — denying it now would break old reports.
    // Draft surveys and soft-deleted surveys never linked anything publicly.
    // The two queries used to run sequentially as a primary/fallback pair,
    // which doubled the round trips of every not-yet-cached asset.
    env.DB.prepare(
      `SELECT 1 AS linked FROM surveys s
         JOIN survey_questions q ON q.survey_id = s.id
         JOIN question_media qm ON qm.question_id = q.id
        WHERE s.status IN ('published', 'closed', 'archived') AND s.deleted_at IS NULL AND qm.media_asset_id = ?
      UNION
      SELECT 1 AS linked FROM surveys s
         JOIN survey_questions q ON q.survey_id = s.id
         JOIN question_options o ON o.question_id = q.id
         JOIN option_media om ON om.question_option_id = o.id
        WHERE s.status IN ('published', 'closed', 'archived') AND s.deleted_at IS NULL AND om.media_asset_id = ?
      UNION
      SELECT 1 AS linked FROM surveys s
        WHERE s.status IN ('published', 'closed', 'archived') AND s.deleted_at IS NULL AND s.cover_media_id = ?
      UNION
      /* 第四种挂载:galgame 卷的立绘/BGM/背景不走媒体表,而是以
       * "/api/survey/media/<id>" 的 URL 字符串嵌在 surveys.settings_json 里
       * (背景、BGM、按页音频、立绘都在这)。用 instr 找两侧都带引号的完整
       * 引用串:JSON 值的引号边界天然防 767 误配 1767。id 必须绑成字符串:
       * number 绑定会被当 REAL,concat 时 8 变成 '8.0',永远匹配不上。 */
      SELECT 1 AS linked FROM surveys s
       WHERE s.status IN ('published', 'closed', 'archived') AND s.deleted_at IS NULL
         AND instr(s.settings_json, '"/api/survey/media/' || ? || '"') > 0
      /* 第五种挂载(阶段 D):写入侧改存 {assetId} 结构化引用后,URL 字符串
       * 匹配(第四路)看不见它们。theme 保存时引用会事务性落成 media_refs
       * (ref_type='survey_theme', ref_key='survey:<id>:<assetId>'),这里 JOIN
       * 已发布问卷校验公开性——发布时刻即正确,不依赖每日 cron。URL 字符串
       * 形态的旧数据继续走第四路,两形态在过渡期并存。 */
      UNION
      SELECT 1 AS linked FROM surveys s
       JOIN media_refs mr ON mr.ref_type = 'survey_theme' AND mr.asset_id = ?
        AND mr.ref_key = 'survey:' || s.id || ':' || ?
       WHERE s.status IN ('published', 'closed', 'archived') AND s.deleted_at IS NULL
      /* 第六种挂载(2026-10-29 扩展包):quest 剧情扩展包的插画 URL 写在
       * task_packs.settings_json 的 content(JSON 字符串字段)里——嵌套 JSON
       * 的引号是转义形态(\"),所以匹配串要有两个分支:顶层未转义(与第四路
       * 同款)与嵌套转义(闭合引号前多一个反斜杠)。转义形态的边界同样防
       * 767 误配 1767(数字后面必须紧跟引号)。启用中的包才放行——停用即
       * 不再公开(边缘缓存最长滞后一天,与上方 survey-scope 取舍一致)。 */
      UNION
      SELECT 1 AS linked FROM task_packs
       WHERE enabled = 1
         AND (
           instr(settings_json, '"/api/survey/media/' || ? || '"') > 0
           OR instr(settings_json, '"/api/survey/media/' || ? || '\\"') > 0
         )`,
    ).bind(mediaId, mediaId, mediaId, String(mediaId), mediaId, String(mediaId), String(mediaId), String(mediaId)),
  ]);
  const asset = mapMediaAssetStatement(assetResult);
  if (!asset) return fail(404, "media_not_found", "媒体不存在");
  const linkedToPublicSurvey = ((linkedResult?.results ?? []) as unknown[]).length > 0;

  if (asset.scope === "survey") {
    /* Draft-survey and detached-survey assets are NOT public: they used to be
     * readable by anyone guessing sequential ids, leaking unreleased content.
     * The one legitimate consumer of unlinked assets is the admin editor's
     * preview, which rides the same URL with the admin session cookie. */
    if (!linkedToPublicSurvey && !(await hasValidAdminSession(request, env))) {
      return fail(404, "media_not_found", "媒体不属于已发布问卷");
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
  // Survey-scope bytes are immutable and identity-independent: keep a bounded
  // copy at the edge so the next respondent at this colo skips the database
  // (and, for Telegram-hosted assets, the Bot API download) entirely. The
  // client still receives the year-long immutable policy; the edge copy trades
  // a shorter TTL for a bounded staleness window after unpublish/close.
  // Response-scope and internal assets are personal or private and never enter
  // the shared cache — and neither do admin-previewed draft assets: the edge
  // entry is keyed by URL alone, so caching one would hand it to everyone.
  if (asset.scope === "survey" && linkedToPublicSurvey && request.method === "GET" && mediaResponse.status === 200) {
    const cache = edgeCache();
    if (cache) {
      try {
        const edgeHeaders = new Headers(mediaResponse.headers);
        edgeHeaders.set("Cache-Control", `public, max-age=${MEDIA_EDGE_CACHE_TTL_SECONDS}`);
        await cache.put(request, new Response(mediaResponse.clone().body, { headers: edgeHeaders }));
      } catch (error) {
        console.warn("Media edge cache put failed", { mediaId, error });
      }
    }
  }
  return mediaResponse;
}

/**
 * Uploads one answer attachment to the temporary media store.
 *
 * Validation is layered: the question type decides the MIME allowlist, the
 * question's own validation JSON can narrow it further, per-file and
 * per-response size caps come from system settings, and the stored asset is
 * namespaced per response so it can only ever be attached back to that
 * response.
 */
export async function handleSurveyMediaUpload(request: Request, env: Env, surveyId: number): Promise<Response> {
  // 总闸先生效：打满后不读表单、不查库，直接拒。
  const dailyQuota = await checkRateLimit(
    env.CACHE,
    "media-upload-daily",
    "global",
    MEDIA_DAILY_UPLOAD_LIMIT,
    DAY_SECONDS,
  );
  if (!dailyQuota.allowed) {
    return fail(429, "media_daily_limit", "今日上传额度已满，请明天再试");
  }
  // Only the publication check is needed here (the question row is read
  // separately below), so this reads the survey row alone: no flow cache, no
  // questions/options read.
  const [surveyRowResult] = await env.DB.batch([getSurveyByIdStatement(env.DB, surveyId)]);
  const survey = mapSurveyStatementResult(surveyRowResult);
  if (!survey || survey.status !== "published") {
    return fail(404, "survey_unavailable", "问卷不存在或未发布");
  }
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const mediaAgeGate = await r18ParticipantGate(env.DB, survey, participant);
  if (mediaAgeGate) return mediaAgeGate;
  if (participant.kind === "anonymous") {
    return fail(401, "registration_required", "上传前请先注册或登录（邮箱即可）");
  }
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

  // A `file` question accepts any declared MIME, and the declared MIME is what
  // gets served back from the media endpoint. Never let an active-content type
  // (HTML/SVG/XML/JS) in — a stored HTML document would run on the app origin.
  if (isActiveContentMime(mimeType)) {
    return fail(400, "invalid_media_type", "该文件类型不允许上传");
  }

  const settings = await loadSystemSettings(env.DB);
  // R2 部署放宽单文件天花板（KV 25MB 值上限不复存在）；运营配置仍然取小。
  const hardCeiling = env.MEDIA ? R2_MAX_PER_FILE_BYTES : TEMP_FILE_UPLOAD_MAX_BYTES;
  const typeDefaultBytes = questionType === "image" ? settings.maxUploadMb * 1024 * 1024 : hardCeiling;
  const maxUploadBytes = Math.min(maxSizeMb !== null ? maxSizeMb * 1024 * 1024 : typeDefaultBytes, hardCeiling);
  if (file.size > maxUploadBytes) {
    return fail(413, "upload_too_large", `单个文件不能超过 ${Math.floor(maxUploadBytes / 1024 / 1024)}MB`);
  }
  const currentBytes = await countTemporaryMediaBytesForResponse(env.DB, response.id);
  const responseCeilingMb = Math.floor(
    Math.min(
      settings.maxResponseMediaMb * 1024 * 1024,
      env.MEDIA ? R2_MAX_RESPONSE_MEDIA_BYTES : MAX_RESPONSE_MEDIA_BYTES,
    ) /
      (1024 * 1024),
  );
  const maxResponseBytes = responseCeilingMb * 1024 * 1024;
  if (currentBytes + file.size > maxResponseBytes) {
    return fail(413, "response_media_limit", `单份答卷媒体总量不能超过 ${responseCeilingMb}MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Magic-byte check media uploads (image/video/audio) so a mismatched or
  // unrecognized payload can't masquerade as an allowed type. `file` (document)
  // uploads are protected by the active-content rejection above and by the
  // serve-side downgrade in `buildMediaResponse`, and their declared type is
  // kept so legitimate documents (docx/xlsx/...) are not mislabeled.
  if (questionType !== "file") {
    const validation = verifyUploadContent(bytes, mimeType);
    if (!validation.ok) {
      return fail(400, "invalid_media_type", validation.reason ?? "文件内容无效");
    }
  }
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

/** 单份答卷最多挂多少条 Stream 视频：云转码按条计费，收敛滥用面。 */
const MAX_STREAM_ASSETS_PER_RESPONSE = 10;

const DAY_SECONDS = 24 * 60 * 60;

/**
 * 全局每日（UTC）Stream 凭证上限 —— 与请求来源无关的总闸。
 *
 * 单张凭证允许最长 `STREAM_MAX_DURATION_SECONDS`（15 分钟）的视频，而 Stream
 * Basic 按分钟计费（$5 / 1000 分钟）。`20 次/分钟/IP` 的限流只按 IP 计数，
 * 换一个出口 IP 就重置，挡不住邮箱农场批量注册后逐份答卷刷凭证。
 *
 * 30 张/天 ⇒ 最坏 450 分钟/天（约 $2.25/天），正常业务用量（单份答卷 ≤10 条）
 * 离这条线很远。被打满时受影响的是全体用户，这是有意的取舍：宁可少收一天
 * 视频，也不让计费额度被无声刷穿。
 */
const STREAM_DAILY_TICKET_LIMIT = 30;

/**
 * 全局每日（UTC）普通媒体上传次数上限。
 *
 * R2 存储单价低（$0.015/GB/月）且临时媒体 7 天过期，但它同时消耗 Worker
 * 请求、D1 写与（首次上传时的）校验 CPU。300 次/天足以覆盖正常答卷用量，
 * 又能在多 IP 轮换刷上传时先刹住。
 */
const MEDIA_DAILY_UPLOAD_LIMIT = 300;

/**
 * `POST /api/survey/:id/media/stream-ticket`（Pro 部署的视频/音频答卷）。
 *
 * Worker 不经手视频字节：校验身份与配额后铸造一张 Stream 直传凭证并落一条
 * `storage_kind='stream'` 的占位行（expires_at = 凭证过期点，未完成上传的
 * 行由每日 cron 对账清理）。浏览器拿到 `uploadUrl` 后直传 Cloudflare，
 * 上传完成与否通过媒体端点按 Stream 状态查询。
 */
export async function handleStreamTicketRequest(request: Request, env: Env, surveyId: number): Promise<Response> {
  if (!streamConfigured(env)) {
    return fail(404, "stream_unavailable", "当前部署未启用视频托管");
  }
  // 总闸放在任何 D1 读之前：打满后连问卷/答卷都不用查，直接拒。
  const dailyQuota = await checkRateLimit(
    env.CACHE,
    "stream-ticket-daily",
    "global",
    STREAM_DAILY_TICKET_LIMIT,
    DAY_SECONDS,
  );
  if (!dailyQuota.allowed) {
    return fail(429, "stream_daily_limit", "今日视频上传额度已满，请明天再试");
  }
  const [surveyRowResult] = await env.DB.batch([getSurveyByIdStatement(env.DB, surveyId)]);
  const survey = mapSurveyStatementResult(surveyRowResult);
  if (!survey || survey.status !== "published") {
    return fail(404, "survey_unavailable", "问卷不存在或未发布");
  }
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const mediaAgeGate = await r18ParticipantGate(env.DB, survey, participant);
  if (mediaAgeGate) return mediaAgeGate;
  if (participant.kind === "anonymous") {
    return fail(401, "registration_required", "上传前请先注册或登录（邮箱即可）");
  }
  const response = await env.DB.prepare(
    `SELECT id FROM survey_responses
       WHERE survey_id = ? AND participant_hash = ? AND status = 'in_progress'
       ORDER BY id DESC LIMIT 1`,
  )
    .bind(surveyId, participant.participantHash)
    .first<{ id: number }>();
  if (!response) return fail(404, "response_not_found", "请先开始填写问卷");

  const body = (await request.json().catch(() => null)) as { kind?: unknown; maxDurationSeconds?: unknown } | null;
  const kind = body?.kind === "audio" ? "audio" : "video";
  const maxDurationSeconds =
    typeof body?.maxDurationSeconds === "number" && body.maxDurationSeconds > 0
      ? Math.min(Math.floor(body.maxDurationSeconds), STREAM_MAX_DURATION_SECONDS)
      : STREAM_MAX_DURATION_SECONDS;

  // media_assets 没有 response_id 列：占位行以 `stream:{responseId}:{uid}`
  // 作为 storage_key（与临时媒体的 media:temp:{id}: 前缀约定一致），
  // 归属与计数都走前缀。
  const prefix = `stream:${response.id}:`;
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM media_assets
       WHERE asset_scope = 'response' AND storage_kind = 'stream' AND storage_key LIKE ? || '%'`,
  )
    .bind(prefix)
    .first<{ n: number }>();
  const count = Number(existing?.n ?? 0);
  if (count >= MAX_STREAM_ASSETS_PER_RESPONSE) {
    return fail(413, "stream_limit", `单份答卷最多 ${MAX_STREAM_ASSETS_PER_RESPONSE} 条视频`);
  }

  let ticket;
  try {
    ticket = await createStreamDirectUpload(env, {
      maxDurationSeconds,
      metaName: `resp-${response.id}-${kind}`,
    });
  } catch (error) {
    console.error("Stream ticket creation failed", error);
    return fail(502, "stream_ticket_failed", "视频上传凭证创建失败，请稍后重试");
  }

  // 占位行：expires_at = 凭证过期点。上传成功后媒体端点会把 expires_at 清空
  // （转正），未上传的行由每日 cron 按 expires_at 清理并删除 Stream 侧对象。
  const expiresAt = new Date(Date.now() + STREAM_TICKET_TTL_SECONDS * 1000).toISOString();
  const { createMediaAsset } = await import("../../db/repositories/media.repository");
  const asset = await createMediaAsset(env.DB, {
    scope: "response",
    mediaType: kind === "audio" ? "audio" : "video",
    storageKind: "stream",
    storageKey: `${prefix}${ticket.videoUid}`,
    expiresAt,
    fileName: `${ticket.videoUid}.${kind === "audio" ? "m4a" : "mp4"}`,
  });

  return json(
    {
      ok: true,
      mediaAssetId: asset.id,
      videoUid: ticket.videoUid,
      uploadUrl: ticket.uploadUrl,
      maxDurationSeconds,
    },
    201,
  );
}
