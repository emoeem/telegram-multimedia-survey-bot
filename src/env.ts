import type { BrowserWorker } from "@cloudflare/puppeteer";
import type { RateLimitDO } from "./durable-objects/rate-limit";
import type { SurveyBuilderDO } from "./durable-objects/survey-builder";
import type { SurveySessionDO } from "./durable-objects/survey-session";
import type { UiSessionDO } from "./durable-objects/ui-session";

/**
 * Worker 的绑定与环境配置总表。原定义在 src/index.ts（拆分见
 * docs/OPTIMIZATION_BACKLOG_2026-11-14.md §D）；DO re-export 仍经 index.ts
 * 出口（wrangler 的 DO 绑定要求类从主入口导出）。
 */
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
   * `cn-relay/` and docs/ops/CN_ACCESS_VERCEL_RELAY.md, `wrangler secret put
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
   * Legacy submission-bot's bot token, kept ONLY to read media of submissions
   * imported from the old D1 (their attachments are Telegram file_ids that are
   * valid for that bot account alone). Read-only getFile + file download; once
   * every legacy submission has been reviewed/archived this can be removed.
   */
  SUBMISSION_BOT_LEGACY_TOKEN?: string;
  /** Transactional email (Resend) for email+password auth. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  /** Pepper used only for new salted survey access-code hashes. */
  SURVEY_CODE_PEPPER?: string;
  /**
   * 部署档位显式声明（docs/ops/CLOUDFLARE_PLAN_TIERS.md 原则一）。与绑定探测结果
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
