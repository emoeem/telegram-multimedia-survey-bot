/**
 * 后台的网页投稿审核 —— 并轨后的本地实现。
 *
 * 历史:这组接口曾把「管理员会话 → 共享密钥」再转发给独立的 submission-bot
 * Worker(x-review-secret + /api/admin/review/*)。数据迁进本站 D1
 * (migration 0088)后,转发链整体退役:浏览器仍然只认本站 admin 会话
 * (routeAdminApi 在上游已校验 isAdmin),之后直接读写本站表。
 *
 * 对外 HTTP 契言与旧转发版逐字段一致(list/detail/count/approve/reject/reply/
 * media 的路径、参数、响应结构),前端 WebSubmissionsPage 零改动。
 *
 * 语义变化只有两处,都有意为之:
 *   approve 的「发布」:旧 = 把投稿发到 Telegram 频道;新 = 状态机
 *   pending → published(可选向 publishChannelId 推送一条提醒,由运营配置,
 *   默认不发)。「公开发布」的产品语义已由本站内容面(广场/抽卡池)承接,
 *   Telegram 频道不再是必经链路。
 *   media 的取件:新投稿的附件是本站 media_assets(scope=web_submission),
 *   直接从 MEDIA/M2 读;迁移来的旧数据是旧机器人的 file_id,用
 *   SUBMISSION_BOT_LEGACY_TOKEN 只读代取 —— 该 token 只用于 getFile + 文件
 *   下载,没有任何写能力。
 */
import type { Env } from "../../index";
import { sendMessage } from "../../bot/telegram";
import { WebSubmitStore, type WebSubmissionRow, type WebSubmissionStatus } from "../../services/submit/store";
import { getMediaAssetById } from "../../db/repositories/media.repository";
import { createMediaStore } from "../../services/media/temporary-media-store";
import {
  DEFAULT_WEB_SUBMIT_FORM,
  attachmentsOf,
  composeWebSubmissionText,
  loadWebSubmitFormSetting,
  type WebSubmitStep,
} from "../../services/submit/form-config";

/** 本模块管辖的路径前缀。和 `/api/admin/submissions`(金币投稿)不冲突。 */
export const WEB_SUBMISSION_PREFIX = "/api/admin/web-submissions";

export function isWebSubmissionAdminPath(pathname: string): boolean {
  return pathname === WEB_SUBMISSION_PREFIX || pathname.startsWith(`${WEB_SUBMISSION_PREFIX}/`);
}

/** 管理端预览的媒体硬上限(照搬旧 MAX_WEB_MEDIA_BYTES)。 */
const MAX_REVIEW_MEDIA_BYTES = 20 * 1024 * 1024;

const STATUSES = new Set<WebSubmissionStatus>(["pending", "published", "rejected", "publishing", "failed", "recalled"]);

export interface WebSubmissionAdminContext {
  isAdmin: boolean;
  fail: (status: number, code: string, message: string) => Response;
  json: (body: unknown) => Response;
}

interface ReviewDetail {
  id: number;
  status: WebSubmissionStatus;
  templateId: string;
  nickname: string;
  fullName: string;
  email: string;
  ip: string;
  flags: string[];
  createdAt: number | null;
  publishedAt: number | null;
  attachments: Array<{ kind: string; name: string | null }>;
  text: string;
}

/** 把一条投稿摊平成前端能直接渲染的审核详情(对齐旧 bot.webReviewDetail)。 */
function reviewDetail(row: WebSubmissionRow, steps: WebSubmitStep[]): ReviewDetail {
  const data = row.data;
  return {
    id: row.id,
    status: row.status,
    templateId: row.templateId,
    nickname: typeof data.__nickname === "string" ? data.__nickname : "",
    fullName: row.nickname ?? "",
    email: row.email ?? "",
    ip: row.ip ?? "",
    flags: row.flags,
    createdAt: row.createdAt || null,
    publishedAt: row.publishedAt || null,
    attachments: attachmentsOf(data, steps).map((item) => ({
      kind: item.kind,
      name: item.name ?? null,
    })),
    text: composeWebSubmissionText({ ...DEFAULT_WEB_SUBMIT_FORM, steps }, data, row.id),
  };
}

function parseId(raw: string | null): number | null {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function clampLimit(raw: string | null, fallback = 20, max = 100): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 1), max);
}

/**
 * 处理一次后台网页投稿审核请求。返回 null 表示「不是这条路径」。
 */
export async function handleWebSubmissionAdmin(
  request: Request,
  url: URL,
  env: Env,
  ctx: WebSubmissionAdminContext,
): Promise<Response | null> {
  if (!isWebSubmissionAdminPath(url.pathname)) return null;

  /* 这条链是管理端专用:网页投稿审核是平台级操作,不下放给试用账号。 */
  if (!ctx.isAdmin) {
    return ctx.fail(403, "admin_access_denied", "只有管理员可以审核网页投稿。");
  }

  const suffix = url.pathname.slice(WEB_SUBMISSION_PREFIX.length);
  const allowed = new Set(["/list", "/detail", "/count", "/approve", "/reject", "/reply", "/media"]);
  if (!allowed.has(suffix)) return ctx.fail(404, "unknown_review_action", "未知的审核操作。");

  const store = new WebSubmitStore(env.DB);
  const config = await loadWebSubmitFormSetting(env.DB);

  try {
    if (suffix === "/count" && request.method === "GET") {
      const pending = await store.countForReview("pending");
      const total = await store.countForReview();
      return ctx.json({ ok: true, pending, total });
    }

    if (suffix === "/list" && request.method === "GET") {
      const statusParam = url.searchParams.get("status");
      const status =
        statusParam && STATUSES.has(statusParam as WebSubmissionStatus) ? (statusParam as WebSubmissionStatus) : null;
      const limit = clampLimit(url.searchParams.get("limit"), 20, 100);
      const offset = Math.max(parseId(url.searchParams.get("offset")) ?? 0, 0);
      const [rows, total] = await Promise.all([
        store.listForReview({ status, limit, offset }),
        store.countForReview(status),
      ]);
      return ctx.json({
        ok: true,
        total,
        limit,
        offset,
        items: rows.map((row) => {
          const detail = reviewDetail(row, config.steps);
          return {
            id: detail.id,
            status: detail.status,
            nickname: detail.nickname,
            fullName: detail.fullName,
            email: detail.email,
            flags: detail.flags,
            createdAt: detail.createdAt,
            publishedAt: detail.publishedAt,
            attachments: detail.attachments,
            preview: detail.text.slice(0, 160),
          };
        }),
      });
    }

    if (suffix === "/detail" && request.method === "GET") {
      const id = parseId(url.searchParams.get("id"));
      if (id === null) return ctx.fail(400, "invalid_id", "缺少投稿编号");
      const row = await store.getSubmission(id);
      if (!row) return ctx.fail(404, "not_found", "找不到这条投稿");
      return ctx.json({ ok: true, submission: reviewDetail(row, config.steps) });
    }

    if (suffix === "/media" && request.method === "GET") {
      return handleReviewMedia(url, env, ctx, store);
    }

    if (suffix === "/approve" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
      const id = parseId(String(body?.id ?? ""));
      if (id === null) return ctx.fail(400, "invalid_id", "缺少投稿编号");
      const row = await store.getSubmission(id);
      if (!row) return ctx.fail(404, "not_found", "找不到这条投稿");
      if (row.status === "published") {
        return ctx.fail(409, "already_published", "这条投稿已经发布过了");
      }
      /* CAS:并发双击/两处同时通过,只有一方能把 pending/failed 翻成 published。 */
      const won = await store.setStatus(id, "published", ["pending", "failed", "publishing"]);
      if (!won) {
        const fresh = await store.getSubmission(id);
        return ctx.fail(
          409,
          fresh?.status === "published" ? "already_published" : "in_flight",
          fresh?.status === "published" ? "这条投稿已经发布过了" : "这条投稿现在不能通过",
        );
      }
      /* 可选推送:运营在表单配置里填 publishChannelId 时,通过后往频道发一条
       * 摘要(链接进投稿详情)。发送失败不回滚状态——公开性的本体在站内。 */
      const channelId = Number(config.publishChannelId);
      let link: string | null = null;
      if (Number.isInteger(channelId) && channelId !== 0) {
        try {
          const text = composeWebSubmissionText(config, row.data, id);
          const sent = await sendMessage(env.BOT_TOKEN, channelId, text.slice(0, 4000));
          const payload = (await sent.json()) as { result?: { message_id?: number } };
          const messageId = payload?.result?.message_id;
          if (messageId) link = `https://t.me/c/${String(channelId).slice(4)}/${messageId}`;
        } catch (error) {
          console.warn("web submission channel push failed", { id, error: String(error) });
        }
      }
      await store.addThreadMessage(id, "to_author", "你的投稿已通过审核 ✅");
      return ctx.json({ ok: true, id, link });
    }

    if (suffix === "/reject" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { id?: unknown; reason?: unknown } | null;
      const id = parseId(String(body?.id ?? ""));
      if (id === null) return ctx.fail(400, "invalid_id", "缺少投稿编号");
      const reason = String(body?.reason ?? "").trim();
      if (reason.length > 300) return ctx.fail(422, "reason_too_long", "理由最多 300 字");
      const row = await store.getSubmission(id);
      if (!row) return ctx.fail(404, "not_found", "找不到这条投稿");
      if (row.status === "published") {
        return ctx.fail(409, "already_published", "这条投稿已经发布，不能直接驳回；如需下架请单独处理");
      }
      const won = await store.setStatus(id, "rejected", ["pending", "failed"]);
      if (!won) {
        const fresh = await store.getSubmission(id);
        return ctx.fail(409, fresh?.status === "rejected" ? "already_rejected" : "in_flight", "这条投稿现在不能驳回");
      }
      if (reason) await store.addThreadMessage(id, "to_author", `你的投稿未通过审核：${reason}`);
      return ctx.json({ ok: true, id });
    }

    if (suffix === "/reply" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { id?: unknown; text?: unknown } | null;
      const id = parseId(String(body?.id ?? ""));
      if (id === null) return ctx.fail(400, "invalid_id", "缺少投稿编号");
      const text = String(body?.text ?? "").trim();
      if (!text) return ctx.fail(422, "empty_text", "内容不能为空");
      if (text.length > 800) return ctx.fail(422, "text_too_long", "最多 800 字");
      const row = await store.getSubmission(id);
      if (!row) return ctx.fail(404, "not_found", "找不到这条投稿");
      await store.addThreadMessage(id, "to_author", text);
      return ctx.json({ ok: true, id });
    }

    return ctx.fail(404, "unknown_review_action", "未知的审核操作。");
  } catch (error) {
    console.error("web submission admin failed", { path: url.pathname, error: String(error) });
    return ctx.fail(500, "review_internal", String((error as Error)?.message ?? error));
  }
}

/** 附件预览:新数据走本站媒体库,旧迁移数据走旧机器人只读代取。 */
async function handleReviewMedia(
  url: URL,
  env: Env,
  ctx: WebSubmissionAdminContext,
  store: WebSubmitStore,
): Promise<Response> {
  const id = parseId(url.searchParams.get("submission") ?? url.searchParams.get("id"));
  if (id === null) return ctx.fail(400, "invalid_id", "缺少投稿编号");
  const index = Number.parseInt(String(url.searchParams.get("index") ?? "0"), 10);
  if (!Number.isInteger(index) || index < 0) return ctx.fail(400, "invalid_index", "附件序号不合法");

  const row = await store.getSubmission(id);
  if (!row) return ctx.fail(404, "not_found", "找不到这条投稿");
  const config = await loadWebSubmitFormSetting(env.DB);
  const attachment = attachmentsOf(row.data, config.steps)[index];
  if (!attachment) return ctx.fail(404, "media_not_found", "取不到这个附件");

  let stream: ReadableStream<Uint8Array> | null = null;
  let contentType = "application/octet-stream";
  let length: number | null = null;
  let filename = attachment.name ?? `attachment-${index + 1}`;
  const inline = attachment.kind === "photo" || attachment.kind === "video";

  if (attachment.mediaAssetId) {
    const asset = await getMediaAssetById(env.DB, attachment.mediaAssetId);
    if (!asset?.storageKey) return ctx.fail(404, "media_not_found", "取不到这个附件");
    const bytes = await createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV }).get(asset.storageKey);
    if (!bytes) return ctx.fail(404, "media_not_found", "取不到这个附件");
    stream = new Response(bytes).body;
    contentType = asset.mimeType ?? contentType;
    length = bytes.byteLength;
    if (asset.fileName) filename = asset.fileName;
  } else if (attachment.legacyFileId) {
    const legacyToken = (env.SUBMISSION_BOT_LEGACY_TOKEN ?? "").trim();
    if (!legacyToken)
      return ctx.fail(403, "legacy_media_disabled", "旧投稿附件的读取通道未启用（SUBMISSION_BOT_LEGACY_TOKEN）");
    /* 旧机器人只读代取:getFile + 文件下载,不触碰任何写接口。 */
    const infoResponse = await fetch(`https://api.telegram.org/bot${legacyToken}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: attachment.legacyFileId }),
    });
    if (!infoResponse.ok) return ctx.fail(404, "media_not_found", "取不到这个附件");
    const info = (await infoResponse.json()) as { result?: { file_path?: string; file_size?: number } };
    const filePath = info.result?.file_path;
    if (!filePath) return ctx.fail(404, "media_not_found", "取不到这个附件");
    const size = Number(info.result?.file_size ?? 0);
    if (Number.isFinite(size) && size > MAX_REVIEW_MEDIA_BYTES) {
      return ctx.fail(
        413,
        "media_too_large",
        `附件超过 ${Math.round(MAX_REVIEW_MEDIA_BYTES / 1024 / 1024)}MB，后台预览不了`,
      );
    }
    const fileResponse = await fetch(`https://api.telegram.org/file/bot${legacyToken}/${filePath}`);
    if (!fileResponse.ok || !fileResponse.body) return ctx.fail(404, "media_not_found", "取不到这个附件");
    stream = fileResponse.body;
    const mime = fileResponse.headers.get("content-type");
    if (mime) contentType = mime;
    length = size > 0 ? size : null;
  } else {
    return ctx.fail(404, "media_not_found", "这个附件没有可读的存储");
  }

  const headers = new Headers();
  headers.set("content-type", contentType);
  if (length) headers.set("content-length", String(length));
  /* 管理端内容:允许本机短暂缓存,但绝不能进共享缓存。 */
  headers.set("cache-control", "private, max-age=300");
  headers.set("x-content-type-options", "nosniff");
  if (!inline) {
    headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  }
  return new Response(stream, { status: 200, headers });
}
