import { SurveyBuilderDO } from "./durable-objects/survey-builder";
import { SurveySessionDO } from "./durable-objects/survey-session";
import { handleTelegramUpdate } from "./bot/router";
import { syncDefaultBotCommands } from "./bot/telegram";
import type { BotContext } from "./bot/types";
import { parseTelegramUpdate } from "./bot/update-parser";
import { isWebhookSecretValid } from "./core/security";
import { handleLicenseApiRequest } from "./http/license-api";
import { checkDeploymentLicense } from "./services/license-client.service";
import { handleExportQueue } from "./services/export-worker.service";
import { sendCreatorTrialExpiryReminders } from "./services/creator-trial-reminder.service";
import type { BrowserWorker } from "@cloudflare/puppeteer";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  EXPORT_QUEUE: Queue;
  SESSION: DurableObjectNamespace<SurveySessionDO>;
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
}

export { SurveySessionDO, SurveyBuilderDO };

const commandMenuCacheKey = "telegram-command-menu:v2";

async function ensureTelegramCommandMenu(env: Env): Promise<void> {
  try {
    if (await env.CACHE.get(commandMenuCacheKey)) return;
    await syncDefaultBotCommands(env.BOT_TOKEN);
    await env.CACHE.put(commandMenuCacheKey, "synced");
  } catch (error) {
    console.warn("Telegram command menu sync failed", error);
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
          licenseServerUrl: url.origin,
          licenseAdminEnabled: Boolean(env.LICENSE_ADMIN_TOKEN),
          browser: env.BROWSER,
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

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (!env.LICENSE_ADMIN_TOKEN) return;
    const adminIds = env.ADMIN_IDS.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
    await sendCreatorTrialExpiryReminders(env.DB, env.CACHE, env.BOT_TOKEN, adminIds);
  },

};
