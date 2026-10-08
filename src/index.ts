import { SurveyBuilderDO } from "./durable-objects/survey-builder";
import { SurveySessionDO } from "./durable-objects/survey-session";
import { UiSessionDO } from "./durable-objects/ui-session";
import { handleTelegramUpdate } from "./bot/router";
import { isTelegramUpdateHandledError } from "./bot/router";
import { syncDefaultBotCommands } from "./bot/telegram";
import { answerCallbackQuery, getWebhookInfo, setWebhook } from "./bot/telegram";
import { describePublicDatabaseError, isDatabaseCapacityError } from "./db/errors";
import type { BotContext } from "./bot/types";
import { parseTelegramUpdate } from "./bot/update-parser";
import { isWebhookSecretValid } from "./core/security";
import { handleInternalRenderRequest } from "./http/internal-render";
import { handleLicenseApiRequest } from "./http/license-api";
import { handleRemoteApiRequest } from "./http/remote-api";
import { handleControlApiRequest } from "./http/control-api";
import { sendCustomerHeartbeat } from "./services/customer-control.service";
import { handleAdminApi } from "./http/admin-api";
import { handleSurveyApiRequest } from "./http/survey-api";
import { handlePlazaApiRequest } from "./http/plaza-api";
import { handleMeApiRequest } from "./http/me-api";
import { handleShowcaseApiRequest } from "./http/showcase-api";
import { handleTrialApiRequest } from "./http/trial-api";
import { handleEmailAuthApiRequest } from "./http/email-auth-api";
import { handleReportRequest } from "./http/report-api";
import { checkDeploymentLicense } from "./services/license-client.service";
import { isLicenseCenter } from "./services/deployment-role.service";
import { handleExportQueue } from "./services/export-worker.service";
import { sendCreatorTrialExpiryReminders } from "./services/creator-trial-reminder.service";
import { runDatabaseMaintenance } from "./services/database-maintenance.service";
import {
  cleanupExpiredTemporaryMedia,
  retainFinishedResponseMedia,
} from "./services/media/temporary-media.service";
import { KVMediaStore } from "./services/media/temporary-media-store";
import { migrateDataUrlCoversToKv } from "./services/cover-storage.service";
import { loadSurveyShareMeta, getSurveyOgImage } from "./services/survey-og-image.service";
import { resolveSubmissionBotUrl } from "./services/contact-links.service";
import { recoverStaleResultVisualJobs } from "./services/result-visual-job-recovery.service";
import { recoverStaleImageGeneratorJobs } from "./services/image-generator-job-recovery.service";
import { retryPendingReportDeliveries } from "./services/report-delivery.service";
import { loadWeeklyDigest, renderWeeklyDigestMessage } from "./services/weekly-digest.service";
import { loadSystemSettings } from "./services/system-settings.service";
import { sendMessage } from "./bot/telegram";
import { createUpdateDedupStore } from "./services/update-dedup.service";
import { createKVRateLimiter } from "./services/rate-limit.service";
import { withQueueMetrics, withRequestMetrics } from "./observability/metrics";
export { RESULT_VISUAL_WASM } from "./services/result-visual-wasm";
import type { BrowserWorker } from "@cloudflare/puppeteer";

/**
 * Serves an SPA HTML entry without allowing the client or any intermediate
 * cache to keep a stale copy: stale bundles have historically left Telegram
 * WebViews stuck on a blank page after a redeploy.
 */
async function serveHtmlAsset(env: Env, request: Request, assetPath: string, injectHead?: string): Promise<Response> {
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
  const html = (await response.text()).replace("</head>", `${injectHead}\n</head>`);
  return new Response(html, { status: response.status, headers });
}

/**
 * Injects Open Graph / Twitter meta tags into the public survey page so
 * shares on Telegram and social platforms render a preview card. Failures
 * are non-fatal: the stock page is served without meta tags.
 */
export function escapeMetaAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

async function serveSurveyPageWithShareMeta(env: Env, request: Request, surveyId: number): Promise<Response> {
  let injectHead: string | undefined;
  try {
    const meta = await loadSurveyShareMeta(env.DB, surveyId);
    if (meta) {
      const origin = new URL(request.url).origin;
      const ogImage = `${origin}/s/${surveyId}/og.png`;
      const description = meta.description?.slice(0, 120) || `${meta.questionCount} 道题，点击立即填写`;
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
  EXPORT_QUEUE: Queue;
  SESSION: DurableObjectNamespace<SurveySessionDO>;
  UI: DurableObjectNamespace<UiSessionDO>;
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
  /** Shared secret used only to encrypt deployment task credentials at rest. */
  CONTROL_PLANE_RUNNER_SECRET?: string;
  WORKER_NAME?: string;
  WORKER_URL?: string;
  /** "vendor" = authorization center, "customer" = licensed instance. Unset
   *  falls back to LICENSE_ADMIN_TOKEN presence (legacy deployments). */
  DEPLOYMENT_ROLE?: "vendor" | "customer";
  BROWSER: BrowserWorker;
  ASSETS: Fetcher;
  TARGET_CHAT_ID?: string;
  TOPIC_ID?: string;
  PUBLICATION_TARGET_CHAT_ID?: string;
  PUBLICATION_TARGET_THREAD_ID?: string;
  /** Optional R2 bucket; media storage falls back to MEDIA_KV when unset. */
  MEDIA?: R2Bucket;
  MEDIA_KV: KVNamespace;
  REPORT_CHANNEL_ID?: string;
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
  /** Transactional email (Resend) for email+password auth. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  /** Pepper used only for new salted survey access-code hashes. */
  SURVEY_CODE_PEPPER?: string;
}

export { SurveySessionDO, SurveyBuilderDO, UiSessionDO };

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
  const limiter = createKVRateLimiter(env.CACHE);
  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";

  if (request.method === "POST" && url.pathname.startsWith("/api/auth/email/")) {
    const body = (await request.clone().json().catch(() => null)) as Record<string, unknown> | null;
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

  if (request.method === "POST" && /^\/api\/survey\/\d+\/responses\/\d+\/answers$/.test(url.pathname)) {
    const allowed = await limiter.allow(`answers|${clientIp}`, 20, 60);
    if (!allowed) {
      return Response.json(
        { ok: false, code: "rate_limited", message: "请求过于频繁，请稍后再试" },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

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
        code: isDatabaseCapacityError(error) ? "database_capacity" : "internal_error",
        message: describePublicDatabaseError(error),
      },
      {
        status: isDatabaseCapacityError(error) ? 503 : 500,
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
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // Internal endpoints (queue consumers hand browser renders to a request
    // context); token-authenticated, must be routed before the SPA/API blocks.
    if (url.pathname.startsWith("/internal/")) return handleInternalRenderRequest(request, env);

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
        const bytes = await getSurveyOgImage(env, meta, url.origin);
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
      return serveHtmlAsset(env, request, "/survey.html");
    }

    if (url.pathname === "/plaza" || url.pathname.startsWith("/plaza/")) {
      return serveHtmlAsset(env, request, "/survey.html");
    }

    // Showcase (展示区): the immersive person gallery shares the survey SPA
    // bundle and picks its screen from the pathname.
    if (url.pathname === "/showcase" || url.pathname.startsWith("/showcase/")) {
      return serveHtmlAsset(env, request, "/survey.html");
    }

    // Web task system player page (/trial) shares the survey SPA bundle; the
    // page itself decides between the survey list and the trial screen.
    if (url.pathname === "/trial" || url.pathname.startsWith("/trial/")) {
      return serveHtmlAsset(env, request, "/survey.html");
    }

    // Email auth pages share the survey SPA bundle as well.
    // "我的" 个人中心 shares the survey SPA bundle as well.
    if (url.pathname === "/me" || url.pathname.startsWith("/me/")) {
      return serveHtmlAsset(env, request, "/survey.html");
    }

    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      return serveHtmlAsset(env, request, "/survey.html");
    }

    if (url.pathname.startsWith("/api/me/")) {
      return guardApiResponse(request, env, url, () => handleMeApiRequest(request, env, url));
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
          exportQueue: env.EXPORT_QUEUE,
          mediaKv: env.MEDIA_KV,
          origin: url.origin,
          submissionBotUrl: resolveSubmissionBotUrl(env),
          communityGroupUrl: env.COMMUNITY_GROUP_URL || null,
          // Investigation: the BotContext field is consumed only by vendor-only
          // bot surfaces; customer licensing/heartbeat uses Env.LICENSE_SERVER_URL
          // directly in HTTP services. Never advertise a customer Worker as its own
          // license server, because that makes the origin semantically ambiguous.
          licenseServerUrl: isLicenseCenter(env) ? url.origin : null,
          surveyCodePepper: env.SURVEY_CODE_PEPPER,
          // Same single source of truth as the web API: only the authorization
          // center may issue licenses or hand out trial accounts.
          licenseAdminEnabled: isLicenseCenter(env),
          browser: env.BROWSER,
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
    return env.ASSETS.fetch(request);
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
            const summary = await retryPendingReportDeliveries(env.DB, env.EXPORT_QUEUE);
            if (summary.requeued > 0) {
              console.info("Requeued pending report deliveries", summary);
            }
          } catch (error) {
            console.error("Report delivery retry driver failed", error);
          }
        })(),
        (async () => {
          try {
            const summary = await recoverStaleResultVisualJobs(env.DB, env.EXPORT_QUEUE, env.BOT_TOKEN);
            if (summary.requeued || summary.failed) console.warn("Recovered stale result visual jobs", summary);
          } catch (error) {
            console.error("Result visual job recovery failed", error);
          }
        })(),
        (async () => {
          try {
            const summary = await recoverStaleImageGeneratorJobs(env.DB, env.EXPORT_QUEUE, env.BOT_TOKEN);
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
      mediaRetentionSummary = await retainFinishedResponseMedia(env.DB, new KVMediaStore(env.MEDIA_KV));
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
      const summary = await cleanupExpiredTemporaryMedia(env.DB, new KVMediaStore(env.MEDIA_KV));
      if (summary.deleted > 0) {
        console.info("Expired temporary media cleaned", summary);
      }
    } catch (error) {
      console.error("Temporary media cleanup failed", error);
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
