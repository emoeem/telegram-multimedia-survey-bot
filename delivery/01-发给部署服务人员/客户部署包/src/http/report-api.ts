import type { Env } from "../index";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { prepareResultProfileForResponse } from "../services/result-visual.service";
import { deserializeResultProfile } from "../services/result-engine.service";
import { buildReportViewModel } from "../services/html-report-renderer.service";
import { buildResponsiveReportHtml, type ResponsiveReportMeta } from "../services/report/web";
import { REPORT_TEMPLATES } from "../services/report/template";
import { resolveReportTemplate } from "../services/report/template-resolver";
import { verifyReportAccessToken } from "../services/report-access-token.service";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { loadSystemSettings } from "../services/system-settings.service";
import { defaultParticipantReportTemplate } from "../services/participant-report.service";
import {
  assembleReportImages,
  collectReportImageEntries,
  mapWithConcurrency,
  reportImageAssetId,
  resolveReportImageToDataUrl,
  type ReportImagesEnv,
} from "../services/report/report-images.service";
import type { ResultProfileSnapshot } from "../result/schema";

function fail(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Keeps a report with many legacy/remote images from flooding subrequests. */
const REPORT_IMAGE_RESOLVE_CONCURRENCY = 4;

export async function handleReportRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
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

/**
 * Builds the image map the web report renders from.
 *
 * Stored assets become `/api/report/media/:id` links (cacheable, lazily
 * loaded, served through the report's own access token). Anything else a
 * report can reference — an inlined data URL, an editor-entered image URL, a
 * legacy Telegram file id — is resolved server-side into a data URL, which is
 * exactly the set the PDF/archive renderer keeps. Previously this map only
 * understood `{ mediaAssetId }` and ignored `metadata.gallery`, so uploaded
 * photos beyond the first one of each question, and every configured result
 * image, were missing from the preview while still present in the PDF.
 */
async function buildReportImageSources(
  env: ReportImagesEnv,
  profile: ResultProfileSnapshot,
  token: string | null,
  responseId: number,
): Promise<Record<string, string>> {
  const entries = collectReportImageEntries(profile);
  const encodedToken = encodeURIComponent(token ?? "");
  const resolved = await mapWithConcurrency(entries, REPORT_IMAGE_RESOLVE_CONCURRENCY, async (entry) => {
    const mediaAssetId = reportImageAssetId(entry.value);
    if (mediaAssetId !== null) {
      return `/api/report/media/${mediaAssetId}?t=${encodedToken}&rid=${responseId}`;
    }
    return resolveReportImageToDataUrl(env, entry.value);
  });
  return assembleReportImages(entries, resolved);
}

async function serveReportPage(env: Env, url: URL, responseId: number): Promise<Response> {
  const token = url.searchParams.get("t");
  const valid = await verifyReportAccessToken(env.WEBHOOK_SECRET, responseId, token);
  if (!valid) {
    return fail(403, "invalid_report_token", "报告链接无效或已过期");
  }

  const response = await env.DB.prepare(
    `SELECT id, survey_id surveyId, status, completed_at completedAt
       FROM survey_responses WHERE id = ? LIMIT 1`,
  )
    .bind(responseId)
    .first<{ id: number; surveyId: number; status: string; completedAt: string | null }>();
  if (!response || response.status !== "completed") {
    return fail(404, "report_unavailable", "报告不存在或尚未生成");
  }

  const survey = await getSurveyById(env.DB, response.surveyId);
  // Rebuild on access so older snapshots also include uploaded media answers.
  const prepared = await prepareResultProfileForResponse(env.DB, responseId, { forceRecalculate: true });
  if (!prepared) {
    return fail(404, "report_unavailable", "报告不存在或尚未生成");
  }
  const snapshot = deserializeResultProfile(prepared.profile);
  const images = await buildReportImageSources(env, snapshot, token, responseId);

  const viewModel = buildReportViewModel(snapshot, images);
  const systemSettings = await loadSystemSettings(env.DB);
  const defaultTemplate = systemSettings.defaultReportTemplate;
  const requestedTemplateId = url.searchParams.get("template");
  const templateId =
    requestedTemplateId ??
    survey?.reportTemplateId ??
    defaultParticipantReportTemplate(snapshot.metadata.reportKind, snapshot.resultType) ??
    defaultTemplate ??
    "";
  const template = await resolveReportTemplate(env.DB, templateId);
  const meta: ResponsiveReportMeta = {
    reportId: `#${responseId}`,
  };
  if (survey?.title) meta.surveyTitle = survey.title;
  if (response.completedAt) meta.completedAt = response.completedAt;
  meta.watermark = systemSettings.reportWatermark;
  const html = buildResponsiveReportHtml(viewModel, meta, template);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}

async function serveReportMedia(env: Env, url: URL, mediaId: number): Promise<Response> {
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
    const owned = await env.DB.prepare(
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
    const linked = await env.DB.prepare(
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
  } else if (asset.scope === "gallery_profile") {
    const linked = await env.DB.prepare(
      `SELECT 1 FROM gallery_profile_media WHERE media_asset_id = ? AND response_id = ? LIMIT 1`,
    )
      .bind(mediaId, responseId)
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
