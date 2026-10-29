import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { BotContext } from "../bot/types";
import { addReportImages, buildResponseReportBundle, formatChinaDateTime } from "../bot/survey-report";
import { renderResponseReport, type PngViewportStrategy } from "./response-report.service";
import { sendDocument, sendMessage, sendPhoto, sendPhotoAlbum } from "../bot/telegram";
import {
  getDefaultPublicationTarget,
  listEnabledPublicationTargets,
} from "../db/repositories/publication-target.repository";
import {
  PUBLIC_REPORT_ALBUM_BATCH_SIZE,
  buildPublicReportBatchCaption,
  buildPublicReportCaption,
  clampPublicReportCaption,
  normalizePublishMessage,
  type PublicReportCaptionInput,
} from "./public-report-caption";

export interface PublicReportEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  BROWSER?: BrowserWorker;
  MEDIA_KV?: KVNamespace;
}

/**
 * Browser Rendering allows only a couple of concurrent browser sessions per
 * account, and every submit also enqueues its archive delivery (another
 * browser render) right before this job. Rendering while that sibling is
 * still running gets the page killed (TargetCloseError), so wait for it to
 * settle before starting.
 */
async function waitForSiblingReportDelivery(db: D1Database, responseId: number): Promise<void> {
  for (let waited = 0; waited < 90_000; waited += 5_000) {
    const row = await db
      .prepare("SELECT status FROM report_deliveries WHERE response_id=? LIMIT 1")
      .bind(responseId)
      .first<{ status: string }>();
    if (!row || row.status === "delivered" || row.status === "failed") return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

function isTransientRenderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return ["TargetCloseError", "ProtocolError", "TimeoutError"].includes(error.name);
}

const RENDER_STRATEGIES = ["set-viewport", "probe-fullpage"] as const;
const RENDER_ATTEMPTS = RENDER_STRATEGIES.length;
/** > the ~20s account-wide cooldown between new browser acquisitions. */
const RENDER_ATTEMPT_DELAYS_MS = [25_000, 30_000];
const STALE_SESSION_AGE_MS = 180_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The account may only acquire new browser sessions at a slow rate and has a
 * small pool of concurrent session slots; a launch that ignores either gets a
 * session that dies on its first few protocol calls (TargetCloseError). Gate
 * every launch on the binding's own limits view, and recycle long-idle leaked
 * sessions when the pool is full.
 */
async function waitUntilBrowserAcquisitionAllowed(env: PublicReportEnvironment, responseId: number): Promise<void> {
  for (let waited = 0; waited < 120_000; waited += 5_000) {
    let limits;
    try {
      limits = await puppeteer.limits(env.BROWSER!);
    } catch (error) {
      console.warn("Browser limits unavailable; proceeding without gating", {
        responseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const activeCount = limits.activeSessions.length;
    const cooldownMs = (limits.timeUntilNextAllowedBrowserAcquisition ?? 0) * 1000;
    const poolFull = limits.maxConcurrentSessions > 0 && activeCount >= limits.maxConcurrentSessions;
    const acquisitionAllowed = limits.allowedBrowserAcquisitions >= 1 && cooldownMs === 0 && !poolFull;
    if (acquisitionAllowed) return;
    console.info("Browser acquisition gated; waiting", {
      responseId,
      activeSessions: activeCount,
      maxConcurrentSessions: limits.maxConcurrentSessions,
      allowedBrowserAcquisitions: limits.allowedBrowserAcquisitions,
      cooldownMs,
    });
    if (poolFull) await recycleStaleSessions(env, responseId);
    await sleep(Math.max(5_000, Math.min(cooldownMs, 20_000)));
  }
  console.warn("Browser acquisition still gated after 120s; attempting render anyway", { responseId });
}

async function recycleStaleSessions(env: PublicReportEnvironment, responseId: number): Promise<void> {
  let sessions;
  try {
    sessions = await puppeteer.sessions(env.BROWSER!);
  } catch {
    return;
  }
  const now = Date.now();
  for (const session of sessions) {
    if (now - session.startTime < STALE_SESSION_AGE_MS) continue;
    try {
      const browser = await puppeteer.connect(env.BROWSER!, session.sessionId);
      await browser.close();
      console.warn("Recycled stale browser session", {
        responseId,
        sessionId: session.sessionId,
        ageSeconds: Math.round((now - session.startTime) / 1000),
      });
    } catch (error) {
      console.warn("Stale session recycle failed", {
        responseId,
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function renderPublicReportArtifact(
  env: PublicReportEnvironment,
  ctx: BotContext,
  responseId: number,
  surveyId: number,
  /** 答卷级匿名（迁移 0092）：报告图片上的「填写者」同样要剥掉身份。 */
  anonymous: boolean,
  /**
   * 公开面「填写者」标签（loadPublicReportRespondentLabel 的结果）。必须显式传：
   * 报告图片的页眉只允许姓名/@username——数字 Telegram ID 只进管理员的私有面
   * 报告，绝不进公开频道（匿名时传 null，bundle 会渲染成「匿名」）。
   */
  respondentLabel: string | null,
): Promise<{
  artifact: Awaited<ReturnType<typeof renderResponseReport>>;
  report: Awaited<ReturnType<typeof buildResponseReportBundle>>["report"];
}> {
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await sleep(RENDER_ATTEMPT_DELAYS_MS[Math.min(attempt - 1, RENDER_ATTEMPT_DELAYS_MS.length - 1)]!);
    await waitUntilBrowserAcquisitionAllowed(env, responseId);
    const strategy = RENDER_STRATEGIES[Math.min(attempt, RENDER_STRATEGIES.length - 1)] as PngViewportStrategy;
    try {
      const bundle = await buildResponseReportBundle(ctx, surveyId, responseId, responseId, {
        anonymous,
        respondentLabel,
      });
      const report = await addReportImages(ctx, bundle);
      const artifact = await renderResponseReport(env.BROWSER!, report, "png", strategy);
      if (attempt > 0)
        console.warn("Public report render succeeded after retry", { responseId, attempt: attempt + 1, strategy });
      return { artifact, report };
    } catch (error) {
      if (attempt >= RENDER_ATTEMPTS - 1 || !isTransientRenderError(error)) {
        console.error("Public report render attempt failed terminally", {
          responseId,
          attempt: attempt + 1,
          strategy,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        throw error;
      }
      console.warn("Public report render hit a browser session error; retrying", {
        responseId,
        attempt: attempt + 1,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      await logBrowserSessionDiagnostics(env, responseId);
    }
  }
}

/**
 * Dumps the binding's own view of session state when a render dies: which
 * sessions are active, how much of the account limits is in use, and why
 * recent sessions were closed (BrowserIdle vs NormalClosure etc.).
 */
async function logBrowserSessionDiagnostics(env: PublicReportEnvironment, responseId: number): Promise<void> {
  try {
    const [sessions, limits, history] = await Promise.all([
      puppeteer.sessions(env.BROWSER!),
      puppeteer.limits(env.BROWSER!),
      puppeteer.history(env.BROWSER!),
    ]);
    console.warn("Browser session diagnostics", {
      responseId,
      activeSessions: sessions,
      limits,
      recentSessions: Array.isArray(history)
        ? history.slice(-6).map((entry) => ({
            sessionId: entry.sessionId,
            startTime: entry.startTime,
            endTime: entry.endTime,
            closeReason: entry.closeReason,
          }))
        : history,
    });
  } catch (diagnosticsError) {
    console.warn("Browser session diagnostics unavailable", {
      responseId,
      error: diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError),
    });
  }
}

export interface PublicReportTarget {
  id: number | null;
  name: string;
  chatId: string;
  threadId: number | null;
}

interface PublicReportResponseRow {
  id: number;
  survey_id: number;
  status: string;
  report_publication_status: string;
  publication_target_id: number | null;
  publication_target_chat_id: string | null;
  publication_target_thread_id: number | null;
  /** 迁移 0092：答卷者自己的两项发布选择（是否匿名为 1 表示剥离身份）。 */
  publish_anonymous?: number | null;
  publish_message?: string | null;
  /** 迁移 0093：发布抢锁与断点（老库缺列时为 null，走不可续发的老路径）。 */
  report_publication_claim_at?: string | null;
  report_publication_progress?: string | null;
  /** 发布时刻并不需要渲染就能拿到的问卷名与时间——caption 的真相来源。 */
  survey_title?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** 迁移 0092 的选择列：缺列时按「匿名 + 无留言」读取。 */
const PUBLICATION_CHOICE_COLUMNS = ["publish_anonymous", "publish_message"] as const;
/** 迁移 0093 的断点列：缺列时退化成不可续发（老库也能发布，只是不能断点）。 */
const PUBLICATION_PROGRESS_COLUMNS = ["report_publication_claim_at", "report_publication_progress"] as const;

/**
 * 按库里**实际存在**的列拼发布用的 SELECT。
 *
 * 这里以前是写死的 `r.publish_anonymous, r.publish_message`，而旁边的注释却
 * 声称「未 apply 迁移的老库也能跑」——两者互相矛盾：真跑起来 D1 直接
 * `no such column: r.publish_anonymous`，发布在客户机（customer 角色往往不
 * 跟着升级迁移）上永久失败。现在改成先 `PRAGMA table_info` 探测，缺列就退化成
 * `1 AS publish_anonymous, NULL AS publish_message`（与读取侧 `?? 1` 同一口径：
 * 缺数据时收紧成匿名），语义与注释一致。
 */
export function buildPublicationResponseSelect(columns: ReadonlySet<string>): string {
  const hasChoice = PUBLICATION_CHOICE_COLUMNS.every((column) => columns.has(column));
  const hasProgress = PUBLICATION_PROGRESS_COLUMNS.every((column) => columns.has(column));
  return `SELECT r.id, r.survey_id, r.status, r.report_publication_status,
         r.publication_target_id, r.publication_target_chat_id, r.publication_target_thread_id,
         ${hasChoice ? "r.publish_anonymous, r.publish_message" : "1 AS publish_anonymous, NULL AS publish_message"},
         ${
           hasProgress
             ? "r.report_publication_claim_at, r.report_publication_progress"
             : "NULL AS report_publication_claim_at, NULL AS report_publication_progress"
         },
         r.started_at, r.completed_at,
         s.title AS survey_title
    FROM survey_responses r
    LEFT JOIN surveys s ON s.id = r.survey_id
   WHERE r.id = ? LIMIT 1`;
}

/**
 * 迁移齐全时的 SELECT。导出是为了让测试在真实 SQLite 上跑这条 SQL：发布是异步
 * 链路，这条 SELECT 里少一列（或 JOIN 写错）只会在真正发布那一刻炸。
 *
 * 运行时**不直接用它**——老库可能缺列，见 {@link loadPublicationResponseRow}。
 */
export const PUBLICATION_RESPONSE_SELECT = buildPublicationResponseSelect(
  new Set<string>([...PUBLICATION_CHOICE_COLUMNS, ...PUBLICATION_PROGRESS_COLUMNS]),
);

/**
 * 每个 DB 句柄探测一次列集合（WeakMap 而不是模块级变量：测试里每个用例都会
 * 新建一个内存库，缓存跨库复用就会把上一个库的列集合套到下一个库上）。
 */
const publicationColumnCache = new WeakMap<D1Database, Promise<Set<string>>>();

async function detectResponseColumns(db: D1Database): Promise<Set<string>> {
  const cached = publicationColumnCache.get(db);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const info = await db.prepare("PRAGMA table_info(survey_responses)").all<{ name?: string }>();
      return new Set((info.results ?? []).map((row) => String(row.name ?? "")));
    } catch (error) {
      // 探测失败不该让发布直接失败：当作「迁移齐全」处理，真缺列时下面的
      // SELECT 会带着明确的 no such column 报错（比在这里静默退化更好查）。
      console.warn("survey_responses 列探测失败，按迁移齐全处理", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Set<string>([...PUBLICATION_CHOICE_COLUMNS, ...PUBLICATION_PROGRESS_COLUMNS]);
    }
  })();
  publicationColumnCache.set(db, probe);
  return probe;
}

/** 发布链路读到的那行答卷 + 这次到底有没有断点列可用。 */
export async function loadPublicationResponseRow(
  db: D1Database,
  responseId: number,
): Promise<{ row: PublicReportResponseRow | null; resumable: boolean }> {
  let columns = await detectResponseColumns(db);
  for (let attempt = 0; ; attempt += 1) {
    const resumable = PUBLICATION_PROGRESS_COLUMNS.every((column) => columns.has(column));
    try {
      const row = await db
        .prepare(buildPublicationResponseSelect(columns))
        .bind(responseId)
        .first<PublicReportResponseRow>();
      return { row: row ?? null, resumable };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 缓存过期（部署后才 apply 迁移、或探测那次刚好失败）时重探一次。
      if (attempt > 0 || !/no such column/i.test(message)) throw error;
      publicationColumnCache.delete(db);
      columns = await detectResponseColumns(db);
    }
  }
}

/** 迁移 0092 之前的老库没有该列时按「匿名」处理：泄漏不可逆，缺省必须收紧。 */
export function isResponsePublishAnonymous(row: { publish_anonymous?: number | null }): boolean {
  return Number(row.publish_anonymous ?? 1) === 1;
}

/**
 * 发布消息里「填写者」那一栏的文字。
 *
 * 两条规则，都写在数据层而不是"+文案时遮盖"：
 *   1. **匿名：立刻返回 null 且不执行任何查询**——身份不是"查出来再遮盖"，而是
 *      这条链路上根本没有读它，所以任何下游（caption、日志、报告图片）都不可能
 *      把它印出去；
 *   2. **即使不匿名，也不写数字 Telegram ID**：答卷者同意公开的是名字/用户名，
 *      不是那个只有内部系统才需要的 user id（它可被用来精确检索一个人）。管理
 *      员侧的报告仍用完整格式（formatRespondent），那是私有面。
 */
export async function loadPublicReportRespondentLabel(
  env: PublicReportEnvironment,
  responseId: number,
  anonymous: boolean,
): Promise<string | null> {
  if (anonymous) return null;
  const row = await env.DB.prepare(
    `SELECT u.username, u.first_name, u.last_name
       FROM survey_responses r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.id = ? LIMIT 1`,
  )
    .bind(responseId)
    .first<{ username: string | null; first_name: string | null; last_name: string | null }>();
  if (!row) return null;
  const name = [row.first_name, row.last_name]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (name) return name;
  // 只有用户名时用 @username；连用户名都没有就不显示填写者——不拿数字 ID 顶替。
  return row.username ? `@${row.username}` : null;
}

/**
 * 公开报告的接收方列表。公开报告是 fan-out：后台列表里每个「启用」的目标都会收到
 * 同一份相册（答题人只在网页上勾一次「公开发布到 Telegram」）。
 *
 * 回落链：本机已启用的目标 → 答卷提交时的目标快照 → 默认目标。第二、三级保留是
 * 因为 customer 角色的机器不在本地维护目标列表（目标由授权中心下发，提交时写进
 * 答卷快照），这类实例必须继续按老路径投递。
 */
export async function resolvePublicReportTargets(
  env: PublicReportEnvironment,
  response: PublicReportResponseRow,
): Promise<PublicReportTarget[]> {
  const enabled = await listEnabledPublicationTargets(env.DB);
  if (enabled.length) {
    return enabled.map((target) => ({
      id: target.id,
      name: target.name,
      chatId: target.chatId,
      threadId: target.threadId,
    }));
  }
  if (response.publication_target_chat_id) {
    return [
      {
        id: response.publication_target_id,
        name: "答卷提交时的公开目标",
        chatId: response.publication_target_chat_id,
        threadId: response.publication_target_thread_id,
      },
    ];
  }
  const row = response.publication_target_id
    ? await env.DB.prepare("SELECT id,name,chat_id,thread_id FROM publication_targets WHERE id=? AND enabled=1")
        .bind(response.publication_target_id)
        .first<{ id: number; name: string; chat_id: string; thread_id: number | null }>()
    : null;
  if (row) return [{ id: row.id, name: row.name, chatId: row.chat_id, threadId: row.thread_id }];
  const fallback = await getDefaultPublicationTarget(env.DB);
  return fallback
    ? [{ id: fallback.id, name: fallback.name, chatId: fallback.chatId, threadId: fallback.threadId }]
    : [];
}

/**
 * 发布抢锁的有效期：超过这段时间没被刷新，视为上一个消费者已死，可被接管。
 *
 * 5 分钟而不是 15：每发完一批都会刷新锁，而一次发布的实际耗时远小于 5 分钟
 * （Worker 的子请求/CPU 上限都比它短）。窗口越长，"消费者被杀 → 锁挂着 →
 * 队列重试被跳过并 ack"这条路径的停滞就越久。
 */
export const PUBLICATION_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * 断点/终态写入时发现锁已易主（admin 重投清了旧锁，或锁过期后被别的消费者
 * 抢走）。必须抛出而不是吞掉：本消费者已不拥有发布权，继续发送会同新持锁者
 * **并发发出同一批相册**——这正是抢锁要防的事，写入侧不 CAS 等于白抢。
 */
export class PublicationLockLostError extends Error {
  constructor(responseId: number) {
    super(`公开发布锁已被其他消费者接管（responseId=${responseId}）`);
    this.name = "PublicationLockLostError";
  }
}

/** 单个目标（群组 / 话题）的发布断点。 */
export interface PublicReportTargetProgress {
  /** 已成功发出的 message id（重试时不会重发这些批次）。 */
  messageIds: number[];
  /** 下一个待发送批次的起始下标（单位是页，不是批）。 */
  nextOffset: number;
  /** 该目标的全部批次都已发完。 */
  done: boolean;
  /** 最近一次失败原因，供后台/日志定位（不含任何答卷内容）。 */
  error?: string;
}

/**
 * 发布断点（迁移 0093 的 report_publication_progress 列）。
 *
 * 为什么要落库而不是只放在这次调用的内存里：发布跑在队列/Durable 内部路由上，
 * 一次调用随时可能在中途被切断（子请求超时、Worker 被回收）。断点不在库里，
 * 重试就只能整份重发——这份相册会被同一个群收到两遍。
 */
export interface PublicReportProgress {
  /** 本次渲染出的页数（0 表示还没渲染/未知）。 */
  pages: number;
  /** 发送形态：相册，或渲染受限时降级成的一份 PDF。 */
  mode: "album" | "pdf";
  /** `${chatId}:${threadId ?? ""}` → 进度。 */
  targets: Record<string, PublicReportTargetProgress>;
}

export function publicationProgressKey(chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? ""}`;
}

/** 宽容解析：库里那串 JSON 是"上一版代码写的"，坏掉也不能让发布整个失败。 */
export function parsePublicReportProgress(raw: string | null | undefined): PublicReportProgress | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<PublicReportProgress>;
    const pages = Number(value.pages ?? 0);
    const targets: Record<string, PublicReportTargetProgress> = {};
    const rawTargets = value.targets;
    if (rawTargets && typeof rawTargets === "object") {
      for (const [key, entry] of Object.entries(rawTargets as Record<string, Partial<PublicReportTargetProgress>>)) {
        if (!entry || typeof entry !== "object") continue;
        const messageIds = Array.isArray(entry.messageIds)
          ? entry.messageIds.filter((id): id is number => Number.isInteger(id) && id > 0)
          : [];
        const nextOffset = Number(entry.nextOffset ?? 0);
        targets[key] = {
          messageIds,
          nextOffset: Number.isInteger(nextOffset) && nextOffset >= 0 ? nextOffset : 0,
          done: entry.done === true,
          ...(typeof entry.error === "string" ? { error: entry.error } : {}),
        };
      }
    }
    return {
      pages: Number.isInteger(pages) && pages >= 0 ? pages : 0,
      mode: value.mode === "pdf" ? "pdf" : "album",
      targets,
    };
  } catch {
    return null;
  }
}

export interface PublicReportOutcome {
  chatId: number;
  messageIds: number[];
  pages: number;
  targets: Array<{ chatId: number; messageIds: number[]; error?: string }>;
  /** 另一个消费者持有发布锁，本次什么都没做（不是失败）。 */
  skipped?: boolean;
}

/**
 * 发送**前**抢占发布权。
 *
 * 抢占是为了堵住「已经发出去了，但写 published 那一行失败 / 子请求超时」这个
 * 窗口：没有抢占时，队列一重试就把整份相册再发一遍。这里把「谁在发」写成库里的
 * 一行：条件 UPDATE 只有在没有锁（或锁已过期）时才会命中，命中数就是抢没抢到。
 *
 * 返回值是本次抢到的锁凭据（claim_at 的旧值），后续所有断点/终态写入都要带它做
 * CAS——不带 CAS 的写入会让「锁被接管」形同虚设。没抢到返回 null（不是错误）：
 * 另一个消费者正在发同一份，本次直接跳过即可。
 * 老库缺列时返回空串占位（发布照常，但没有锁与断点可依）。
 */
async function claimPublication(
  env: PublicReportEnvironment,
  responseId: number,
  resumable: boolean,
  now: number,
): Promise<string | null> {
  const claimedAt = new Date(now).toISOString();
  if (!resumable) {
    await env.DB.prepare("UPDATE survey_responses SET report_publication_status='pending', updated_at=? WHERE id=?")
      .bind(claimedAt, responseId)
      .run();
    return "";
  }
  const staleBefore = new Date(now - PUBLICATION_CLAIM_STALE_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE survey_responses
        SET report_publication_claim_at = ?, report_publication_status = 'pending', updated_at = ?
      WHERE id = ?
        AND report_publication_status IN ('pending','failed')
        AND (report_publication_claim_at IS NULL OR report_publication_claim_at < ?)`,
  )
    .bind(claimedAt, claimedAt, responseId, staleBefore)
    .run();
  return Number(result.meta?.changes ?? 0) > 0 ? claimedAt : null;
}

/**
 * 每批之后落一次断点，同时把锁续到 now——所以只要发送还在推进，锁就不会在
 * 5 分钟后被当成过期锁接管（渲染阶段的续期见 publishPublicResponseReport）。
 *
 * 写入带 CAS（WHERE claim_at = 本次凭据）：changes=0 说明锁已被接管，抛
 * {@link PublicationLockLostError} 让本次消费者立刻停手——继续发会同新持锁者
 * 并发发出同一批相册，而且我们的 nextOffset 还会把它的断点覆盖回退。
 *
 * 返回续锁后的新凭据（claim_at 被改写成 now）：凭据随每次续锁滚动，调用方
 * 必须接住并用于后续 CAS，不能用抢锁时的旧值。
 */
async function persistPublicationProgress(
  env: PublicReportEnvironment,
  responseId: number,
  resumable: boolean,
  claimToken: string,
  progress: PublicReportProgress,
): Promise<string> {
  if (!resumable) return claimToken;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE survey_responses
        SET report_publication_progress=?, report_publication_claim_at=?, updated_at=?
      WHERE id=? AND report_publication_claim_at=?`,
  )
    .bind(JSON.stringify(progress), now, now, responseId, claimToken)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) throw new PublicationLockLostError(responseId);
  // 续锁把 claim_at 改写成了 now：凭据随之滚动，调用方必须用返回值更新自己
  // 手里的 token，否则下一次 CAS 会拿旧凭据比对新锁、误判成「锁已易主」。
  return now;
}

async function markPublicationPublished(
  env: PublicReportEnvironment,
  responseId: number,
  resumable: boolean,
  claimToken: string,
): Promise<void> {
  const now = new Date().toISOString();
  if (!resumable) {
    await env.DB.prepare(
      "UPDATE survey_responses SET report_publication_status='published', report_published_at=?, updated_at=? WHERE id=?",
    )
      .bind(now, now, responseId)
      .run();
    return;
  }
  // 断点保留：已发出的 message id 是"这份相册在频道里的位置"的唯一记录。
  // 终态也带 CAS：锁易主后抢写 published，会把新持锁者的进行中状态直接翻掉。
  const result = await env.DB.prepare(
    `UPDATE survey_responses
        SET report_publication_status='published', report_published_at=?,
            report_publication_claim_at=NULL, updated_at=?
      WHERE id=? AND report_publication_claim_at=?`,
  )
    .bind(now, now, responseId, claimToken)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) throw new PublicationLockLostError(responseId);
}

/**
 * 失败也要把状态写成 failed 并放掉锁。
 *
 * 这一步之后**必须**让异常继续往上抛：只有抛出去，队列才会重试（并从断点续发）。
 * 原实现的病症正是"部分成功 → messageIds 非空 → 不抛 → 写 published"。
 *
 * 同样带 CAS：锁已易主时**不写**——新持锁者正在发，会写下它自己的终态；我们
 * 抢写 failed 只会把它的 published 翻回去、或把它的活跃锁清掉。
 */
async function markPublicationFailed(
  env: PublicReportEnvironment,
  responseId: number,
  resumable: boolean,
  claimToken: string,
  progress: PublicReportProgress,
): Promise<void> {
  const now = new Date().toISOString();
  if (!resumable) {
    await env.DB.prepare("UPDATE survey_responses SET report_publication_status='failed', updated_at=? WHERE id=?")
      .bind(now, responseId)
      .run();
    return;
  }
  const result = await env.DB.prepare(
    `UPDATE survey_responses
        SET report_publication_status='failed', report_publication_claim_at=NULL,
            report_publication_progress=?, updated_at=?
      WHERE id=? AND report_publication_claim_at=?`,
  )
    .bind(JSON.stringify(progress), now, responseId, claimToken)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    console.warn("公开发布锁已易主，跳过失败标记（终态由新持锁者写）", { responseId });
  }
}

/**
 * 发一批（1–10 张）。
 *
 * Telegram 只显示 media group 里**第一张**的 caption，所以整批共用一条，挂在
 * 首图上；剩余图片不带 caption（带了也没人看得见，白占字符）。
 */
async function sendAlbumBatch(
  env: PublicReportEnvironment,
  delivery: { chatId: number; target: PublicReportTarget },
  pages: Uint8Array[],
  offset: number,
  caption: string,
): Promise<number[]> {
  const batch = pages.slice(offset, offset + PUBLIC_REPORT_ALBUM_BATCH_SIZE);
  const threadId = delivery.target.threadId ?? undefined;
  if (batch.length === 1) {
    // 单张走 sendPhoto：sendMediaGroup 要求 2–10 张，最后一页常常只剩 1 张。
    const result = await sendPhoto(env.BOT_TOKEN, delivery.chatId, batch[0]!, caption, undefined, threadId);
    const messageId = Number(((await result.json()) as { result?: { message_id?: number } }).result?.message_id);
    return Number.isInteger(messageId) ? [messageId] : [];
  }
  const result = await sendPhotoAlbum(
    env.BOT_TOKEN,
    delivery.chatId,
    batch.map((bytes, index) => ({ bytes, ...(index === 0 ? { caption } : {}) })),
    threadId,
  );
  const payload = (await result.json()) as { result?: Array<{ message_id?: number }> };
  return (payload.result ?? [])
    .map((item) => item.message_id)
    .filter((id): id is number => typeof id === "number" && Number.isInteger(id));
}

export async function publishPublicResponseReport(
  env: PublicReportEnvironment,
  responseId: number,
): Promise<PublicReportOutcome> {
  if (!env.BROWSER) throw new Error("BROWSER 未配置，无法生成公开报告图片");

  const { row: response, resumable } = await loadPublicationResponseRow(env.DB, responseId);
  if (!response || response.status !== "completed") throw new Error("答卷不存在或尚未完成");

  const targets = await resolvePublicReportTargets(env, response);
  if (!targets.length) throw new Error("Web 管理后台尚未配置公开报告发布目标");
  const deliveries = targets.map((target) => ({
    target,
    chatId: Number(target.chatId),
    messageIds: [] as number[],
  }));
  const invalid = deliveries.filter((delivery) => !Number.isInteger(delivery.chatId) || delivery.chatId === 0);
  if (invalid.length === deliveries.length) throw new Error("公开报告发布目标群组 ID 无效");
  for (const delivery of invalid) {
    console.warn("公开报告目标群组 ID 无效，已跳过", {
      responseId,
      targetId: delivery.target.id,
      chatId: delivery.target.chatId,
    });
  }
  const sendable = deliveries.filter((delivery) => !invalid.includes(delivery));

  if (response.report_publication_status === "published") {
    return {
      chatId: sendable[0]!.chatId,
      messageIds: [],
      pages: 0,
      targets: sendable.map((delivery) => ({ chatId: delivery.chatId, messageIds: [] })),
    };
  }

  let claimToken = await claimPublication(env, responseId, resumable, Date.now());
  if (claimToken === null) {
    console.warn("公开报告发布已在别处进行，跳过本次", { responseId });
    return {
      chatId: sendable[0]!.chatId,
      messageIds: [],
      pages: 0,
      targets: sendable.map((delivery) => ({ chatId: delivery.chatId, messageIds: [] })),
      skipped: true,
    };
  }

  const ctx = {
    db: env.DB,
    botToken: env.BOT_TOKEN,
    ...(env.BROWSER ? { browser: env.BROWSER } : {}),
    mediaKv: env.MEDIA_KV,
  } as unknown as BotContext;

  await waitForSiblingReportDelivery(env.DB, responseId);

  // 答卷级匿名：决定身份能不能被读取（报告图片与 caption 共用同一个判断）。
  const anonymous = isResponsePublishAnonymous(response);
  const quote: PublicReportCaptionInput = {
    surveyTitle: response.survey_title,
    anonymous,
    startedAt: response.started_at ? formatChinaDateTime(response.started_at) : null,
    completedAt: response.completed_at ? formatChinaDateTime(response.completed_at) : null,
    // 匿名时这里返回 null，且没有查过 users 表；buildPublicReportCaption 在
    // 匿名分支里也根本不读这个字段（双保险，见 public-report-caption.ts）。
    respondent: await loadPublicReportRespondentLabel(env, responseId, anonymous),
    message: normalizePublishMessage(response.publish_message),
  };
  const fullCaption = buildPublicReportCaption(quote);

  const progress: PublicReportProgress = parsePublicReportProgress(response.report_publication_progress) ?? {
    pages: 0,
    mode: "album",
    targets: {},
  };
  const messageIds: number[] = [];
  const failures: Array<{ chatId: number; error: Error }> = [];
  let pages = progress.pages;

  /** 取（或建立）某目标的断点，并把已发出的 id 汇总进返回值。 */
  const entryFor = (chatId: number, threadId: number | null): PublicReportTargetProgress => {
    const key = publicationProgressKey(chatId, threadId);
    const entry = progress.targets[key] ?? { messageIds: [], nextOffset: 0, done: false };
    progress.targets[key] = entry;
    for (const id of entry.messageIds) if (!messageIds.includes(id)) messageIds.push(id);
    return entry;
  };

  let rendered: Uint8Array[] | null = null;
  try {
    const { artifact } = await renderPublicReportArtifact(
      env,
      ctx,
      responseId,
      response.survey_id,
      anonymous,
      // caption 与报告图片共用同一个公开面标签：匿名 → null（渲染成「匿名」），
      // 实名 → 只有姓名/@username，数字 Telegram ID 到不了公开频道。
      quote.respondent ?? null,
    );
    if (artifact.format !== "png" || artifact.pages.length === 0) throw new Error("公开报告没有生成图片页面");
    rendered = artifact.pages.map((page) => page.bytes);
    if (pages > 0 && pages !== rendered.length) {
      // 同一份答卷两次渲染页数不同（模板/图片加载抖动）。断点按页号记账，页数一变
      // 旧 offset 就指向了别的页——只能整份重发并留痕，不能猜。
      console.warn("公开报告页数与上次不一致，断点作废并重发", {
        responseId,
        previousPages: pages,
        pages: rendered.length,
      });
      progress.targets = {};
      messageIds.length = 0;
    }
    pages = rendered.length;
    progress.pages = pages;
    progress.mode = "album";
    // 渲染可能耗时数分钟（等兄弟任务 + 浏览器闸门 + 重试间隔），远超 5 分钟锁
    // TTL。发送第一批之前先落一次断点，既把「页数」记账，也把锁续期——否则
    // 长渲染刚结束锁就过期了，第一个并发窗口恰恰开在发送开始的地方。
    claimToken = await persistPublicationProgress(env, responseId, resumable, claimToken, progress);
  } catch (error) {
    // The album needs a fresh browser session and the account's browser
    // acquisition budget is often exhausted (429/503/TargetClose). The archive
    // delivery has already rendered the PDF for this response — send that
    // instead so the publication still reaches the group.
    //
    // 但只在**还没发过任何相册批次**时允许降级：已经发出去半份相册再补一份 PDF，
    // 频道里就是"前 10 页 + 一份完整 PDF"，比留个断点等重试更糟。
    const alreadySendingAlbum =
      progress.mode === "album" &&
      Object.values(progress.targets).some((entry) => entry.nextOffset > 0 || entry.messageIds.length > 0);
    if (!isTransientRenderError(error) || alreadySendingAlbum) {
      await markPublicationFailed(env, responseId, resumable, claimToken, progress);
      throw error;
    }
    console.warn("Public report album unavailable; falling back to the archived PDF", {
      responseId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    // KV 读本身也可能失败（配额/绑定）；那样也走"标记失败并抛"，不能留下
    // 一个挂着锁、状态停在 pending 的僵尸行。
    let pdf: ArrayBuffer | null = null;
    try {
      pdf = (await env.MEDIA_KV?.get(`public-report-pdf:${responseId}`, { type: "arrayBuffer" })) ?? null;
    } catch (kvError) {
      console.warn("公开报告 PDF 回退读取失败", {
        responseId,
        error: kvError instanceof Error ? kvError.message : String(kvError),
      });
    }
    if (!pdf) {
      await markPublicationFailed(env, responseId, resumable, claimToken, progress);
      throw error;
    }
    // 降级也必须带上同样的「问卷名 + 填写时间 + 留言」：这条消息在频道里的
    // 用途正是区分"哪份问卷的哪一次填写"，降级不该把它丢掉。
    // 再兜一次上限：caption 本体已按 1024 截断，追加这句后仍可能越界。
    const pdfCaption = clampPublicReportCaption(`${fullCaption}\n\n（浏览器渲染额度受限，本次以 PDF 文件发布）`);
    pages = 1;
    progress.pages = 1;
    progress.mode = "pdf";
    for (const delivery of sendable) {
      const entry = entryFor(delivery.chatId, delivery.target.threadId);
      if (entry.done) continue;
      try {
        const response = await sendDocument(
          env.BOT_TOKEN,
          delivery.chatId,
          `report-${responseId}.pdf`,
          new Uint8Array(pdf),
          "application/pdf",
          pdfCaption,
          undefined,
          delivery.target.threadId ?? undefined,
        );
        const messageId = Number(((await response.json()) as { result?: { message_id?: number } }).result?.message_id);
        if (Number.isInteger(messageId)) {
          entry.messageIds.push(messageId);
          messageIds.push(messageId);
        }
        entry.nextOffset = 1;
        entry.done = true;
        delete entry.error;
        claimToken = await persistPublicationProgress(env, responseId, resumable, claimToken, progress);
      } catch (sendError) {
        // 锁已易主：停手并把控制权交给新持锁者，不标记失败、不换下一个目标。
        if (sendError instanceof PublicationLockLostError) throw sendError;
        const failure = sendError instanceof Error ? sendError : new Error(String(sendError));
        entry.error = failure.message;
        failures.push({ chatId: delivery.chatId, error: failure });
        claimToken = await persistPublicationProgress(env, responseId, resumable, claimToken, progress);
      }
    }
  }

  if (rendered) {
    for (const delivery of sendable) {
      const entry = entryFor(delivery.chatId, delivery.target.threadId);
      if (entry.done) continue;
      for (let offset = entry.nextOffset; offset < pages; offset += PUBLIC_REPORT_ALBUM_BATCH_SIZE) {
        const pageStart = offset + 1;
        const pageEnd = Math.min(offset + PUBLIC_REPORT_ALBUM_BATCH_SIZE, pages);
        const caption = buildPublicReportBatchCaption(quote, { pageStart, pageEnd, totalPages: pages });
        try {
          const ids = await sendAlbumBatch(env, delivery, rendered, offset, caption);
          entry.messageIds.push(...ids);
          messageIds.push(...ids);
          entry.nextOffset = pageEnd;
          entry.done = pageEnd >= pages;
          delete entry.error;
          // 每批立刻落盘：这一行是「下次从哪续」的唯一真相。进程在下一批中途
          // 消失时，已发出的批次不会重发。
          claimToken = await persistPublicationProgress(env, responseId, resumable, claimToken, progress);
        } catch (sendError) {
          // 锁已易主：立刻停手。继续发下去会同新持锁者并发发出同一批相册，
          // 而且把它的断点覆盖回退；失败标记也留给它写。
          if (sendError instanceof PublicationLockLostError) throw sendError;
          const failure = sendError instanceof Error ? sendError : new Error(String(sendError));
          console.warn("公开报告批次发送失败", {
            responseId,
            chatId: delivery.chatId,
            threadId: delivery.target.threadId,
            pageStart,
            pageEnd,
            pages,
            error: failure.message,
          });
          entry.error = failure.message;
          failures.push({ chatId: delivery.chatId, error: failure });
          claimToken = await persistPublicationProgress(env, responseId, resumable, claimToken, progress);
          // 只停这个目标：其它群组不该因为一个群发不出去而一起挨饿。
          break;
        }
      }
    }
  }

  const complete = sendable.every(
    (delivery) => progress.targets[publicationProgressKey(delivery.chatId, delivery.target.threadId)]?.done === true,
  );

  if (failures.length || !complete) {
    console.warn("公开报告部分目标发送失败", {
      responseId,
      failures: failures.map(({ chatId, error }) => ({ chatId, error: error.message })),
      progress: progress.targets,
    });
    await markPublicationFailed(env, responseId, resumable, claimToken, progress);
    // 抛出才会让队列重试；重试从断点续发，已成功的批次不会重发。
    // 静默吞掉正是「频道只有前 10 页、后台却显示已发布」的成因。
    throw failures[0]?.error ?? new Error("公开发布未完成：仍有批次未发出");
  }

  await markPublicationPublished(env, responseId, resumable, claimToken);

  return {
    chatId: sendable[0]!.chatId,
    messageIds,
    pages,
    targets: sendable.map((delivery) => ({
      chatId: delivery.chatId,
      messageIds: progress.targets[publicationProgressKey(delivery.chatId, delivery.target.threadId)]?.messageIds ?? [],
    })),
  };
}
