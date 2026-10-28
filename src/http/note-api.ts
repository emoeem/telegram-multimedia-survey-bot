import type { Env } from "../index";
import { fail, json } from "./api-response";
import { resolveParticipant } from "./survey/participant";
import { checkAtomicRateLimit, rateLimitResponse } from "../services/rate-limit.service";
import { getCoinAccountOrCreate } from "../services/coin/ledger.service";
import {
  DRAW_COST_COINS,
  FREE_DRAWS_PER_DAY,
  REPORT_HIDE_THRESHOLD,
  drawNote,
  getMyActiveNote,
  listMessages,
  listThreads,
  putNote,
  reportNote,
  sendMessage,
  withdrawNote,
  type NoteError,
} from "../services/note-chat.service";
import { createMediaAsset, getMediaAssetById } from "../db/repositories/media.repository";
import { createMediaStore } from "../services/media/temporary-media-store";
import { verifyUploadContent } from "../services/media/upload-validation.service";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { loadAdminSessionEpoch } from "../services/system-settings.service";
import { ADMIN_SESSION_COOKIE, resolveSessionSecret, verifyAdminSessionValue } from "../services/admin-session.service";

/**
 * 纸条聊天 · 用户侧 API（/api/note/*）。
 *
 * 身份与金币同一套参与者解析（TG init-data / 邮箱会话 / 浏览器 key）。
 * 写路径全部过原子限流；媒体复用树洞那套「KV/R2 + 读取侧鉴权」模式：
 * media_assets 的 scope CHECK 放不下新值，纸条图 = response scope +
 * `media:note:` 前缀，且一张图只能被一张纸条或一条消息用一次。
 */

const NOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const NOTE_IMAGE_STORAGE_PREFIX = "media:note:";
const NOTE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

function isNoteError(error: unknown): error is NoteError {
  return Boolean(error) && typeof error === "object" && "code" in (error as Record<string, unknown>);
}

function noteFail(error: NoteError): Response {
  const status = error.code === "not_found" || error.code === "not_participant" ? 404 : 400;
  return fail(status, error.code, error.message);
}

function adminIdsOf(env: Env): number[] {
  return String(env.ADMIN_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function hasValidAdminSession(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (!cookie) return false;
  const epoch = await loadAdminSessionEpoch(env.DB);
  const userId = await verifyAdminSessionValue(
    resolveSessionSecret(env),
    cookie.slice(ADMIN_SESSION_COOKIE.length + 1),
    epoch,
  );
  return userId !== null && adminIdsOf(env).includes(userId);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asAssetId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** 这张图是否属于「我」可见的纸条上下文（我是纸条主人 / 抽中者 / 会话参与者）。 */
async function canViewNoteImage(db: D1Database, assetId: number, participantHash: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT (
         EXISTS(SELECT 1 FROM notes n WHERE n.image_asset_id = ?2
                 AND (n.owner_hash = ?1 OR EXISTS(
                      SELECT 1 FROM note_threads t WHERE t.note_id = n.id AND t.drawer_hash = ?1)))
         OR EXISTS(
            SELECT 1 FROM note_messages m
              JOIN note_threads t ON t.id = m.thread_id
              JOIN notes n ON n.id = t.note_id
             WHERE m.image_asset_id = ?2 AND (t.drawer_hash = ?1 OR n.owner_hash = ?1))
       ) AS allowed`,
    )
    .bind(participantHash, assetId)
    .first<{ allowed: number }>();
  return Number(row?.allowed ?? 0) > 0;
}

/** 上传纸条配图。与树洞同规：图片 MIME + 字节签名双校验，5MB 上限，5 张/小时。 */
async function handleNoteMediaUpload(request: Request, env: Env): Promise<Response> {
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const limit = await checkAtomicRateLimit(env.DB, env.CACHE, "note-media", participant.participantHash, 5, 3600);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return fail(400, "bad_request", "缺少图片文件");
  const mimeType = (file.type || "").toLowerCase();
  if (!NOTE_IMAGE_MIME_TYPES.has(mimeType)) return fail(400, "bad_image", "只支持 JPG / PNG / WebP / GIF 图片");
  if (file.size <= 0 || file.size > NOTE_IMAGE_MAX_BYTES) return fail(400, "bad_image", "图片需在 5MB 以内");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const verified = verifyUploadContent(bytes, mimeType);
  if (!verified.ok) return fail(400, "bad_image", verified.reason ?? "图片内容无法识别");
  const store = createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV });
  const storageKey = `${NOTE_IMAGE_STORAGE_PREFIX}${crypto.randomUUID()}`;
  await store.put({ storageKey, bytes, contentType: mimeType });
  const asset = await createMediaAsset(env.DB, {
    scope: "response",
    mediaType: "photo",
    storageKind: store.kind,
    storageKey,
    expiresAt: null,
    mimeType,
    fileName: file.name || null,
    fileSize: bytes.byteLength,
  });
  return json({ ok: true, assetId: asset.id });
}

/** GET /api/note/media/:id —— 只有纸条上下文里的人才读得到。 */
async function serveNoteMedia(request: Request, env: Env, assetId: number): Promise<Response> {
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const asset = await getMediaAssetById(env.DB, assetId);
  if (!asset) return fail(404, "not_found", "图片不存在");
  const isNoteImage = asset.scope === "response" && (asset.storageKey?.startsWith(NOTE_IMAGE_STORAGE_PREFIX) ?? false);
  if (!isNoteImage || !(await canViewNoteImage(env.DB, assetId, participant.participantHash))) {
    return fail(404, "not_found", "图片不存在");
  }
  return (await buildMediaResponse(env, asset)) ?? fail(404, "not_found", "图片已清理");
}

/** 管理端：按状态列纸条（隐藏/被举报优先）。 */
async function adminListNotes(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get("status") ?? "hidden";
  const allowed = ["hidden", "active", "removed", "expired", "withdrawn"];
  if (!allowed.includes(status)) return fail(400, "bad_request", "未知状态");
  const result = await env.DB.prepare(
    `SELECT id, gender, age_band AS ageBand, region, content, status, report_count AS reportCount,
            created_at AS createdAt, expires_at AS expiresAt
       FROM notes WHERE status = ? ORDER BY report_count DESC, id DESC LIMIT 50`,
  )
    .bind(status)
    .all();
  return json({ ok: true, notes: result.results ?? [] });
}

/** 管理端：改状态（恢复/移除）。恢复撞「1 人 1 张」唯一索引时给出明确错误。 */
async function adminSetNoteStatus(env: Env, noteId: number, status: string): Promise<Response> {
  if (!["active", "removed"].includes(status)) return fail(400, "bad_request", "目标状态仅支持 active / removed");
  try {
    const result = await env.DB.prepare(`UPDATE notes SET status = ? WHERE id = ?`).bind(status, noteId).run();
    if (Number(result.meta?.changes ?? 0) === 0) return fail(404, "not_found", "纸条不存在");
    return json({ ok: true });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message ?? ""))) {
      return fail(409, "owner_has_new_note", "作者已放了新纸条，不能恢复这张");
    }
    throw error;
  }
}

export async function handleNoteApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  /** coin-api 同款的兜底包装：业务错误转结构化 JSON，未知错误记日志后统一 500。 */
  const respond = async <T>(handler: () => Promise<T>): Promise<Response> => {
    try {
      return json(await handler());
    } catch (error) {
      if (isNoteError(error)) return noteFail(error);
      if (error instanceof Error && error.name === "CoinLedgerError") {
        const code = (error as { code?: string }).code;
        if (code === "insufficient_funds") return fail(402, "insufficient_coins", error.message);
        return fail(400, code ?? "coin_error", error.message);
      }
      console.error("Note API failed", { path, error });
      return fail(500, "internal", "服务暂时不可用，请稍后再试");
    }
  };

  /* ---- 媒体（上传/读取），与消息同权限模型 ---- */
  if (request.method === "POST" && path === "/api/note/media") return handleNoteMediaUpload(request, env);
  const mediaMatch = path.match(/^\/api\/note\/media\/(\d+)$/);
  if (request.method === "GET" && mediaMatch) return serveNoteMedia(request, env, Number(mediaMatch[1]));

  /* ---- 管理端 ---- */
  if (path.startsWith("/api/note/admin/")) {
    if (!(await hasValidAdminSession(request, env))) return fail(401, "unauthorized", "需要管理员会话");
    if (request.method === "GET" && path === "/api/note/admin/notes") return adminListNotes(env, url);
    const statusMatch = path.match(/^\/api\/note\/admin\/notes\/(\d+)\/status$/);
    if (request.method === "POST" && statusMatch) {
      const body = await readJsonBody(request);
      return adminSetNoteStatus(env, Number(statusMatch[1]), asString(body?.status));
    }
    return fail(404, "not_found", "未知管理端点");
  }

  /* ---- 用户侧：全部要求参与者身份 ---- */
  const participant = await resolveParticipant(request, env);
  if (participant instanceof Response) return participant;
  const hash = participant.participantHash;

  if (request.method === "GET" && path === "/api/note/me") {
    return respond(async () => {
      const note = await getMyActiveNote(env.DB, hash);
      const account = await getCoinAccountOrCreate(env.DB, hash, participant.dbUserId);
      return {
        ok: true,
        note,
        balance: account.balance,
        freeDrawsPerDay: FREE_DRAWS_PER_DAY,
        drawCostCoins: DRAW_COST_COINS,
        reportHideThreshold: REPORT_HIDE_THRESHOLD,
      };
    });
  }

  if (request.method === "POST" && path === "/api/note") {
    const limit = await checkAtomicRateLimit(env.DB, env.CACHE, "note-put", hash, 3, 3600);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const body = await readJsonBody(request);
    return respond(async () => {
      const note = await putNote(
        env.DB,
        hash,
        {
          gender: asString(body?.gender),
          ageBand: asString(body?.ageBand),
          region: asString(body?.region),
          content: asString(body?.content),
        },
        asAssetId(body?.imageAssetId),
      );
      return { ok: true, note };
    });
  }

  if (request.method === "DELETE" && path === "/api/note/me") {
    return respond(async () => ({ ok: true, withdrawn: await withdrawNote(env.DB, hash) }));
  }

  if (request.method === "POST" && path === "/api/note/draw") {
    // 双层限流：3 次/分钟挡手抖，30 次/天封顶兜住免费+付费的总消耗节奏。
    const perMinute = await checkAtomicRateLimit(env.DB, env.CACHE, "note-draw-min", hash, 3, 60);
    if (!perMinute.allowed) return rateLimitResponse(perMinute.retryAfterSeconds);
    const perDay = await checkAtomicRateLimit(env.DB, env.CACHE, "note-draw-day", hash, 30, 86_400);
    if (!perDay.allowed) return rateLimitResponse(perDay.retryAfterSeconds);
    const body = await readJsonBody(request);
    const idem = asString(body?.idempotencyKey);
    return respond(async () => {
      const result = await drawNote(env.DB, hash, participant.dbUserId ?? null, idem);
      return { ...result };
    });
  }

  if (request.method === "GET" && path === "/api/note/threads") {
    return respond(async () => ({ ok: true, threads: await listThreads(env.DB, hash) }));
  }

  const messagesMatch = path.match(/^\/api\/note\/threads\/(\d+)\/messages$/);
  if (messagesMatch) {
    const threadId = Number(messagesMatch[1]);
    if (request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      return respond(async () => {
        const result = await listMessages(env.DB, threadId, hash, Number.isFinite(after) ? after : 0);
        if (!result) return fail(404, "not_found", "会话不存在");
        return { ok: true, ...result };
      });
    }
    if (request.method === "POST") {
      const limit = await checkAtomicRateLimit(env.DB, env.CACHE, "note-msg", hash, 10, 60);
      if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
      const body = await readJsonBody(request);
      return respond(async () => {
        const message = await sendMessage(env.DB, threadId, hash, asString(body?.body), asAssetId(body?.imageAssetId));
        return { ok: true, message };
      });
    }
  }

  const reportMatch = path.match(/^\/api\/note\/(\d+)\/report$/);
  if (request.method === "POST" && reportMatch) {
    const limit = await checkAtomicRateLimit(env.DB, env.CACHE, "note-report", hash, 5, 3600);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const body = await readJsonBody(request);
    return respond(async () => ({
      ok: true,
      ...(await reportNote(env.DB, Number(reportMatch[1]), hash, asString(body?.reason))),
    }));
  }

  return fail(404, "not_found", "未知纸条端点");
}
