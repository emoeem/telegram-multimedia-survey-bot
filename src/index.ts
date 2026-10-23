import { SurveyBuilderDO } from "./durable-objects/survey-builder";
import { SurveySessionDO } from "./durable-objects/survey-session";
import { RateLimitDO } from "./durable-objects/rate-limit";
import { UiSessionDO } from "./durable-objects/ui-session";
import { handleTelegramUpdate } from "./bot/router";
import { isTelegramUpdateHandledError } from "./bot/router";
import { syncDefaultBotCommands } from "./bot/telegram";
import { answerCallbackQuery, getWebhookInfo, setWebhook } from "./bot/telegram";
import { describePublicDatabaseError, isDatabaseCapacityError, isKeyValueCapacityError } from "./db/errors";
import type { BotContext } from "./bot/types";
import { parseTelegramUpdate } from "./bot/update-parser";
import { isWebhookSecretValid } from "./core/security";
import { CERT_PAGE_REDIRECT_LOCATION, certPageRoute } from "./http/cert-page";
import { CERT_SHARE_PATH, handleCertShare } from "./http/cert-share";
import { handleSubmissionBotProxy, isSubmissionBotApiPath } from "./http/submission-proxy";
import {
  escapeMetaAttribute,
  homeRedirectLocation,
  publicPageHead,
  submitPageMetaPath,
} from "./http/public-page";
import { handleInternalRenderRequest } from "./http/internal-render";
import { createExportJobSender } from "./services/export-job-dispatch.service";
import { handleLicenseApiRequest } from "./http/license-api";
import { handleRemoteApiRequest } from "./http/remote-api";
import { handleControlApiRequest } from "./http/control-api";
import { sendCustomerHeartbeat } from "./services/customer-control.service";
import { handleAdminApi } from "./http/admin-api";
import { CERT_CONTENT_SETTING_KEY } from "./http/admin/cert-content";
import { getSystemSetting } from "./db/repositories/system-settings.repository";
import { handleSurveyApiRequest } from "./http/survey-api";
import { handlePlazaApiRequest } from "./http/plaza-api";
import { handleMeApiRequest } from "./http/me-api";
import { handleCoinApiRequest } from "./http/coin-api";
import { handleShowcaseApiRequest } from "./http/showcase-api";
import { handleTrialApiRequest } from "./http/trial-api";
import { handleEmailAuthApiRequest } from "./http/email-auth-api";
import { handleReportRequest } from "./http/report-api";
import { handleSharePageRequest } from "./http/share-api";
import { handleSeriesApiRequest } from "./http/series-api";
import { runSeriesUpdateNotification } from "./services/series-follow.service";
import { checkDeploymentLicense } from "./services/license-client.service";
import { isLicenseCenter } from "./services/deployment-role.service";
import { handleExportQueue } from "./services/export-worker.service";
import { sendCreatorTrialExpiryReminders } from "./services/creator-trial-reminder.service";
import { runDatabaseMaintenance } from "./services/database-maintenance.service";
import { cleanupExpiredTemporaryMedia, retainFinishedResponseMedia } from "./services/media/temporary-media.service";
import { createMediaStore } from "./services/media/temporary-media-store";
import { sweepStaleStreamUploads } from "./services/media/stream.service";
import { migrateDataUrlCoversToKv } from "./services/cover-storage.service";
import { loadSurveyShareMeta, getSurveyOgImage } from "./services/survey-og-image.service";
import { resolveSubmissionBotUrl } from "./services/contact-links.service";
import { resolvePublicOrigin } from "./services/public-origin.service";
import { resolveClientIdentity } from "./services/client-identity.service";
import { recoverStaleResultVisualJobs } from "./services/result-visual-job-recovery.service";
import { recoverStaleImageGeneratorJobs } from "./services/image-generator-job-recovery.service";
import { retryPendingReportDeliveries } from "./services/report-delivery.service";
import { loadWeeklyDigest, renderWeeklyDigestMessage } from "./services/weekly-digest.service";
import { loadSystemSettings } from "./services/system-settings.service";
import { sendMessage } from "./bot/telegram";
import { createUpdateDedupStore } from "./services/update-dedup.service";
import { createPreferredRateLimiter } from "./services/rate-limit.service";
import { withQueueMetrics, withRequestMetrics } from "./observability/metrics";
export { RESULT_VISUAL_WASM } from "./services/result-visual-wasm";
import type { BrowserWorker } from "@cloudflare/puppeteer";

/**
 * Serves an SPA HTML entry without allowing the client or any intermediate
 * cache to keep a stale copy: stale bundles have historically left Telegram
 * WebViews stuck on a blank page after a redeploy.
 */
async function serveHtmlAsset(
  env: Env,
  request: Request,
  assetPath: string,
  injectHead?: string,
  title?: string,
): Promise<Response> {
  const assetUrl = new URL(assetPath, request.url);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!response.headers.get("content-type")?.includes("text/html")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (!injectHead) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  let html = await response.text();
  /* 每个公开页有自己的标题（分享卡片、浏览器标签都要它）。index.html 里那份
   * 是通用的「问卷」，这里直接替换而不是追加第二份 <title>。 */
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  html = html.replace("</head>", `${injectHead}\n</head>`);
  return new Response(html, { status: response.status, headers });
}

/**
 * Content-hashed build output under `/assets/`, as Vite names it
 * (`survey-CM53e1qv.js`): the hash *is* the file's content, so the bytes behind
 * a given URL never change.
 */
const HASHED_ASSET_PATTERN = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

/**
 * Serves a static build asset, with a long cache lifetime for hashed files.
 *
 * The assets binding answers with `cache-control: public, max-age=0,
 * must-revalidate` for everything, so a returning visitor revalidates every
 * chunk — ten round trips before the survey app boots, each of which is
 * hundreds of milliseconds from a mainland mobile link, and any one of them
 * failing leaves the participant on a blank page. A hashed filename cannot go
 * stale, so it is served as immutable instead; unhashed paths (`sw.js`,
 * `manifest.webmanifest`, the icons) deliberately keep the binding's policy so
 * they still update.
 */
async function serveStaticAsset(env: Env, request: Request): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const pathname = new URL(request.url).pathname;
  if (!response.ok || !pathname.startsWith("/assets/") || !HASHED_ASSET_PATTERN.test(pathname)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Injects Open Graph / Twitter meta tags into the public survey page so
 * shares on Telegram and social platforms render a preview card. Failures
 * are non-fatal: the stock page is served without meta tags.
 */
export { escapeMetaAttribute };

/** SPA 公开页（/s、/plaza、/submit、/me …）：资源是 /survey.html，由前端按路径切屏。 */
function servePublicPageWithMeta(env: Env, request: Request, pathname: string): Promise<Response> {
  return serveHtmlAssetWithMeta(env, request, "/survey.html", pathname);
}

/** 独立静态页也要同一套 head 注入。
 *
 * 认证卡生成器（/cert）是 `cert/index.html` 单独一份静态页，不走 SPA；原先
 * 直接 `serveHtmlAsset` 发出去，于是它**没有 canonical、没有 og:url** ——
 * 从国内域名分享出去是一条光秃秃的链接，搜索引擎也会把 Cloudflare 那个
 * 打不开的域名当主域。这里复用的就是 SPA 那几页的 `publicPageHead`，
 * 两边的 canonical 来源完全一致（PUBLIC_ORIGIN → emoemok.top）。 */
function serveHtmlAssetWithMeta(
  env: Env,
  request: Request,
  assetPath: string,
  pathname: string,
): Promise<Response> {
  const origin = resolvePublicOrigin(env, new URL(request.url).origin);
  const { title, injectHead } = publicPageHead(origin, pathname);
  return serveHtmlAsset(env, request, assetPath, injectHead, title);
}

/**
 * 连载召回内部端点：只接受 SELF binding 的 HMAC 签名请求。常数时间比较，
 * 验签失败一律 404（不暴露端点存在性）。
 */
async function handleInternalSeriesNotify(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.WEBHOOK_SECRET ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const provided = request.headers.get("x-notify-signature") ?? "";
  const a = encoder.encode(expected);
  const b = encoder.encode(provided);
  const mismatch = a.length !== b.length || [...a].some((byte, index) => byte !== b[index]);
  if (!provided || mismatch) return new Response(null, { status: 404 });
  let payload: { seriesId?: unknown; surveyId?: unknown; chapterTitle?: unknown };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return new Response(null, { status: 404 });
  }
  const seriesId = Number(payload.seriesId);
  const surveyId = Number(payload.surveyId);
  const chapterTitle = typeof payload.chapterTitle === "string" ? payload.chapterTitle.slice(0, 200) : "";
  if (!Number.isInteger(seriesId) || !Number.isInteger(surveyId) || !chapterTitle) {
    return new Response(null, { status: 404 });
  }
  const titleRow = await env.DB.prepare("SELECT title FROM survey_series WHERE id = ? LIMIT 1").bind(seriesId).first<{
    title: string;
  }>();
  if (!titleRow) return Response.json({ ok: true, notified: 0, pushed: 0 });
  const result = await runSeriesUpdateNotification(env, {
    seriesId,
    seriesTitle: titleRow.title,
    surveyId,
    chapterTitle,
  });
  return Response.json({ ok: true, ...result });
}

async function serveSurveyPageWithShareMeta(env: Env, request: Request, surveyId: number): Promise<Response> {
  let injectHead: string | undefined;
  try {
    const meta = await loadSurveyShareMeta(env.DB, surveyId);
    if (meta) {
      const origin = resolvePublicOrigin(env, new URL(request.url).origin);
      const ogImage = `${origin}/s/${surveyId}/og.png`;
      // r18 卷的 unfurl 文案同样走安全描述：描述本身可能就是限制级内容。
      const description =
        meta.contentRating === "r18"
          ? "该内容为 18+ 内容，确认年龄后即可填写"
          : meta.description?.slice(0, 120) || `${meta.questionCount} 道题，点击立即填写`;
      injectHead = [
        `<meta property="og:type" content="website" />`,
        `<meta property="og:title" content="${escapeMetaAttribute(meta.title)}" />`,
        `<meta property="og:description" content="${escapeMetaAttribute(description)}" />`,
        `<meta property="og:image" content="${ogImage}" />`,
        `<meta property="og:url" content="${origin}/s/${surveyId}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeMetaAttribute(meta.title)}" />`,
        `<meta name="twitter:description" content="${escapeMetaAttribute(description)}" />`,
        `<meta name="twitter:image" content="${ogImage}" />`,
      ].join("\n    ");
    }
  } catch (error) {
    console.warn("Survey share meta injection failed", error);
  }
  return serveHtmlAsset(env, request, "/survey.html", injectHead);
}

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  /** Queues 是 Workers Paid 能力；无队列部署经 createExportJobSender 降级。 */
  EXPORT_QUEUE?: Queue;
  SESSION: DurableObjectNamespace<SurveySessionDO>;
  UI: DurableObjectNamespace<UiSessionDO>;
  /** Atomic rate limiting. Optional so customer deployments without the
   *  binding still boot; without it the KV limiter is used. */
  RATE_LIMIT?: DurableObjectNamespace<RateLimitDO>;
  BUILDER: DurableObjectNamespace<SurveyBuilderDO>;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS: string;
  ENVIRONMENT: "development" | "staging" | "production";
  /** Local-dev only: enables the x-telegram-user-id admin login shortcut when
   *  ENVIRONMENT=development and the request presents this shared secret. */
  ADMIN_DEV_AUTH_SECRET?: string;
  /** Independent HMAC key for browser admin sessions; falls back to WEBHOOK_SECRET for old deployments. */
  ADMIN_SESSION_SECRET?: string;
  APP_VERSION?: string;
  /**
   * Canonical origin for every user-facing absolute URL (Telegram buttons, the
   * admin login deep link, `og:` metadata). A Worker answers on its
   * `*.workers.dev` hostname and every bound custom domain at once, and the
   * Telegram webhook deliberately keeps arriving on `workers.dev` so bot
   * delivery never depends on a custom domain's DNS state — which means links
   * built from `request.url` would keep handing users the SNI-blocked
   * hostname. Unset falls back to the request origin, so `wrangler dev` and
   * single-hostname deployments are unaffected.
   */
  PUBLIC_ORIGIN?: string;
  LICENSE_ENFORCEMENT?: "disabled" | "required";
  LICENSE_SERVER_URL?: string;
  /**
   * Service binding to the authorization center. Needed whenever this instance
   * shares the center's Cloudflare account: a Worker cannot `fetch()` another
   * Worker in the same account over `*.workers.dev` (edge error 1042 → 404).
   */
  LICENSE_CENTER?: Fetcher;
  LICENSE_KEY?: string;
  LICENSE_ADMIN_TOKEN?: string;
  INSTALLATION_ID?: string;
  LICENSE_GRACE_SECONDS?: string;
  CONTROL_PLANE_RUNNER_TOKEN?: string;
  /**
   * Shared with the authorization center. The center signs short-lived read
   * tokens with it; this instance verifies them on `/api/remote/*`, which the
   * vendor console's browser calls directly (a Worker cannot reach another
   * Worker in the same account — edge error 1042).
   */
  REMOTE_ACCESS_SECRET?: string;
  /**
   * Origins allowed to read `/api/remote/*` (comma separated). Unset trusts only
   * the authorization center's own address; a console reached on any other
   * domain must be listed, because CORS matches the page's origin. See
   * `src/http/remote-api.ts`.
   */
  REMOTE_ACCESS_ORIGINS?: string;
  /** Shared secret used only to encrypt deployment task credentials at rest. */
  CONTROL_PLANE_RUNNER_SECRET?: string;
  WORKER_NAME?: string;
  WORKER_URL?: string;
  /** "vendor" = authorization center, "customer" = licensed instance. Unset
   *  falls back to LICENSE_ADMIN_TOKEN presence (legacy deployments). */
  DEPLOYMENT_ROLE?: "vendor" | "customer";
  /** Browser Rendering 需要 Workers Paid；未绑定时报告/分享图走既有降级路径。 */
  BROWSER?: BrowserWorker;
  ASSETS: Fetcher;
  TARGET_CHAT_ID?: string;
  TOPIC_ID?: string;
  PUBLICATION_TARGET_CHAT_ID?: string;
  PUBLICATION_TARGET_THREAD_ID?: string;
  /**
   * Shared secret the mainland-China relay presents in `x-relay-token` (see
   * `cn-relay/` and docs/CN_ACCESS_VERCEL_RELAY.md, `wrangler secret put
   * RELAY_SECRET`). While it matches, the visitor identity headers that relay
   * forwards are trusted for rate limits and geo, so domestic visitors do not
   * share one rate-limit bucket. Unset = every request keeps being judged by
   * the peer address, exactly as before.
   */
  RELAY_SECRET?: string;
  /** Optional R2 bucket; media storage falls back to MEDIA_KV when unset. */
  MEDIA?: R2Bucket;
  MEDIA_KV: KVNamespace;
  REPORT_CHANNEL_ID?: string;
  /**
   * 认证卡生成器「完成制作」时同步原图与成品的目标频道。
   * 留空则回落到 REPORT_CHANNEL_ID；两者都空 = 功能关闭。
   * 客户部署（DEPLOYMENT_ROLE = "customer"）必须留空，见 src/http/cert-share.ts。
   */
  CERT_SHARE_CHANNEL?: string;
  /** 置 "true" 时无条件停用认证卡同步，优先级高于任何频道配置。 */
  CERT_SHARE_DISABLED?: string;
  /**
   * Self service binding: queue consumers re-enter this worker through it so
   * browser renders happen in a request context (they die in queue contexts
   * on constrained accounts). Optional; renders fall back to in-process.
   */
  SELF?: Fetcher;
  /** Telegram channel that mirrors published plaza cards and tree-hole posts. */
  PLAZA_CHANNEL_ID?: string;
  COMMUNITY_GROUP_URL?: string;
  /** Public link for the submission bot (投稿机器人); defaults to @tougaojiqirbot. */
  SUBMISSION_BOT_URL?: string;
  /**
   * Origin of the standalone submission-bot Worker that serves `/api/submit/*`
   * (the no-login submission form: form definition, inbox, replies).
   *
   * Set this so the endpoints exist on this Worker's own domain too. Before it
   * was set, they only existed behind the CN relay (`cn-relay/vercel.json`
   * forwards `/api/submit/*` there), which meant the no-login tab worked on
   * emoemok.top and silently fell back to the SPA HTML on emoe.eu.cc.
   */
  SUBMISSION_BOT_API_ORIGIN?: string;
  /**
   * Shared secret for the submission bot's admin review API (`/api/admin/review/*`).
   *
   * Must match `REVIEW_API_SECRET` on that Worker. It exists so the browser never
   * holds it: this Worker verifies the admin session first, then forwards the
   * secret. Empty = the review endpoints refuse with 503 instead of running
   * unauthenticated (see src/http/admin/web-submission.ts).
   */
  WEB_REVIEW_SECRET?: string;
  /** Transactional email (Resend) for email+password auth. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  /** Pepper used only for new salted survey access-code hashes. */
  SURVEY_CODE_PEPPER?: string;
  /**
   * 部署档位显式声明（docs/CLOUDFLARE_PLAN_TIERS.md 原则一）。与绑定探测结果
   * 取更保守的一档；不声明则完全由绑定推导（见 services/plan.service.ts）。
   */
  PLAN_TIER?: string;
  /** Cloudflare Stream 视频直传（两项齐备才启用，见 plan.service.ts）。 */
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  /**
   * Stream 硬停用开关（`"true"` = 关闭）。优先级高于上面两项配置：即使 token
   * 齐备也不铸造直传凭证。停用原因是计费——Stream 是本部署唯一按分钟线性
   * 计费的资源，见 wrangler.toml 的同名注释。
   */
  STREAM_DISABLED?: string;
  /** Cloudflare Images 图片存储与边缘变换（三项齐备才启用）。 */
  IMAGES_ACCOUNT_ID?: string;
  IMAGES_DELIVERY_HASH?: string;
  /** Cloudflare API Token：Images（后续 Stream 管理操作）用的账号级凭据。 */
  CLOUDFLARE_API_TOKEN?: string;
}

export { SurveySessionDO, SurveyBuilderDO, UiSessionDO, RateLimitDO };

const commandMenuCacheKey = "telegram-command-menu:v2";
const webhookConfigCacheKey = "telegram-webhook-config:v2";

function parseAdminIds(value: string): number[] {
  return value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * A maintenance run that stops at its read budget means the account's daily D1
 * quota is at risk again — the failure mode that took the bot and every survey
 * down for a full day on 2026-09-14. The admins should hear it from the bot
 * rather than from users.
 */
async function notifyMaintenanceBudgetExhausted(env: Env, rowsRead: number): Promise<void> {
  try {
    const message =
      `⚠️ 数据库维护任务读取了 ${rowsRead.toLocaleString("en-US")} 行，已提前停止本次清理。\n` +
      `常见原因是新加的清理查询缺少索引。请先确认再让它继续跑，避免再次耗尽当天 D1 额度。`;
    await Promise.all(parseAdminIds(env.ADMIN_IDS).map((chatId) => sendMessage(env.BOT_TOKEN, chatId, message)));
  } catch (error) {
    console.warn("Maintenance budget notice failed", error);
  }
}

/**
 * Single boundary for the public JSON APIs.
 *
 * An unhandled throw used to leave the Worker's own 500 page in the body, which
 * the survey/trial/plaza SPAs can only render as a bare "请求失败" — that is how
 * the 2026-09-14 quota exhaustion looked like a broken survey to users. Every
 * API failure now returns JSON the client can explain, with 503 for a database
 * capacity problem so retrying clients back off differently than on a bug.
 */
async function applyPublicApiRateLimit(request: Request, env: Env, url: URL): Promise<Response | null> {
  const limiter = createPreferredRateLimiter(env);
  const clientIp = resolveClientIdentity(request, env).ip;

  if (request.method === "POST" && url.pathname.startsWith("/api/auth/email/")) {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email) {
      let scope = url.pathname.slice("/api/auth/email/".length);
      if (scope === "request-code") scope = body?.purpose === "reset" ? "reset" : "register";
      if (scope === "register" || scope === "login" || scope === "reset") {
        const [perEmail, perIp] = await Promise.all([
          limiter.allow(`${scope}|${email}`, 5, 3600),
          limiter.allow(`email-auth-ip|${clientIp}`, 20, 3600),
        ]);
        if (!perEmail || !perIp) {
          return Response.json(
            { ok: false, code: "rate_limited", message: "请求过于频繁，请稍后再试" },
            { status: 429, headers: { "Cache-Control": "no-store" } },
          );
        }
      }
    }
  }

  // Answer saves are damped inside their own handler instead
  // (src/http/survey/handler.ts): its limiter is a row in the same D1 batch as
  // the response read, which keeps the endpoint free of a KV round trip on the
  // one interaction a respondent repeats for every question.

  return null;
}

async function guardApiResponse(
  request: Request,
  env: Env,
  url: URL,
  run: () => Promise<Response | null>,
): Promise<Response> {
  try {
    const rateLimitResponse = await applyPublicApiRateLimit(request, env, url);
    if (rateLimitResponse) return rateLimitResponse;
    // Same JSON error shape as every other API failure: the SPAs parse a body
    // and fall back to a bare "请求失败（HTTP 404）" for anything else.
    return (
      (await run()) ??
      Response.json(
        { ok: false, code: "not_found", message: "接口不存在" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      )
    );
  } catch (error) {
    console.error("API request failed", error);
    return Response.json(
      {
        ok: false,
        code: isDatabaseCapacityError(error)
          ? "database_capacity"
          : isKeyValueCapacityError(error)
            ? "kv_capacity"
            : "internal_error",
        message: describePublicDatabaseError(error),
      },
      {
        // 两种容量错误都是"等一会儿/改天再来"，不是服务端 bug，用 503 让
        // 前端和监控都按可重试对待；其余仍是 500。
        status: isDatabaseCapacityError(error) || isKeyValueCapacityError(error) ? 503 : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

async function ensureTelegramCommandMenu(env: Env): Promise<void> {
  try {
    if (await env.CACHE.get(commandMenuCacheKey)) return;
    await syncDefaultBotCommands(env.BOT_TOKEN);
    await env.CACHE.put(commandMenuCacheKey, "synced", { expirationTtl: 24 * 3600 });
  } catch (error) {
    console.warn("Telegram command menu sync failed", error);
  }
}

/**
 * channel_post updates are required for automatic report-channel detection.
 * Self-heals the webhook allowed_updates whenever a request reaches the bot.
 */
async function ensureWebhookAllowsChannelPosts(env: Env, origin: string): Promise<void> {
  try {
    if (await env.CACHE.get(webhookConfigCacheKey)) return;
    const info = await getWebhookInfo(env.BOT_TOKEN);
    const updates = info.allowed_updates ?? [];
    if (info.url === `${origin}/telegram/webhook` && updates.includes("channel_post")) {
      await env.CACHE.put(webhookConfigCacheKey, "ok", { expirationTtl: 7 * 24 * 60 * 60 });
      return;
    }
    await setWebhook(env.BOT_TOKEN, `${origin}/telegram/webhook`, env.WEBHOOK_SECRET);
    await env.CACHE.put(webhookConfigCacheKey, "ok", { expirationTtl: 7 * 24 * 60 * 60 });
    console.info("Telegram webhook updated to include channel_post updates");
  } catch (error) {
    console.warn("Telegram webhook self-heal failed", error);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    // One structured metrics line per request (route/duration/status plus the
    // D1 rows read and KV/queue/Telegram call counts). Instrumented bindings
    // also make the request's own D1 query budget visible in production.
    return withRequestMetrics(request, env, async (env, metrics) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({
          ok: true,
          environment: env.ENVIRONMENT,
          version: env.APP_VERSION ?? "unknown",
          licenseEnforcement: env.LICENSE_ENFORCEMENT ?? "disabled",
        });
      }

      // 裸域名：后台 SPA 的 basename 是 /admin，React Router 匹配不到 "/"，
      // 直接发 index.html 就是一张纯白页。首页是问卷列表，指过去。
      const homeRedirect = homeRedirectLocation(url.pathname);
      if (homeRedirect) return new Response(null, { status: 302, headers: { Location: homeRedirect } });

      // Internal endpoints (queue consumers hand browser renders to a request
      // context); token-authenticated, must be routed before the SPA/API blocks.
      if (url.pathname.startsWith("/internal/")) return handleInternalRenderRequest(request, env, ctx);

      // Admin SPA entry. html_handling="none" means /admin has no directory
      // index, so serve the built index.html explicitly (client-side routing
      // handles every /admin/* view).
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        return serveHtmlAsset(env, request, "/index.html");
      }

      if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(request, env);

      // Web survey entry: /s/:id renders the public survey page; the page
      // itself talks to /api/survey/* for the definition and answers.
      const surveyPageMatch = url.pathname.match(/^\/s\/(\d+)$/);
      const ogImageMatch = url.pathname.match(/^\/s\/(\d+)\/og\.png$/);
      if (ogImageMatch) {
        const surveyId = Number(ogImageMatch[1]);
        try {
          const meta = await loadSurveyShareMeta(env.DB, surveyId);
          if (!meta) return new Response("Not Found", { status: 404 });
          const bytes = await getSurveyOgImage(env, meta, resolvePublicOrigin(env, url.origin));
          if (!bytes) return new Response("Not Found", { status: 404 });
          return new Response(bytes, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=600",
            },
          });
        } catch (error) {
          console.error("OG image rendering failed", error);
          return new Response("Rendering unavailable", { status: 503 });
        }
      }
      if (surveyPageMatch) {
        return serveSurveyPageWithShareMeta(env, request, Number(surveyPageMatch[1]));
      }
      if (url.pathname === "/s" || url.pathname.startsWith("/s/")) {
        return servePublicPageWithMeta(env, request, "/s");
      }

      if (url.pathname === "/plaza" || url.pathname.startsWith("/plaza/")) {
        return servePublicPageWithMeta(env, request, "/plaza");
      }

      // Showcase (展示区): the immersive person gallery shares the survey SPA
      // bundle and picks its screen from the pathname.
      if (url.pathname === "/showcase" || url.pathname.startsWith("/showcase/")) {
        return servePublicPageWithMeta(env, request, "/showcase");
      }

      // Web task system player page (/trial) shares the survey SPA bundle; the
      // page itself decides between the survey list and the trial screen.
      if (url.pathname === "/trial" || url.pathname.startsWith("/trial/")) {
        return servePublicPageWithMeta(env, request, "/trial");
      }

      // Email auth pages share the survey SPA bundle as well.
      // "我的" 个人中心 shares the survey SPA bundle as well.
      if (url.pathname === "/me" || url.pathname.startsWith("/me/")) {
        return servePublicPageWithMeta(env, request, "/me");
      }

      // 金币经济三屏（余额/签到/挑战、报告抽卡、投稿中心）与 /me 同属问卷
      // SPA bundle，由路径决定渲染哪一屏。
      if (
        url.pathname === "/coins" ||
        url.pathname.startsWith("/coins/") ||
        url.pathname === "/gacha" ||
        url.pathname.startsWith("/gacha/") ||
        url.pathname === "/submissions" ||
        url.pathname.startsWith("/submissions/")
      ) {
        return servePublicPageWithMeta(env, request, url.pathname.startsWith("/gacha") ? "/gacha" : url.pathname.startsWith("/submissions") ? "/submissions" : "/coins");
      }

      // 旧的投稿两条路径已经并进 /submissions 投稿中心（三个页签：账号投稿 /
      // 免登录投稿 / 我的投稿）。这里 302 而不是直接删，是因为 /submit 被配在
      // SUBMISSION_BOT_URL 里、也发进过群和邮件，删掉就是一堆白屏。
      //
      // **相对路径 Location**：这个 Worker 同时挂在 emoe.eu.cc（国内 SNI 阻断）
      // 和 emoemok.top（Vercel 中继）后面，中继改写后 request.url 的 host 永远
      // 是 emoe.eu.cc —— 写绝对地址会把国内用户甩回打不开的域名。与上面 cert
      // 的重定向同一条规则。
      const submitMeta = submitPageMetaPath(url.pathname);
      if (submitMeta) {
        const tab = submitMeta === "/submit/inbox" ? "inbox" : "anon";
        return new Response(null, { status: 302, headers: { Location: `/submissions?tab=${tab}` } });
      }

      // 认证卡生成器：纯前端静态页，构建时由 scripts/sync-cert.mjs 拷进
      // admin/public/cert/。内容包走 /api/cert-content（公开只读）。
      //
      // 路由判定抽在 src/http/cert-page.ts：那里钉住了「重定向必须是相对路径」
      // —— 这个 Worker 同时挂在 emoe.eu.cc（Cloudflare，国内 SNI 阻断）和
      // emoemok.top（Vercel 中继）后面，中继改写后 request.url 的 host 永远是
      // emoe.eu.cc，用绝对地址重定向会把国内用户甩回打不开的域名。
      const certRoute = certPageRoute(url.pathname);
      if (certRoute?.kind === "redirect") {
        // 页面里的脚本/样式是相对路径，/cert 下会被解析成 /app.js，必须带尾斜杠。
        return new Response(null, { status: 302, headers: { Location: CERT_PAGE_REDIRECT_LOCATION } });
      }
      if (certRoute?.kind === "html") {
        /* 走 head 注入：canonical / og:url 与其它公开页同源（PUBLIC_ORIGIN），
         * 从国内域名分享出去才是一条带标题的完整链接。 */
        return serveHtmlAssetWithMeta(env, request, "/cert/index.html", "/cert");
      }

      // 认证卡内容包：公开只读，管理端通过 /api/admin/cert-content 写入。
      if (url.pathname === "/api/cert-content") {
        const raw = await getSystemSetting(env.DB, CERT_CONTENT_SETTING_KEY);
        if (!raw) return Response.json({ ok: true, pack: null });
        try {
          return Response.json({ ok: true, pack: JSON.parse(raw) });
        } catch {
          return Response.json({ ok: true, pack: null });
        }
      }

      // 认证卡「完成制作」时的原图 + 成品同步：GET 探测开关，POST 上传。
      // 目标频道与报告归档频道共用同一条解析链（见 src/http/cert-share.ts），
      // 未带来源标头的跨站表单一律 403。
      if (url.pathname === CERT_SHARE_PATH) {
        return handleCertShare(request, env, {
          clientKey: resolveClientIdentity(request, env).ip,
        });
      }

      if (url.pathname === "/series" || url.pathname.startsWith("/series/")) {
        return servePublicPageWithMeta(env, request, "/series");
      }

      if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
        return servePublicPageWithMeta(env, request, "/auth");
      }

      // 免登录投稿的后端在主站之外（独立的 submission-bot Worker）。合并投稿
      // 中心之后这一屏和其他两屏在同一个页面里，接口必须在本域上也存在，
      // 否则页签切过去就是 "Unexpected token '<'" —— 那正是合并前"两个投稿
      // 中心"的成因：免登录那半只在 emoemok.top 上真能用。
      //
      // 必须放在 /api/submissions（金币投稿，本站）之前，且 isSubmissionBotApiPath
      // 用的是精确前缀匹配：写成 startsWith("/api/submit") 会把 /api/submissions
      // 一起吞进代理。
      if (isSubmissionBotApiPath(url.pathname)) {
        return handleSubmissionBotProxy(request, env, url);
      }

      if (url.pathname.startsWith("/api/me/")) {
        return guardApiResponse(request, env, url, () => handleMeApiRequest(request, env, url));
      }

      // 连载更新召回的内部端点（0084）：SELF binding + HMAC 验签，无会话。
      if (url.pathname === "/internal/series-notify" && request.method === "POST") {
        return handleInternalSeriesNotify(request, env);
      }

      if (url.pathname.startsWith("/api/series")) {
        return guardApiResponse(request, env, url, () => handleSeriesApiRequest(request, env, url));
      }

      if (
        url.pathname.startsWith("/api/coins/") ||
        url.pathname.startsWith("/api/gacha/") ||
        url.pathname.startsWith("/api/submissions")
      ) {
        return guardApiResponse(request, env, url, () => handleCoinApiRequest(request, env, url));
      }

      if (url.pathname.startsWith("/api/plaza/")) {
        return guardApiResponse(request, env, url, () => handlePlazaApiRequest(request, env, url));
      }

      if (url.pathname === "/api/showcase" || url.pathname.startsWith("/api/showcase/")) {
        return guardApiResponse(request, env, url, () => handleShowcaseApiRequest(request, env, url));
      }

      if (url.pathname.startsWith("/api/survey/") || url.pathname === "/api/surveys") {
        return guardApiResponse(request, env, url, () => handleSurveyApiRequest(request, env, url));
      }

      if (url.pathname.startsWith("/api/report/") || url.pathname.startsWith("/report/")) {
        return guardApiResponse(request, env, url, () => handleReportRequest(request, env, url));
      }

      // 报告分享卡（0081）：/r/:token 公开结局卡页 + og.png。公开页不经过
      // guardApiResponse——它只服务分享行快照的白名单投影。
      if (url.pathname === "/r" || url.pathname.startsWith("/r/")) {
        return (await handleSharePageRequest(request, env, url)) ?? servePublicPageWithMeta(env, request, "/plaza");
      }

      // 个人画像分享（0085）：/u/:token 公开画像页 + og.png。
      if (url.pathname === "/u" || url.pathname.startsWith("/u/")) {
        return (await handleSharePageRequest(request, env, url)) ?? servePublicPageWithMeta(env, request, "/plaza");
      }

      if (url.pathname.startsWith("/api/auth/email/")) {
        return guardApiResponse(request, env, url, () => handleEmailAuthApiRequest(request, env, url));
      }

      if (url.pathname.startsWith("/api/trial/")) {
        return guardApiResponse(request, env, url, () => handleTrialApiRequest(request, env, url));
      }

      if (url.pathname.startsWith("/api/control/customer/") || url.pathname.startsWith("/api/control/runner/")) {
        const controlResponse = await handleControlApiRequest(request, env, { isAdmin: false, userId: null });
        if (controlResponse) return controlResponse;
      }
      if (url.pathname.startsWith("/api/control/")) return handleAdminApi(request, env);

      const licenseApiResponse = await handleLicenseApiRequest(
        request,
        env.DB,
        env.LICENSE_ADMIN_TOKEN,
        env.DEPLOYMENT_ROLE,
      );
      if (licenseApiResponse) {
        return licenseApiResponse;
      }

      const remoteApiResponse = await handleRemoteApiRequest(request, env);
      if (remoteApiResponse) {
        return remoteApiResponse;
      }

      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

        if (!isWebhookSecretValid(env.WEBHOOK_SECRET, secretHeader)) {
          return new Response("Unauthorized", { status: 403 });
        }

        await ensureWebhookAllowsChannelPosts(env, url.origin);

        const deploymentLicense = await checkDeploymentLicense(env);
        if (!deploymentLicense.allowed) {
          console.error("Deployment license rejected", deploymentLicense.code, deploymentLicense.message);
          return Response.json(
            {
              ok: false,
              error: "license_unavailable",
              code: deploymentLicense.code,
            },
            {
              status: 503,
              headers: {
                "Cache-Control": "no-store",
                "Retry-After": "3600",
              },
            },
          );
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        const update = parseTelegramUpdate(body);
        if (!update) {
          return new Response("Bad Request", { status: 400 });
        }

        // Idempotency: Telegram redelivers an update when our answer was slow or
        // lost. Claim it before doing any work so a redelivery of a completed
        // create/answer/submit/publish/export/reward action is skipped instead
        // of running its side effects twice.
        const dedup = createUpdateDedupStore(env.DB);
        if (!(await dedup.claim(update.update_id))) {
          metrics.recordDuplicateUpdate();
          console.info("Duplicate Telegram update skipped", { updateId: update.update_id });
          return Response.json({ ok: true, duplicate: true });
        }

        await ensureTelegramCommandMenu(env);

        console.log("Telegram update received", {
          updateId: update.update_id,
          kind: update.message ? "message" : "callback",
          userId: update.message?.from?.id ?? update.callback_query?.from?.id,
          chatId: update.message?.chat?.id ?? update.callback_query?.message?.chat.id,
        });

        try {
          const context: BotContext = {
            botToken: env.BOT_TOKEN,
            db: env.DB,
            cache: env.CACHE,
            session: env.SESSION,
            builder: env.BUILDER,
            adminIds: parseAdminIds(env.ADMIN_IDS),
            exportQueue: createExportJobSender(env),
            ...(env.BROWSER ? { browser: env.BROWSER } : {}),
            mediaKv: env.MEDIA_KV,
            origin: resolvePublicOrigin(env, url.origin),
            submissionBotUrl: resolveSubmissionBotUrl(env),
            communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
            // Investigation: the BotContext field is consumed only by vendor-only
            // bot surfaces; customer licensing/heartbeat uses Env.LICENSE_SERVER_URL
            // directly in HTTP services. Never advertise a customer Worker as its own
            // license server, because that makes the origin semantically ambiguous.
            licenseServerUrl: isLicenseCenter(env) ? resolvePublicOrigin(env, url.origin) : null,
            surveyCodePepper: env.SURVEY_CODE_PEPPER,
            // Same single source of truth as the web API: only the authorization
            // center may issue licenses or hand out trial accounts.
            licenseAdminEnabled: isLicenseCenter(env),
            ...(env.BROWSER ? { browser: env.BROWSER } : {}),
            webhookSecret: env.WEBHOOK_SECRET,
          };
          await handleTelegramUpdate(update, context);
          await dedup.complete(update.update_id);
          return Response.json({ ok: true });
        } catch (error) {
          console.error("Telegram webhook handler failed", error);
          // Release only defends against an exceptional duplicate delivery path.
          // Failed retries are driven by the 30-minute recovery cron (report-delivery /
          // result-visual / image-generator). We intentionally return 200 below so
          // Telegram stops retrying the user action and cannot execute it twice.
          await dedup.release(update.update_id);
          // The router answers the user itself when a handler fails; only send
          // the generic notice for failures raised before that point.
          if (!isTelegramUpdateHandledError(error)) {
            // A silent failure reads as "the bot is dead" and leaves the chat's
            // loading spinner running, so always answer the user when possible.
            try {
              const callback = update.callback_query;
              const chatId = update.message?.chat?.id ?? callback?.message?.chat.id;
              if (typeof chatId === "number") {
                if (callback) {
                  await answerCallbackQuery(env.BOT_TOKEN, callback.id, "服务暂时不可用，请稍后再试");
                }
                await sendMessage(
                  env.BOT_TOKEN,
                  chatId,
                  isDatabaseCapacityError(error)
                    ? "⚠️ 数据库今日查询额度已用尽，暂时无法处理操作，请稍后再试。"
                    : "😥 服务暂时出了点小问题，请稍后再试。",
                );
              }
            } catch (notifyError) {
              console.warn("Telegram failure notice failed", notifyError);
            }
          }
          return Response.json({ ok: false }, { status: 200 });
        }
      }

      // Admin SPA fallback: any path that isn't a known static asset extension
      // and wasn't matched by a business route above should render the admin
      // index.html so React Router handles client-side routing for /surveys,
      // /reports, /settings and friends.
      const ext = url.pathname.split(".").pop()?.toLowerCase();
      const isStaticAsset = Boolean(
        ext &&
        [
          "html",
          "js",
          "mjs",
          "css",
          "map",
          "png",
          "jpg",
          "jpeg",
          "gif",
          "svg",
          "ico",
          "webp",
          "avif",
          "woff",
          "woff2",
          "ttf",
          "eot",
          "otf",
          "txt",
          "webmanifest",
          "json",
        ].includes(ext),
      );
      if (!isStaticAsset) {
        return serveHtmlAsset(env, request, "/index.html");
      }
      return serveStaticAsset(env, request);
    });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await withQueueMetrics(batch, env, async (env) => {
      await handleExportQueue(batch, env);
    });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (event.cron === "30 9 * * 1") {
      // Weekly operations digest to the report archive channel.
      try {
        const settings = await loadSystemSettings(env.DB);
        const channelRaw = (settings.reportChannelId || env.REPORT_CHANNEL_ID || "").trim();
        const channelId = Number(channelRaw);
        if (!Number.isInteger(channelId) || channelId === 0) return;
        const digest = await loadWeeklyDigest(env.DB);
        await sendMessage(env.BOT_TOKEN, channelId, renderWeeklyDigestMessage(digest));
        console.info("Weekly digest sent", { started: digest.started, completed: digest.completed });
      } catch (error) {
        console.error("Weekly digest failed", error);
      }
      return;
    }
    if (event.cron === "*/30 * * * *") {
      if (env.DEPLOYMENT_ROLE === "customer") {
        try {
          await sendCustomerHeartbeat(env);
        } catch (error) {
          console.warn("Customer Worker heartbeat failed", error);
        }
      }
      // These recovery jobs touch independent queues/tables. Run them concurrently so
      // one slow renderer cannot delay the other recovery paths for a full cron tick.
      await Promise.allSettled([
        (async () => {
          try {
            const summary = await retryPendingReportDeliveries(env.DB, createExportJobSender(env));
            if (summary.requeued > 0) {
              console.info("Requeued pending report deliveries", summary);
            }
          } catch (error) {
            console.error("Report delivery retry driver failed", error);
          }
        })(),
        (async () => {
          try {
            const summary = await recoverStaleResultVisualJobs(env.DB, createExportJobSender(env), env.BOT_TOKEN);
            if (summary.requeued || summary.failed) console.warn("Recovered stale result visual jobs", summary);
          } catch (error) {
            console.error("Result visual job recovery failed", error);
          }
        })(),
        (async () => {
          try {
            const summary = await recoverStaleImageGeneratorJobs(env.DB, createExportJobSender(env), env.BOT_TOKEN);
            if (summary.requeued || summary.failed) console.warn("Recovered stale image generator jobs", summary);
          } catch (error) {
            console.error("Image generator job recovery failed", error);
          }
        })(),
        (async () => {
          try {
            const migrated = await migrateDataUrlCoversToKv(env.DB, env);
            if (migrated > 0) {
              console.info("Migrated data-URL covers into MEDIA_KV", { migrated });
            }
          } catch (error) {
            console.error("Cover KV migration failed", error);
          }
        })(),
      ]);
      return;
    }
    let maintenanceSummary: Awaited<ReturnType<typeof runDatabaseMaintenance>> | null = null;
    let mediaRetentionSummary: Awaited<ReturnType<typeof retainFinishedResponseMedia>> | null = null;
    try {
      maintenanceSummary = await runDatabaseMaintenance(env.DB);
      if (maintenanceSummary.truncated) {
        await notifyMaintenanceBudgetExhausted(env, maintenanceSummary.rowsRead);
      }
    } catch (error) {
      console.error("Database maintenance failed", error);
    }
    try {
      // Rescue attachments of finished responses before the expiry sweep can
      // delete a blob whose previews are still expected to work.
      mediaRetentionSummary = await retainFinishedResponseMedia(env.DB, createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV }));
    } catch (error) {
      console.error("Response media retention sweep failed", error);
    }
    if (maintenanceSummary) {
      console.info("Database maintenance complete", {
        ...maintenanceSummary,
        mediaRetention: mediaRetentionSummary,
      });
    } else if (mediaRetentionSummary?.scanned) {
      console.info("Database maintenance media retention", { mediaRetention: mediaRetentionSummary });
    }
    try {
      const summary = await cleanupExpiredTemporaryMedia(env.DB, createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV }));
      if (summary.deleted > 0) {
        console.info("Expired temporary media cleaned", summary);
      }
    } catch (error) {
      console.error("Temporary media cleanup failed", error);
    }
    try {
      // Stream 直传凭证对账（Pro 部署）：未完成的凭证删对象 + 失效行。
      const streamSweep = await sweepStaleStreamUploads(env.DB, env);
      if (streamSweep.deleted > 0 || streamSweep.failed > 0) {
        console.info("Stale stream uploads swept", streamSweep);
      }
    } catch (error) {
      console.error("Stream upload sweep failed", error);
    }
    if (!env.LICENSE_ADMIN_TOKEN) return;
    const adminIds = parseAdminIds(env.ADMIN_IDS);
    try {
      await sendCreatorTrialExpiryReminders(env.DB, env.CACHE, env.BOT_TOKEN, adminIds);
    } catch (error) {
      console.error("Creator trial expiry reminders failed", error);
    }
  },
};
