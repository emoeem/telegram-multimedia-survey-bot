import type { Env } from "../../index";
import type { QuestionType } from "../../db/schema";
import {
  getMediaAssetByIdStatement,
  mapMediaAssetStatement,
} from "../../db/repositories/media.repository";
import { getQuestionById } from "../../db/repositories/question.repository";
import { buildMediaResponse } from "../../services/media/media-serve.service";
import {
  countTemporaryMediaBytesForResponse,
  storeTemporaryMedia,
  TEMP_IMAGE_MIME_TYPES,
} from "../../services/media/temporary-media.service";
import { KVMediaStore } from "../../services/media/temporary-media-store";
import { isActiveContentMime, verifyUploadContent } from "../../services/media/upload-validation.service";
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

export function temporaryStore(env: Env): KVMediaStore {
  return new KVMediaStore(env.MEDIA_KV);
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
 * Authorization is scope-based: published survey assets are public, response
 * assets are readable only by the participant who owns the response, and
 * everything else (templates, generated results, identity cards) is refused.
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
    // One statement covers both linkage shapes: attached to a published
    // survey's question/option media, or serving as its cover. The two queries
    // used to run sequentially as a primary/fallback pair, which doubled the
    // round trips of every not-yet-cached asset.
    env.DB.prepare(
      `SELECT 1 AS linked FROM surveys s
         JOIN survey_questions q ON q.survey_id = s.id
         JOIN question_media qm ON qm.question_id = q.id
        WHERE s.status = 'published' AND s.deleted_at IS NULL AND qm.media_asset_id = ?
      UNION
      SELECT 1 AS linked FROM surveys s
         JOIN survey_questions q ON q.survey_id = s.id
         JOIN question_options o ON o.question_id = q.id
         JOIN option_media om ON om.question_option_id = o.id
        WHERE s.status = 'published' AND s.deleted_at IS NULL AND om.media_asset_id = ?
      UNION
      SELECT 1 AS linked FROM surveys s
        WHERE s.status = 'published' AND s.deleted_at IS NULL AND s.cover_media_id = ?`,
    ).bind(mediaId, mediaId, mediaId),
  ]);
  const asset = mapMediaAssetStatement(assetResult);
  if (!asset) return fail(404, "media_not_found", "媒体不存在");

  if (asset.scope === "survey") {
    // Admin-uploaded temporary media (e.g. background music) is allowed
    // before it is attached to any published question/option.
    if (asset.storageKind !== "temporary") {
      const linked = ((linkedResult?.results ?? []) as unknown[]).length > 0;
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
  // Survey-scope bytes are immutable and identity-independent: keep a bounded
  // copy at the edge so the next respondent at this colo skips the database
  // (and, for Telegram-hosted assets, the Bot API download) entirely. The
  // client still receives the year-long immutable policy; the edge copy trades
  // a shorter TTL for a bounded staleness window after unpublish/close.
  // Response-scope and internal assets are personal or private and never enter
  // the shared cache.
  if (asset.scope === "survey" && request.method === "GET" && mediaResponse.status === 200) {
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
