import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { BotContext } from "../bot/types";
import { addReportImages, buildResponseReportBundle } from "../bot/survey-report";
import { renderResponseReport, type PngViewportStrategy } from "./response-report.service";
import { sendDocument, sendMessage, sendPhoto, sendPhotoAlbum } from "../bot/telegram";
import {
  getDefaultPublicationTarget,
  listEnabledPublicationTargets,
} from "../db/repositories/publication-target.repository";

export interface PublicReportEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  BROWSER?: BrowserWorker;
  MEDIA_KV?: KVNamespace;
}

function caption(report: Awaited<ReturnType<typeof buildResponseReportBundle>>["report"]): string {
  const title = report.surveyTitle?.trim() || "问卷";
  const respondent = report.respondent?.trim() || "匿名填写者";
  return [
    "📋 问卷报告",
    "",
    `问卷：${title.slice(0, 180)}`,
    `填写者：${respondent.slice(0, 120)}`,
    report.completedAt ? `完成时间：${report.completedAt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
): Promise<{
  artifact: Awaited<ReturnType<typeof renderResponseReport>>;
  report: Awaited<ReturnType<typeof buildResponseReportBundle>>["report"];
}> {
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await sleep(RENDER_ATTEMPT_DELAYS_MS[Math.min(attempt - 1, RENDER_ATTEMPT_DELAYS_MS.length - 1)]!);
    await waitUntilBrowserAcquisitionAllowed(env, responseId);
    const strategy = RENDER_STRATEGIES[Math.min(attempt, RENDER_STRATEGIES.length - 1)] as PngViewportStrategy;
    try {
      const bundle = await buildResponseReportBundle(ctx, surveyId, responseId, responseId);
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

export async function publishPublicResponseReport(
  env: PublicReportEnvironment,
  responseId: number,
): Promise<{
  chatId: number;
  messageIds: number[];
  pages: number;
  targets: Array<{ chatId: number; messageIds: number[]; error?: string }>;
}> {
  if (!env.BROWSER) throw new Error("BROWSER 未配置，无法生成公开报告图片");

  const response = await env.DB.prepare(
    "SELECT id, survey_id, status, report_publication_status, publication_target_id, publication_target_chat_id, publication_target_thread_id FROM survey_responses WHERE id=? LIMIT 1",
  )
    .bind(responseId)
    .first<PublicReportResponseRow>();
  if (!response || response.status !== "completed") throw new Error("答卷不存在或尚未完成");

  const targets = await resolvePublicReportTargets(env, response);
  if (!targets.length) throw new Error("Web 管理后台尚未配置公开报告发布目标");
  const deliveries = targets.map((target) => ({ target, chatId: Number(target.chatId), messageIds: [] as number[] }));
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

  const ctx = {
    db: env.DB,
    botToken: env.BOT_TOKEN,
    browser: env.BROWSER,
    mediaKv: env.MEDIA_KV,
  } as unknown as BotContext;

  await waitForSiblingReportDelivery(env.DB, responseId);
  const messageIds: number[] = [];
  let pages = 0;
  let textCaption = "";
  const failures: Array<{ delivery: (typeof sendable)[number]; error: Error }> = [];

  const sendToTarget = async (delivery: (typeof sendable)[number], bytes: Uint8Array[], captionText: string) => {
    const threadId = delivery.target.threadId ?? undefined;
    for (let offset = 0; offset < bytes.length; offset += 10) {
      const pageBytes = bytes.slice(offset, offset + 10);
      if (pageBytes.length === 1) {
        const result = await sendPhoto(env.BOT_TOKEN, delivery.chatId, pageBytes[0]!, captionText, undefined, threadId);
        const messageId = Number(((await result.json()) as { result?: { message_id?: number } }).result?.message_id);
        if (Number.isInteger(messageId)) {
          delivery.messageIds.push(messageId);
          messageIds.push(messageId);
        }
      } else {
        const result = await sendPhotoAlbum(
          env.BOT_TOKEN,
          delivery.chatId,
          pageBytes.map((page, index) => ({
            bytes: page,
            ...(index === 0 && offset === 0 ? { caption: captionText } : {}),
          })),
          threadId,
        );
        const payload = (await result.json()) as { result?: Array<{ message_id?: number }> };
        for (const item of payload.result ?? []) {
          if (Number.isInteger(item.message_id)) {
            delivery.messageIds.push(item.message_id!);
            messageIds.push(item.message_id!);
          }
        }
      }
    }
  };

  try {
    const { artifact, report } = await renderPublicReportArtifact(env, ctx, responseId, response.survey_id);
    if (artifact.format !== "png" || artifact.pages.length === 0) throw new Error("公开报告没有生成图片页面");
    textCaption = caption(report);
    pages = artifact.pages.length;

    for (const delivery of sendable) {
      try {
        await sendToTarget(
          delivery,
          artifact.pages.map((page) => page.bytes),
          textCaption,
        );
      } catch (error) {
        failures.push({ delivery, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  } catch (error) {
    // The album needs a fresh browser session and the account's browser
    // acquisition budget is often exhausted (429/503/TargetClose). The archive
    // delivery has already rendered the PDF for this response — send that
    // instead so the publication still reaches the group.
    if (!isTransientRenderError(error)) throw error;
    console.warn("Public report album unavailable; falling back to the archived PDF", {
      responseId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    const pdf = await env.MEDIA_KV?.get(`public-report-pdf:${responseId}`, { type: "arrayBuffer" });
    if (!pdf) throw error;
    textCaption = "📋 问卷报告（浏览器渲染额度受限，本次以 PDF 文件发布）";
    pages = 1;
    for (const delivery of sendable) {
      try {
        const response = await sendDocument(
          env.BOT_TOKEN,
          delivery.chatId,
          `report-${responseId}.pdf`,
          new Uint8Array(pdf),
          "application/pdf",
          textCaption,
          undefined,
          delivery.target.threadId ?? undefined,
        );
        const messageId = Number(((await response.json()) as { result?: { message_id?: number } }).result?.message_id);
        if (Number.isInteger(messageId)) {
          delivery.messageIds.push(messageId);
          messageIds.push(messageId);
        }
      } catch (error) {
        failures.push({ delivery, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  }

  if (failures.length) {
    console.warn("公开报告部分目标发送失败", {
      responseId,
      failures: failures.map(({ delivery, error }) => ({
        chatId: delivery.target.chatId,
        threadId: delivery.target.threadId,
        error: error.message,
      })),
    });
    // 一个都没发出去才让队列重试；部分成功时不重试，否则已经收到的群会再收一遍同一份相册。
    if (!messageIds.length) throw failures[0]!.error;
  }

  await env.DB.prepare(
    "UPDATE survey_responses SET report_publication_status='published', report_published_at=?, updated_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), new Date().toISOString(), responseId)
    .run();

  return {
    chatId: sendable[0]!.chatId,
    messageIds,
    pages,
    targets: sendable.map((delivery) => ({ chatId: delivery.chatId, messageIds: delivery.messageIds })),
  };
}
