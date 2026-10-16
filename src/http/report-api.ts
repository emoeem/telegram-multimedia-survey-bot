import type { Env } from "../index";
import { getSurveyById } from "../db/repositories/survey.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { prepareResultProfileForResponse } from "../services/result-visual.service";
import { deserializeResultProfile } from "../services/result-engine.service";
import { buildReportViewModel } from "../services/html-report-renderer.service";
import { buildResponsiveReportHtml, injectReportDownloadAction, type ResponsiveReportMeta } from "../services/report/web";
import { renderReportPdf } from "../services/report/pdf";
import { REPORT_TEMPLATES } from "../services/report/template";
import { resolveReportTemplate } from "../services/report/template-resolver";
import { verifyReportAccessToken } from "../services/report-access-token.service";
import {
  atomicRateLimitWindow,
  buildAtomicRateLimitStatement,
  checkRateLimit,
  readAtomicRateLimitCountFromBatch,
} from "../services/rate-limit.service";
import { verifyTelegramWebAppProfile } from "./admin-api";
import { verifySurveyParticipantToken } from "../services/participant-session.service";
import { verifyEmailSessionToken } from "../services/email-auth.service";
import { participantHashForKey } from "../db/repositories/participant-link.repository";
import { resolveClientIdentity } from "../services/client-identity.service";
import { ANONYMOUS_KEY_PATTERN } from "./survey/participant";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { loadSystemSettings } from "../services/system-settings.service";
import { defaultParticipantReportTemplate } from "../services/participant-report.service";
import {
  assembleReportImages,
  collectReportImageEntries,
  mapWithConcurrency,
  reportImageAssetId,
  resolveReportImageToDataUrl,
  resolveReportProfileImages,
  type ReportImagesEnv,
} from "../services/report/report-images.service";
import type { ResultProfileSnapshot } from "../result/schema";

function fail(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Minimal attribute-safe escaping for the two places this file embeds URLs in HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

  const pdfMatch = url.pathname.match(/^\/report\/(\d+)\.pdf$/);
  if (pdfMatch) {
    return serveReportPdf(request, env, url, Number(pdfMatch[1]));
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

/**
 * 报告 PDF 的自助下载上限：**每个身份每天 3 次**，另有 **每个 IP 每天 12 次**的
 * 后备闸门。
 *
 * 下载本身很便宜（命中归档缓存时 ≈1 次 KV 读），但被脚本刷起来就不是了：缓存未命中
 * 会触发浏览器渲染，命中也要吃 KV 读与 D1 行读——运营明确要求防刷单。主体优先用
 * 身份（同一出口下的多个用户不互相连坐，与 /answers 的取舍一致），但匿名身份的
 * 凭据可以轮换，所以后备 IP 闸门把「轮换凭据」的放大倍数封在 4 倍以内。两道闸门在
 * 同一次 db.batch 里计数：1 个往返、最多 2 行写。
 */
const REPORT_PDF_DAILY_LIMIT = 3;
const REPORT_PDF_DAILY_IP_LIMIT = 12;
const REPORT_PDF_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * 限流主体：优先用请求自带的身份（纯 CPU 校验，**不查库**——报告端点不做参与者解析，
 * 不能把刚省下来的往返又加回去），没有身份才回落到 IP。
 */
async function resolveDownloadSubject(request: Request, env: Env): Promise<string> {
  const initData = request.headers.get("x-telegram-init-data");
  if (initData) {
    const profile = await verifyTelegramWebAppProfile(request, env.BOT_TOKEN).catch(() => null);
    if (profile && profile.telegramUserId > 0) return `tg_${profile.telegramUserId}`;
  }
  const participantToken = request.headers.get("x-participant-token");
  if (participantToken) {
    const profile = await verifySurveyParticipantToken(env.WEBHOOK_SECRET, participantToken).catch(() => null);
    if (profile && profile.telegramUserId > 0) return `tg_${profile.telegramUserId}`;
  }
  const emailSession = request.headers.get("x-email-session");
  if (emailSession) {
    const parsed = await verifyEmailSessionToken(env.WEBHOOK_SECRET, emailSession).catch(() => null);
    if (parsed) return `email_${parsed.accountId}`;
  }
  const participantKey = request.headers.get("x-participant-key");
  if (participantKey && ANONYMOUS_KEY_PATTERN.test(participantKey)) {
    return participantHashForKey(participantKey);
  }
  return resolveClientIdentity(request, env).ip;
}

/** 超限时的落地页：说明限额并给出「在线查看」的去处（这是浏览器导航，不是 API）。 */
function downloadLimitResponse(retryAfterSeconds: number, reportUrl: string): Response {
  const hours = Math.max(1, Math.ceil(retryAfterSeconds / 3600));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>下载次数已用完</title></head><body style="margin:0;display:grid;min-height:100vh;place-items:center;background:#0f172a;color:#e2e8f0;font:15px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif"><main style="max-width:22rem;padding:0 1.5rem;text-align:center"><h1 style="font-size:1.2rem;margin:0 0 .6rem">今日的 PDF 下载次数已用完</h1><p style="margin:0 0 1.4rem;color:#94a3b8">每人每天最多下载 ${REPORT_PDF_DAILY_LIMIT} 次，约 ${hours} 小时后恢复。报告现在仍可以在线查看。</p><a href="${escapeHtml(reportUrl)}" style="display:inline-block;padding:.75rem 1.6rem;border-radius:999px;background:#6366f1;color:#fff;text-decoration:none;font-weight:600">在线查看报告</a></main></body></html>`;
  return new Response(html, {
    status: 429,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/**
 * 参与者下载自己的报告（PDF）。
 *
 * 归档队列处理每份答卷时会把渲染好的 PDF 顺手放进 KV
 * （`public-report-pdf:<id>`，7 天），下载接口优先复用它——绝大多数请求零浏览器
 * 开销；缓存过期或归档失败时按需渲染一次并把结果写回同一个键，所以同一份报告
 * 7 天内最多渲染一次（浏览器会话是这里最贵的资源，不能让它跟着点击次数走）。
 * 每日限额见 {@link REPORT_PDF_DAILY_LIMIT}。
 *
 * 没有 BROWSER 绑定的部署形态（本地开发）或渲染失败时回退到 HTML 报告页：
 * 「下载」按钮在任何情况下都有去处，而不是丢一个 500。
 */
async function serveReportPdf(request: Request, env: Env, url: URL, responseId: number): Promise<Response> {
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
  if (!response || (response.status !== "completed" && response.status !== "archived")) {
    return fail(404, "report_unavailable", "报告不存在或尚未生成");
  }

  const reportPageUrl = (() => {
    const target = new URL(`/report/${responseId}`, url.origin);
    if (token) target.searchParams.set("t", token);
    return target.toString();
  })();

  // 限额在令牌与归属校验之后：无效请求不消耗限流行。D1 不可用时回落到 KV 限流器
  // （与其它公开端点同一套降级策略），KV 也失败就放行——限流器坏了不该拦住用户
  // 下载自己的报告。
  const subject = await resolveDownloadSubject(request, env);
  const ip = resolveClientIdentity(request, env).ip;
  const limitNow = Date.now();
  let allowed = true;
  let retryAfterSeconds = REPORT_PDF_LIMIT_WINDOW_SECONDS;
  try {
    const [subjectResult, ipResult] = await env.DB.batch([
      buildAtomicRateLimitStatement(env.DB, "report-pdf-download", subject, REPORT_PDF_LIMIT_WINDOW_SECONDS, limitNow),
      buildAtomicRateLimitStatement(env.DB, "report-pdf-download-ip", ip, REPORT_PDF_LIMIT_WINDOW_SECONDS, limitNow),
    ]);
    allowed =
      readAtomicRateLimitCountFromBatch(subjectResult) <= REPORT_PDF_DAILY_LIMIT &&
      readAtomicRateLimitCountFromBatch(ipResult) <= REPORT_PDF_DAILY_IP_LIMIT;
    retryAfterSeconds = atomicRateLimitWindow(
      "report-pdf-download",
      subject,
      REPORT_PDF_LIMIT_WINDOW_SECONDS,
      limitNow,
    ).retryAfterSeconds;
  } catch (error) {
    console.warn("Report PDF rate limit unavailable; falling back to KV", { responseId, error });
    const fallback = await checkRateLimit(
      env.CACHE,
      "report-pdf-download",
      subject,
      REPORT_PDF_DAILY_LIMIT,
      REPORT_PDF_LIMIT_WINDOW_SECONDS,
    ).catch(() => ({ allowed: true, retryAfterSeconds: REPORT_PDF_LIMIT_WINDOW_SECONDS }));
    allowed = fallback.allowed;
    retryAfterSeconds = fallback.retryAfterSeconds;
  }
  if (!allowed) {
    return downloadLimitResponse(retryAfterSeconds, reportPageUrl);
  }

  const pdfCacheKey = `public-report-pdf:${responseId}`;
  const attachment = (bytes: ArrayBuffer | Uint8Array): Response =>
    new Response(bytes as ArrayBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="report-${responseId}.pdf"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });

  try {
    const cached = await env.MEDIA_KV.get(pdfCacheKey, { type: "arrayBuffer" });
    if (cached) return attachment(cached);
  } catch (error) {
    console.warn("Report PDF cache read failed", { responseId, error });
  }

  const htmlFallback = (): Response => Response.redirect(reportPageUrl, 302);

  if (!env.BROWSER) return htmlFallback();
  try {
    const prepared = await prepareResultProfileForResponse(env.DB, responseId, { forceRecalculate: true });
    if (!prepared) return fail(404, "report_unavailable", "报告不存在或尚未生成");
    const snapshot = deserializeResultProfile(prepared.profile);
    const images = await resolveReportProfileImages(env, snapshot);
    const survey = await getSurveyById(env.DB, response.surveyId);
    const settings = await loadSystemSettings(env.DB);
    // PDF 与网页报告走同一条默认链：作者绑定 > 按报告种类默认（经典报告）> 系统默认。
    const template = await resolveReportTemplate(
      env.DB,
      survey?.reportTemplateId ??
        defaultParticipantReportTemplate(snapshot.metadata.reportKind, snapshot.resultType) ??
        settings.defaultReportTemplate,
    );
    const meta: ResponsiveReportMeta = {
      reportId: `#${responseId}`,
      completedAt: response.completedAt ?? "",
      watermark: settings.reportWatermark,
    };
    if (survey?.title) meta.surveyTitle = survey.title;
    const pdf = await renderReportPdf(env.BROWSER, snapshot, images, meta, {}, template);
    try {
      await env.MEDIA_KV.put(pdfCacheKey, pdf.bytes, { expirationTtl: 7 * 24 * 3600 });
    } catch (error) {
      // 缓存写失败不影响本次下载。
      console.warn("Report PDF cache write failed", { responseId, error });
    }
    return attachment(pdf.bytes);
  } catch (error) {
    console.error("Report PDF render failed", { responseId, error });
    return htmlFallback();
  }
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
  const reportHtml = buildResponsiveReportHtml(viewModel, meta, template);
  // 「下载 PDF」按钮只注入到参与者打开的网页报告：同一个 builder 还负责 PDF
  // 渲染、归档副本、模板预览与视觉快照，交互控件绝不能出现在那些产物里。
  const html = token ? injectReportDownloadAction(reportHtml, `/report/${responseId}.pdf?t=${encodeURIComponent(token)}`) : reportHtml;
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
