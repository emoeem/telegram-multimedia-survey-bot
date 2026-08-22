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
import { handleReportRequest } from "./http/report-api";
import { checkDeploymentLicense } from "./services/license-client.service";
import { handleExportQueue } from "./services/export-worker.service";
import { sendCreatorTrialExpiryReminders } from "./services/creator-trial-reminder.service";
import { runDatabaseMaintenance } from "./services/database-maintenance.service";
import { cleanupExpiredTemporaryMedia } from "./services/media/temporary-media.service";
import { KVMediaStore } from "./services/media/temporary-media-store";
import { recoverStaleIdentityCardJobs } from "./services/identity-card-job-recovery.service";
import { recoverStaleResultVisualJobs } from "./services/result-visual-job-recovery.service";
import { retryPendingReportDeliveries } from "./services/report-delivery.service";
export { RESULT_VISUAL_WASM } from "./services/result-visual-wasm";
import type { BrowserWorker } from "@cloudflare/puppeteer";

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
  ENVIRONMENT: "development" | "production";
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

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(request, env);

    // Web survey entry: /s/:id renders the public survey page; the page
    // itself talks to /api/survey/* for the definition and answers.
    if (url.pathname === "/s" || url.pathname.startsWith("/s/")) {
      const surveyPageUrl = new URL("/survey.html", request.url);
      return env.ASSETS.fetch(new Request(surveyPageUrl, request));
    }

    if (url.pathname.startsWith("/api/survey/") || url.pathname === "/api/surveys") {
      const response = await handleSurveyApiRequest(request, env, url);
      return response ?? new Response("Not Found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/report/") || url.pathname.startsWith("/report/")) {
      const response = await handleReportRequest(request, env, url);
      return response ?? new Response("Not Found", { status: 404 });
    }

    const licenseApiResponse = await handleLicenseApiRequest(
      request,
      env.DB,
      env.LICENSE_ADMIN_TOKEN,
    );
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
        console.error(
          "Deployment license rejected",
          deploymentLicense.code,
          deploymentLicense.message,
        );
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

    return new Response("Not Found", { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleExportQueue(batch, env);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
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
        const summary = await recoverStaleIdentityCardJobs(env.DB, env.EXPORT_QUEUE, env.BOT_TOKEN);
        if (summary.requeued || summary.failed) console.warn("Recovered stale identity card jobs", summary);
      } catch (error) {
        console.error("Identity card job recovery failed", error);
      }
      try {
        const summary = await recoverStaleResultVisualJobs(env.DB, env.EXPORT_QUEUE, env.BOT_TOKEN);
        if (summary.requeued || summary.failed) console.warn("Recovered stale result visual jobs", summary);
      } catch (error) {
        console.error("Result visual job recovery failed", error);
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
      const summary = await cleanupExpiredTemporaryMedia(
        env.DB,
        new KVMediaStore(env.MEDIA_KV),
      );
      if (summary.deleted > 0) {
        console.info("Expired temporary media cleaned", summary);
      }
    } catch (error) {
      console.error("Temporary media cleanup failed", error);
    }
    if (!env.LICENSE_ADMIN_TOKEN) return;
    const adminIds = env.ADMIN_IDS.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
    await sendCreatorTrialExpiryReminders(env.DB, env.CACHE, env.BOT_TOKEN, adminIds);
  },

};
