import type { Env } from "../../index";
import type { QuestionType } from "../../db/schema";
import { getMediaAssetById } from "../../db/repositories/media.repository";
import { getQuestionById } from "../../db/repositories/question.repository";
import { buildMediaResponse } from "../../services/media/media-serve.service";
import {
  countTemporaryMediaBytesForResponse,
  storeTemporaryMedia,
  TEMP_IMAGE_MIME_TYPES,
} from "../../services/media/temporary-media.service";
import { KVMediaStore } from "../../services/media/temporary-media-store";
import { loadSystemSettings } from "../../services/system-settings.service";
import { fail, json } from "../api-response";
import { loadPublishedSurvey } from "./catalog";
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
 * Public media endpoint for survey and response assets.
 *
 * Authorization is scope-based: published survey assets are public, response
 * assets are readable only by the participant who owns the response, and
 * everything else (templates, generated results, identity cards) is refused.
 */
export async function serveSurveyMedia(request: Request, env: Env, mediaId: number): Promise<Response> {
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
