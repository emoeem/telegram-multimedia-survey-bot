import type { Env } from "../index";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { prepareResultProfileForResponse } from "../services/result-visual.service";
import { deserializeResultProfile } from "../services/result-engine.service";
import { buildReportViewModel } from "../services/html-report-renderer.service";
import { buildResponsiveReportHtml, type ResponsiveReportMeta } from "../services/report/web";
import { REPORT_TEMPLATES } from "../services/report/template";
import { verifyReportAccessToken } from "../services/report-access-token.service";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { loadSystemSettings } from "../services/system-settings.service";

function fail(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, code, message }, { status });
}

export async function handleReportRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (request.method !== "GET") {
    return fail(405, "method_not_allowed", "仅支持 GET");
  }

  const mediaMatch = url.pathname.match(/^\/api\/report\/media\/(\d+)$/);
  if (mediaMatch) {
    return serveReportMedia(env, url, Number(mediaMatch[1]));
  }

  const pageMatch = url.pathname.match(/^\/report\/(\d+)$/);
  if (!pageMatch) return null;
  return serveReportPage(env, url, Number(pageMatch[1]));
}

function mediaAssetIdFromValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as { mediaAssetId?: unknown }).mediaAssetId;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

async function serveReportPage(
  env: Env,
  url: URL,
  responseId: number,
): Promise<Response> {
  const token = url.searchParams.get("t");
  const valid = await verifyReportAccessToken(env.WEBHOOK_SECRET, responseId, token);
  if (!valid) {
    return fail(403, "invalid_report_token", "报告链接无效或已过期");
  }

  const response = await env.DB
    .prepare(
      `SELECT id, survey_id surveyId, status, completed_at completedAt
       FROM survey_responses WHERE id = ? LIMIT 1`,
    )
    .bind(responseId)
    .first<{ id: number; surveyId: number; status: string; completedAt: string | null }>();
  if (!response || response.status !== "completed") {
    return fail(404, "report_unavailable", "报告不存在或尚未生成");
  }

  const survey = await getSurveyById(env.DB, response.surveyId);
  const prepared = await prepareResultProfileForResponse(env.DB, responseId);
  if (!prepared) {
    return fail(404, "report_unavailable", "报告不存在或尚未生成");
  }
  const snapshot = deserializeResultProfile(prepared.profile);
  const images: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot.images)) {
    if (key.startsWith("template.")) continue;
    const mediaAssetId = mediaAssetIdFromValue(value);
    if (mediaAssetId !== null) {
      images[key] =
        `/api/report/media/${mediaAssetId}?t=${encodeURIComponent(token ?? "")}&rid=${responseId}`;
    }
  }

  const viewModel = buildReportViewModel(snapshot, images);
  const defaultTemplate = (await loadSystemSettings(env.DB)).defaultReportTemplate;
  const templateId =
    url.searchParams.get("template") ??
    survey?.reportTemplateId ??
    defaultTemplate ??
    "";
  const template = REPORT_TEMPLATES[templateId] ?? undefined;
  const meta: ResponsiveReportMeta = {
    reportId: `#${responseId}`,
  };
  if (survey?.title) meta.surveyTitle = survey.title;
  if (response.completedAt) meta.completedAt = response.completedAt;
  const html = buildResponsiveReportHtml(viewModel, meta, template);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}

async function serveReportMedia(
  env: Env,
  url: URL,
  mediaId: number,
): Promise<Response> {
  const responseId = Number(url.searchParams.get("rid"));
  const token = url.searchParams.get("t");
  if (!Number.isInteger(responseId) || responseId <= 0) {
    return fail(400, "invalid_request", "缺少答卷编号");
  }
  const valid = await verifyReportAccessToken(env.WEBHOOK_SECRET, responseId, token);
  if (!valid) {
    return fail(403, "invalid_report_token", "报告链接无效或已过期");
  }

  const asset = await getMediaAssetById(env.DB, mediaId);
  if (!asset) return fail(404, "media_not_found", "媒体不存在");

  if (asset.scope === "response") {
    const owned = await env.DB
      .prepare(
        `SELECT 1 AS found
         FROM answer_media am
         JOIN answers a ON a.id = am.answer_id
         JOIN survey_responses r ON r.id = a.response_id
         WHERE am.media_asset_id = ? AND r.id = ?
         LIMIT 1`,
      )
      .bind(mediaId, responseId)
      .first<{ found: number }>();
    if (!owned) return fail(403, "media_forbidden", "无权访问该媒体");
  } else if (asset.scope === "survey") {
    const linked = await env.DB
      .prepare(
        `SELECT 1 AS found
         FROM question_media qm
         JOIN survey_questions q ON q.id = qm.question_id
         JOIN survey_responses r ON r.survey_id = q.survey_id
         WHERE qm.media_asset_id = ? AND r.id = ?
         UNION
         SELECT 1 AS found
         FROM option_media om
         JOIN question_options o ON o.id = om.question_option_id
         JOIN survey_questions q ON q.id = o.question_id
         JOIN survey_responses r ON r.survey_id = q.survey_id
         WHERE om.media_asset_id = ? AND r.id = ?
         LIMIT 1`,
      )
      .bind(mediaId, responseId, mediaId, responseId)
      .first<{ found: number }>();
    if (!linked) return fail(403, "media_forbidden", "无权访问该媒体");
  } else {
    return fail(403, "media_forbidden", "媒体不可访问");
  }

  const mediaResponse = await buildMediaResponse(env, asset);
  if (!mediaResponse) {
    return fail(404, "media_unavailable", "媒体不可用");
  }
  return mediaResponse;
}
