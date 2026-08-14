import { SurveyBuilderDO } from "./durable-objects/survey-builder";
import { SurveySessionDO } from "./durable-objects/survey-session";
import { handleTelegramUpdate } from "./bot/router";
import type { BotContext } from "./bot/types";
import { parseTelegramUpdate } from "./bot/update-parser";
import { isWebhookSecretValid } from "./core/security";

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
}

export { SurveySessionDO, SurveyBuilderDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        environment: env.ENVIRONMENT,
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

      if (!isWebhookSecretValid(env.WEBHOOK_SECRET, secretHeader)) {
        return new Response("Unauthorized", { status: 403 });
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

      console.log(
        "Telegram update received",
        update.update_id,
        update.message?.text,
        update.message?.from?.id,
        update.message?.chat?.id,
      );

      try {
        const context: BotContext = {
          botToken: env.BOT_TOKEN,
          db: env.DB,
          session: env.SESSION,
          builder: env.BUILDER,
          adminIds: env.ADMIN_IDS.split(",")
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value) && value > 0),
          exportQueue: env.EXPORT_QUEUE,
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

};
