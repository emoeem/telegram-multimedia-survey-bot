/**
 * Worker 入口装配层：fetch/queue/scheduled 三个运行时钩子的组合点，外加必须
 * 原样保留的兼容出口（Env、四个 Durable Object 类、escapeMetaAttribute、
 * RESULT_VISUAL_WASM）。路由分发在 src/http/router.ts，scheduled 在 src/cron.ts
 * （拆分地图见 docs/OPTIMIZATION_BACKLOG_2026-11-14.md §D）。
 */
import { cron } from "./cron";
import { route } from "./http/router";
import { handleExportQueue } from "./services/export-worker.service";
import { withQueueMetrics } from "./observability/metrics";
import type { Env } from "./env";
import { RateLimitDO } from "./durable-objects/rate-limit";
import { SurveyBuilderDO } from "./durable-objects/survey-builder";
import { SurveySessionDO } from "./durable-objects/survey-session";
import { UiSessionDO } from "./durable-objects/ui-session";

export type { Env } from "./env";
export { SurveySessionDO, SurveyBuilderDO, UiSessionDO, RateLimitDO };
export { RESULT_VISUAL_WASM } from "./services/result-visual-wasm";

/**
 * Injects Open Graph / Twitter meta tags into the public survey page so
 * shares on Telegram and social platforms render a preview card. Failures
 * are non-fatal: the stock page is served without meta tags.
 */
export { escapeMetaAttribute } from "./http/public-page";

export default {
  fetch: route,

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await withQueueMetrics(batch, env, async (env) => {
      await handleExportQueue(batch, env);
    });
  },

  scheduled: cron,
};
