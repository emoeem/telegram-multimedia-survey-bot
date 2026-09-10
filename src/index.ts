import { SurveyBuilderDO } from "./durable-objects/survey-builder";
import { SurveySessionDO } from "./durable-objects/survey-session";
import { UiSessionDO } from "./durable-objects/ui-session";
import { handleTelegramUpdate } from "./bot/router";
import { syncDefaultBotCommands } from "./bot/telegram";
import { getWebhookInfo, setWebhook } from "./bot/telegram";
import type { BotContext } from "./bot/types";
import { parseTelegramUpdate } from "./bot/update-parser";
import { isWebhookSecretValid } from "./core/security";
import { handleLicenseApiRequest } from "./http/license-api";
import { handleAdminApi } from "./http/admin-api";
import { handleSurveyApiRequest } from "./http/survey-api";
import { handlePlazaApiRequest } from "./http/plaza-api";
import { handleTrialApiRequest } from "./http/trial-api";
import { handleEmailAuthApiRequest } from "./http/email-auth-api";
import { handleReportRequest } from "./http/report-api";
import { checkDeploymentLicense } from "./services/license-client.service";
import { handleExportQueue } from "./services/export-worker.service";
import { sendCreatorTrialExpiryReminders } from "./services/creator-trial-reminder.service";
import { runDatabaseMaintenance } from "./services/database-maintenance.service";
import { cleanupExpiredTemporaryMedia } from "./services/media/temporary-media.service";
import { KVMediaStore } from "./services/media/temporary-media-store";
import { migrateDataUrlCoversToKv } from "./services/cover-storage.service";
import { loadSurveyShareMeta, getSurveyOgImage } from "./services/survey-og-image.service";
import { recoverStaleResultVisualJobs } from "./services/result-visual-job-recovery.service";
import { retryPendingReportDeliveries } from "./services/report-delivery.service";
import { loadWeeklyDigest, renderWeeklyDigestMessage } from "./services/weekly-digest.service";
import { loadSystemSettings } from "./services/system-settings.service";
import { sendMessage } from "./bot/telegram";
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
        `<meta property="og:title" content="${meta.title.replaceAll('"', "&quot;")}" />`,
        `<meta property="og:description" content="${description.replaceAll('"', "&quot;")}" />`,
        `<meta property="og:image" content="${ogImage}" />`,
        `<meta property="og:url" content="${origin}/s/${surveyId}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${meta.title.replaceAll('"', "&quot;")}" />`,
        `<meta name="twitter:description" content="${description.replaceAll('"', "&quot;")}" />`,
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
  APP_VERSION?: string;
  LICENSE_ENFORCEMENT?: "disabled" | "required";
  LICENSE_SERVER_URL?: string;
  LICENSE_KEY?: string;
  LICENSE_ADMIN_TOKEN?: string;
  INSTALLATION_ID?: string;
  LICENSE_GRACE_SECONDS?: string;
  BROWSER: BrowserWorker;
  ASSETS: Fetcher;
  /** Optional R2 bucket; media storage falls back to MEDIA_KV when unset. */
  MEDIA?: R2Bucket;
  MEDIA_KV: KVNamespace;
  REPORT_CHANNEL_ID?: string;
  /** Telegram channel that mirrors published plaza cards and tree-hole posts. */
  PLAZA_CHANNEL_ID?: string;
  COMMUNITY_GROUP_URL?: string;
  /** Transactional email (Resend) for email+password auth. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

export { SurveySessionDO, SurveyBuilderDO, UiSessionDO };

const commandMenuCacheKey = "telegram-command-menu:v2";
const webhookConfigCacheKey = "telegram-webhook-config:v2";

async function ensureTelegramCommandMenu(env: Env): Promise<void> {
  try {
    if (await env.CACHE.get(commandMenuCacheKey)) return;
    await syncDefaultBotCommands(env.BOT_TOKEN);
    await env.CACHE.put(commandMenuCacheKey, "synced");
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
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        environment: env.ENVIRONMENT,
        version: env.APP_VERSION ?? "unknown",
        licenseEnforcement: env.LICENSE_ENFORCEMENT ?? "disabled",
      });
    }

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

    // Web task system player page (/trial) shares the survey SPA bundle; the
    // page itself decides between the survey list and the trial screen.
    if (url.pathname === "/trial" || url.pathname.startsWith("/trial/")) {
      return serveHtmlAsset(env, request, "/survey.html");
    }

    // Email auth pages share the survey SPA bundle as well.
    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      return serveHtmlAsset(env, request, "/survey.html");
    }

    if (url.pathname.startsWith("/api/plaza/")) {
      return (await handlePlazaApiRequest(request, env, url)) ?? new Response("Not Found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/survey/") || url.pathname === "/api/surveys") {
      const response = await handleSurveyApiRequest(request, env, url);
      return response ?? new Response("Not Found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/report/") || url.pathname.startsWith("/report/")) {
      const response = await handleReportRequest(request, env, url);
      return response ?? new Response("Not Found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/auth/email/")) {
      const response = await handleEmailAuthApiRequest(request, env, url);
      return response ?? new Response("Not Found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/trial/")) {
      const response = await handleTrialApiRequest(request, env, url);
      return response ?? new Response("Not Found", { status: 404 });
    }

    const licenseApiResponse = await handleLicenseApiRequest(request, env.DB, env.LICENSE_ADMIN_TOKEN);
    if (licenseApiResponse) {
      return licenseApiResponse;
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
          adminIds: env.ADMIN_IDS.split(",")
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value) && value > 0),
          exportQueue: env.EXPORT_QUEUE,
          mediaKv: env.MEDIA_KV,
          origin: url.origin,
          licenseServerUrl: url.origin,
          licenseAdminEnabled: Boolean(env.LICENSE_ADMIN_TOKEN),
          browser: env.BROWSER,
          webhookSecret: env.WEBHOOK_SECRET,
        };
        await handleTelegramUpdate(update, context);
        return Response.json({ ok: true });
      } catch (error) {
        console.error("Telegram webhook handler failed", error);
        return Response.json({ ok: false }, { status: 200 });
      }
    }

    // Serve any remaining static asset (JS/CSS/images and direct .html files).
    // With run_worker_first=true every request reaches the Worker first, so
    // asset serving is explicit here; not_found_handling="none" keeps unknown
    // paths as a plain 404 instead of falling back to the admin index.html.
    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleExportQueue(batch, env);
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
    if (event.cron === "*/10 * * * *") {
      try {
        const summary = await retryPendingReportDeliveries(env.DB, env.EXPORT_QUEUE);
        if (summary.requeued > 0) {
          console.info("Requeued pending report deliveries", summary);
        }
      } catch (error) {
        console.error("Report delivery retry driver failed", error);
      }
      try {
        const summary = await recoverStaleResultVisualJobs(env.DB, env.EXPORT_QUEUE, env.BOT_TOKEN);
        if (summary.requeued || summary.failed) console.warn("Recovered stale result visual jobs", summary);
      } catch (error) {
        console.error("Result visual job recovery failed", error);
      }
      try {
        const migrated = await migrateDataUrlCoversToKv(env.DB, env);
        if (migrated > 0) {
          console.info("Migrated data-URL covers into MEDIA_KV", { migrated });
        }
      } catch (error) {
        console.error("Cover KV migration failed", error);
      }
      return;
    }
    try {
      const summary = await runDatabaseMaintenance(env.DB);
      console.info("Database maintenance complete", summary);
    } catch (error) {
      console.error("Database maintenance failed", error);
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
    const adminIds = env.ADMIN_IDS.split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    try {
      await sendCreatorTrialExpiryReminders(env.DB, env.CACHE, env.BOT_TOKEN, adminIds);
    } catch (error) {
      console.error("Creator trial expiry reminders failed", error);
    }
  },
};
