/**
 * 免登录投稿的公开 HTTP 层 —— 从 submission-bot 的 web.js 移植到本站。
 *
 * API 契约与旧 Worker 逐字段对齐(前端 SubmitScreen / SubmitInboxScreen 零改动):
 *   GET  /api/submit/form      表单 schema
 *   GET  /api/submit/captcha   验证题令牌(无状态 HMAC)
 *   POST /api/submit           提交(multipart:step:<id> / file:<id> / token / captcha / nickname / email / viewer)
 *   GET  /api/submit/inbox?t=  收件箱(投稿 + 评论 + 管理员对话)
 *   POST /api/submit/reply     以作者身份回复一条评论
 *   POST /api/submit/message   给管理员留言
 *
 * 与旧实现的行为差异(都有意为之):
 *   媒体不再借道 Telegram 换 file_id,而是直接进本站媒体库
 *   (media_assets,scope='web_submission',字节在 MEDIA/R2);审核通知从
 *   「机器人私聊管理员」变为「写线程 + 主 bot Telegram 提醒」;发布语义见
 *   web-submission.ts 的 approve。
 *
 * 防滥用五道闸全部保留:蜜罐、HMAC 验证题 + 最短填表用时、IP 时间窗限流、
 * 全天总量硬上限、待审积压上限。
 */
import type { Env } from "../index";
import { fail, json } from "./api-response";
import {
  loadWebSubmitFormSetting,
  screenWebSubmission,
  submitFormSchema,
  visibleSteps,
  type WebSubmitAttachment,
  type WebSubmitFormConfig,
  type WebSubmitStep,
} from "../services/submit/form-config";
import { issueFormToken, normalizeEmail, normalizeViewer, verifyFormToken } from "../services/submit/captcha";
import { WebSubmitStore, type WebSubmissionRow } from "../services/submit/store";
import { createMediaStore } from "../services/media/temporary-media-store";
import { createMediaAsset } from "../db/repositories/media.repository";
import { verifyUploadContent } from "../services/media/upload-validation.service";
import { resolveClientIdentity } from "../services/client-identity.service";

const MAX_FIELD_CHARS = 5000;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
/** 评论回复/留言的长度上限(与旧实现一致)。 */
const THREAD_TEXT_MAX_CHARS = 800;

function jsonNoStore(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 是否归本模块管。/api/submit 本身与所有子路径;不能匹配 /api/submissions(金币投稿)。 */
export function isSubmitApiPath(pathname: string): boolean {
  return pathname === "/api/submit" || pathname.startsWith("/api/submit/");
}

function rateLimitWindow(windowSeconds: number, now = Math.floor(Date.now() / 1000)): number {
  return Math.floor(now / windowSeconds);
}

function dailyBucket(now = Math.floor(Date.now() / 1000)): { key: string; windowStart: number } {
  const windowStart = Math.floor(now / 86400) * 86400;
  return { key: `global-day:${new Date(windowStart * 1000).toISOString().slice(0, 10)}`, windowStart };
}

/** 主 bot 私聊提醒管理员(best-effort:通知失败不影响投稿本身)。 */
async function notifyAdminsViaBot(env: Env, text: string): Promise<void> {
  const token = (env.BOT_TOKEN ?? "").trim();
  const ids = String(env.ADMIN_IDS ?? "")
    .split(/[,\s]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((value) => Number.isFinite(value) && value !== 0);
  if (!token || ids.length === 0) return;
  const { sendMessage } = await import("../bot/telegram");
  await Promise.allSettled(
    ids.map((chatId) =>
      sendMessage(token, chatId, text)
        .then(() => undefined)
        .catch(() => undefined),
    ),
  );
}

/** 表单字段 → 投稿 data(移植 collectFields:校验 + show_if 可见性 + 白名单键)。 */
function collectFields(
  config: WebSubmitFormConfig,
  form: FormData,
): { data: Record<string, unknown>; errors: Record<string, string> } {
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const allowedKeys = new Set(config.steps.map((step) => step.id));

  for (const step of config.steps) {
    if (step.type === "media") continue;
    const raw = form.get(`step:${step.id}`);
    const value = typeof raw === "string" ? raw.trim() : "";
    const label = step.label ?? step.prompt ?? "这一项";
    const visible = visibleSteps(config.steps, data).some((item) => item.id === step.id);
    if (!visible) continue;

    if (!value) {
      if (step.required !== false) errors[step.id] = `${label}：请填写`;
      continue;
    }
    if (value.length > MAX_FIELD_CHARS) {
      errors[step.id] = `${label}：内容太长了`;
      continue;
    }
    if (step.type === "choice") {
      if (!(step.options ?? []).includes(value)) {
        errors[step.id] = `${label}：选项不正确`;
        continue;
      }
      data[step.id] = value;
      continue;
    }
    const limit = Math.min(step.max_length ?? config.maxTextLength, config.maxTextLength);
    if (value.length > limit) {
      errors[step.id] = `${label}：最多 ${limit} 字`;
      continue;
    }
    data[step.id] = value;
  }

  const nickname = String(form.get("nickname") ?? "").trim();
  if (nickname.length > 32) {
    errors.nickname = "昵称：最多 32 字";
  } else if (nickname) {
    data.__nickname = nickname;
  }
  if (data.author === "显示我的昵称" && !nickname) {
    errors.nickname = "昵称：选了「显示我的昵称」，请填昵称或改成匿名";
  }
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key) && !key.startsWith("__")) delete data[key];
  }
  return { data, errors };
}

interface PickedFile {
  kind: "photo" | "video" | "document";
  file: File;
  name: string | null;
}

/** 校验上传的文件并归一(移植 collectFiles + 主站的魔数校验)。 */
async function collectFiles(
  config: WebSubmitFormConfig,
  form: FormData,
): Promise<{ files: PickedFile[]; errors: Record<string, string>; stepId: string | null }> {
  const mediaStep = config.steps.find((step) => step.type === "media") ?? null;
  const files: PickedFile[] = [];
  const errors: Record<string, string> = {};
  if (!mediaStep) return { files, errors, stepId: null };

  const picked: File[] = [];
  for (const item of form.getAll(`file:${mediaStep.id}`)) {
    if (item && typeof item === "object" && "arrayBuffer" in item && item.size > 0) picked.push(item as File);
  }
  if (picked.length > config.maxFiles) {
    errors[mediaStep.id] = `${mediaStep.label ?? "附件"}：最多 ${config.maxFiles} 个文件`;
    return { files, errors, stepId: mediaStep.id };
  }
  const maxBytes = config.maxFileMb * 1024 * 1024;
  for (const file of picked) {
    const type = String(file.type ?? "");
    const kind: PickedFile["kind"] = type.startsWith("image/")
      ? "photo"
      : type.startsWith("video/")
        ? "video"
        : "document";
    const limit =
      kind === "photo"
        ? Math.min(maxBytes, PHOTO_MAX_BYTES)
        : kind === "video"
          ? Math.min(maxBytes, VIDEO_MAX_BYTES)
          : maxBytes;
    if (file.size > limit) {
      errors[mediaStep.id] = `${mediaStep.label ?? "附件"}：单个文件不能超过 ${Math.round(limit / 1024 / 1024)} MB`;
      return { files, errors, stepId: mediaStep.id };
    }
    /* 内联渲染的 photo 必须真的图:魔数校验(顺带拒绝 svg 这类文本冒充的
     * 图片)。视频/文档以 attachment 方式下发,不校验内容类型。 */
    if (kind === "photo") {
      const verdict = verifyUploadContent(new Uint8Array(await file.arrayBuffer()), type);
      if (!verdict.ok) {
        errors[mediaStep.id] = `${mediaStep.label ?? "附件"}：图片内容与格式不符`;
        return { files, errors, stepId: mediaStep.id };
      }
    }
    files.push({ kind, file, name: typeof file.name === "string" ? file.name : null });
  }
  return { files, errors, stepId: mediaStep.id };
}

/** 把文件字节存进本站媒体库,返回附件引用。 */
async function storeWebMedia(env: Env, picked: PickedFile): Promise<WebSubmitAttachment> {
  const store = createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV });
  const bytes = new Uint8Array(await picked.file.arrayBuffer());
  const mimeType = picked.file.type || "application/octet-stream";
  const storageKey = `media:websubmit:${crypto.randomUUID()}`;
  await store.put({ storageKey, bytes, contentType: mimeType });
  const asset = await createMediaAsset(env.DB, {
    scope: "web_submission",
    mediaType: picked.kind === "photo" ? "photo" : picked.kind === "video" ? "video" : "document",
    mimeType,
    fileName: picked.name ?? null,
    fileSize: bytes.byteLength,
    storageKind: store.kind,
    storageKey,
    expiresAt: null,
  });
  return {
    kind: picked.kind === "document" ? "document" : picked.kind,
    name: picked.name ?? null,
    mediaAssetId: asset.id,
    mimeType,
    fileSize: bytes.byteLength,
  };
}

/** 处理 /api/submit/*。返回 null 表示不是本模块的路径。 */
export async function handleSubmitApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!isSubmitApiPath(url.pathname)) return null;

  const config = await loadWebSubmitFormSetting(env.DB);
  if (!config.enabled) return jsonNoStore({ ok: false, error: "投稿未开放" }, 404);

  const captchaSecret = (env.WEBHOOK_SECRET ?? "").trim();
  const captchaOn = config.captcha && Boolean(captchaSecret);

  if (url.pathname === "/api/submit/form") {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return jsonNoStore({ ok: true, form: submitFormSchema(config) });
  }

  if (url.pathname === "/api/submit/captcha") {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    if (!captchaSecret) return jsonNoStore({ ok: false, error: "服务端还没配置验证密钥" }, 500);
    return jsonNoStore(await issueFormToken(captchaSecret, { captcha: captchaOn }));
  }

  if (url.pathname === "/api/submit/inbox") {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return handleInbox(url, env);
  }

  if (url.pathname === "/api/submit/reply" || url.pathname === "/api/submit/message") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    return handleInboxAction(request, url, env, config);
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  return handleSubmit(request, env, config, { captchaSecret, captchaOn });
}

// ---------------------------------------------------------------------------

async function handleInbox(url: URL, env: Env): Promise<Response> {
  const viewer = normalizeViewer(url.searchParams.get("t"));
  if (!viewer) return jsonNoStore({ ok: false, error: "缺少身份令牌" }, 400);
  const store = new WebSubmitStore(env.DB);
  const rows = await store.listByViewer(viewer, 20);
  const items = [];
  for (const row of rows) {
    const comments = await store.listComments(row.id, 20);
    const thread = await store.listThreads(row.id, 50);
    const unread = await store.countUnreadThread(row.id);
    items.push({
      id: row.id,
      status: row.status,
      title: inboxTitle(row),
      createdAt: row.createdAt,
      publishedLinkId: row.publishChatId && row.publishMessageId ? row.publishMessageId : null,
      mediaCount: inboxMediaCount(row),
      comments: comments
        .slice()
        .reverse()
        .map((comment) => ({
          messageId: comment.telegramMessageId ?? comment.id,
          name: comment.kind === "author_reply" ? "你" : comment.authorName || "有人",
          text: comment.text ?? "",
          parentAuthor: comment.parentAuthor,
          createdAt: comment.createdAt,
          isMine: comment.kind === "author_reply",
        })),
      unreadComments: comments.filter((comment) => comment.kind !== "author_reply").length,
      thread,
      unreadThread: unread,
    });
    await store.markThreadSeen(row.id);
  }
  return jsonNoStore({ ok: true, items, webSubmitUrl: "/submissions?tab=anon" });
}

function inboxMediaCount(row: WebSubmissionRow): number {
  for (const step of Object.keys(row.data)) {
    const value = row.data[step];
    if (Array.isArray(value) && value.some((item) => (item as WebSubmitAttachment)?.mediaAssetId !== undefined)) {
      return value.length;
    }
  }
  return 0;
}

function inboxTitle(row: WebSubmissionRow): string {
  const title = row.data.title;
  const titleText =
    typeof title === "object" && title !== null
      ? String((title as { plain?: unknown }).plain ?? "")
      : String(title ?? "");
  if (titleText.trim()) return titleText;
  const body = row.data.body;
  const bodyText =
    typeof body === "object" && body !== null ? String((body as { plain?: unknown }).plain ?? "") : String(body ?? "");
  return bodyText.slice(0, 40) || `投稿 #${row.id}`;
}

interface InboxActionBody {
  viewer?: unknown;
  text?: unknown;
  submissionId?: unknown;
  commentMessageId?: unknown;
}

async function handleInboxAction(request: Request, url: URL, env: Env, config: WebSubmitFormConfig): Promise<Response> {
  const store = new WebSubmitStore(env.DB);
  /* 旧实现按 IP 限流;主站的 resolveClientIdentity 已归一代理头,直接用它。 */
  const client = resolveClientIdentity(request, env);
  if (config.rateLimitCount > 0 && config.rateLimitWindowSeconds > 0 && client.ip) {
    const window = rateLimitWindow(config.rateLimitWindowSeconds);
    const key = `inbox:${client.ip}:${window}`;
    const used = await store.getRateLimit(key);
    if (used >= config.rateLimitCount * 6) return jsonNoStore({ ok: false, error: "操作太频繁了，请稍后再试" }, 429);
    await store.bumpRateLimit(key, window);
  }

  let body: InboxActionBody | null = null;
  try {
    body = (await request.json()) as InboxActionBody;
  } catch {
    return jsonNoStore({ ok: false, error: "请求格式不对" }, 400);
  }
  const viewer = normalizeViewer(body?.viewer);
  const text = String(body?.text ?? "").trim();
  const submissionId = Number.parseInt(String(body?.submissionId ?? ""), 10);
  if (!viewer || !Number.isFinite(submissionId)) return jsonNoStore({ ok: false, error: "缺少身份或投稿编号" }, 400);
  if (!text) return jsonNoStore({ ok: false, error: "内容不能为空" }, 422);
  if (text.length > THREAD_TEXT_MAX_CHARS)
    return jsonNoStore({ ok: false, error: `太长了，请控制在 ${THREAD_TEXT_MAX_CHARS} 字以内` }, 422);

  const submission = await store.getSubmission(submissionId);
  if (!submission || submission.viewerToken !== viewer) {
    return jsonNoStore({ ok: false, error: "找不到这条投稿" }, 404);
  }

  if (url.pathname === "/api/submit/message") {
    await store.addThreadMessage(submissionId, "to_admin", text);
    void notifyAdminsViaBot(
      env,
      `💬 网页投稿 #${submissionId} 的作者留言：\n\n${text}\n\n回复：后台 → 网页投稿 → 回复投稿者`,
    );
    return jsonNoStore({ ok: true });
  }

  // /api/submit/reply:回复一条评论。迁移来的评论才有 Telegram 归属;新链路
  // 没有讨论区,回复能力随旧数据一并退役(没有 telegram_chat_id 就明确报错)。
  const commentMessageId = Number.parseInt(String(body?.commentMessageId ?? ""), 10);
  if (!Number.isFinite(commentMessageId)) return jsonNoStore({ ok: false, error: "缺少评论编号" }, 400);
  const comment = await store.getComment(submissionId, commentMessageId);
  if (!comment) return jsonNoStore({ ok: false, error: "这条评论已经不在了" }, 404);
  if (!comment.telegramChatId || comment.telegramMessageId === null) {
    return jsonNoStore({ ok: false, error: "这条评论不支持回复" }, 400);
  }
  const legacyToken = (env.SUBMISSION_BOT_LEGACY_TOKEN ?? "").trim();
  if (!legacyToken) return jsonNoStore({ ok: false, error: "评论回复通道已关闭" }, 403);
  /* 旧机器人私信接口没有封装进 src/bot/telegram.ts(reply_to 参数),这条
   * 低频路径直接裸调;失败如实返回,不重试。 */
  try {
    const response = await fetch(`https://api.telegram.org/bot${legacyToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: comment.telegramChatId,
        text: `✍️ 投稿者回复：\n${text}`,
        reply_to_message_id: comment.telegramMessageId,
      }),
    });
    if (!response.ok) throw new Error(`telegram ${response.status}`);
  } catch {
    return jsonNoStore({ ok: false, error: "回复发送失败，请稍后再试" }, 502);
  }
  await store.addThreadMessage(submissionId, "to_admin", `（作者回复了评论）${text}`);
  return jsonNoStore({ ok: true });
}

async function handleSubmit(
  request: Request,
  env: Env,
  config: WebSubmitFormConfig,
  secrets: { captchaSecret: string; captchaOn: boolean },
): Promise<Response> {
  const client = resolveClientIdentity(request, env);
  const store = new WebSubmitStore(env.DB);

  // 先看 Content-Length:超大请求体不必先读进内存再拒绝。
  const budgetBytes = (config.maxFiles * config.maxFileMb + 1) * 1024 * 1024;
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > budgetBytes) {
    return jsonNoStore(
      { ok: false, error: `文件太多了：一次投稿总大小不能超过 ${Math.round(budgetBytes / 1024 / 1024)} MB` },
      413,
    );
  }

  // 全天硬上限 + 积压上限:打满后连 body 都不读,省 CPU 和内存。
  if (config.dailyLimit > 0) {
    const day = dailyBucket();
    const usedToday = await store.getRateLimit(day.key);
    if (usedToday >= config.dailyLimit) {
      return jsonNoStore({ ok: false, error: "今天的投稿量已满，请明天再来" }, 429);
    }
  }
  if (config.pendingLimit > 0) {
    const pending = await store.countForReview("pending");
    if (pending >= config.pendingLimit) {
      return jsonNoStore({ ok: false, error: "待审核的投稿已经排满了，请稍后再来" }, 429);
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonNoStore({ ok: false, error: "表单数据读不出来，请重试" }, 400);
  }

  // 蜜罐:正常用户看不到这个字段,填了就是脚本。
  if (String(form.get("website") ?? "").trim()) {
    return jsonNoStore({ ok: false, error: "提交失败，请刷新页面重试" }, 400);
  }

  if (!secrets.captchaSecret) return jsonNoStore({ ok: false, error: "服务端配置不完整" }, 500);
  const verification = await verifyFormToken(secrets.captchaSecret, form.get("token"), form.get("captcha"), {
    captcha: secrets.captchaOn,
    minFillSeconds: config.minFillSeconds,
  });
  if (!verification.ok) {
    const messages = {
      expired: "验证已过期，请刷新页面重新填写",
      too_fast: "提交得太快了，请确认内容后再提交",
      wrong_answer: "验证答案不对，请重新算一次",
    };
    return jsonNoStore({ ok: false, error: messages[verification.reason] ?? "验证没通过" }, 403);
  }

  const { data, errors } = collectFields(config, form);
  const nickname = String(form.get("nickname") ?? "").trim();
  const files = await collectFiles(config, form);
  Object.assign(errors, files.errors);
  if (Object.keys(errors).length > 0) return jsonNoStore({ ok: false, errors }, 422);

  if (config.rateLimitCount > 0 && config.rateLimitWindowSeconds > 0 && client.ip) {
    const window = rateLimitWindow(config.rateLimitWindowSeconds);
    const key = `web:${client.ip}:${window}`;
    const used = await store.getRateLimit(key);
    if (used >= config.rateLimitCount) {
      const minutes = Math.max(1, Math.ceil(config.rateLimitWindowSeconds / 60));
      return jsonNoStore({ ok: false, error: `提交太频繁了，请 ${minutes} 分钟后再试` }, 429);
    }
  }

  const screening = await screenWebSubmission(config, data);
  const viewer = normalizeViewer(form.get("viewer"));
  const email = normalizeEmail(form.get("email"));

  try {
    const attachments: WebSubmitAttachment[] = [];
    for (const picked of files.files) {
      attachments.push(await storeWebMedia(env, picked));
    }
    const payload = { ...data };
    if (files.stepId) payload[files.stepId] = attachments;

    const submissionId = await store.createSubmission({
      viewerToken: viewer,
      email,
      nickname: nickname || "网页访客",
      ip: client.ip,
      templateId: "default",
      data: payload,
      flags: screening.flags,
      contentHash: screening.hash,
    });

    if (config.rateLimitCount > 0 && config.rateLimitWindowSeconds > 0 && client.ip) {
      const window = rateLimitWindow(config.rateLimitWindowSeconds);
      await store.bumpRateLimit(`web:${client.ip}:${window}`, window);
      if (Math.random() < 0.02) void store.pruneRateLimits();
    }
    // 全天计数只在成功收下之后加:被别的原因拒掉的请求不该消耗当天的配额。
    if (config.dailyLimit > 0) {
      const day = dailyBucket();
      await store.bumpRateLimit(day.key, day.windowStart);
    }

    void notifyAdminsViaBot(
      env,
      `📮 新的网页投稿 #${submissionId}（${payload.category ?? "未分类"}）\n请在后台「网页投稿」中审核。`,
    );

    return jsonNoStore({ ok: true, id: submissionId, status: "pending", link: null, viewer });
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error("web submission failed", { message });
    void notifyAdminsViaBot(env, `⚠️ 网页投稿处理失败：${message.slice(0, 200)}`);
    return jsonNoStore({ ok: false, error: "提交失败，请稍后再试（管理员已收到通知）" }, 500);
  }
}

/** 保留导出:管理端 media 流也要判断 kind 决定 inline。 */
export function isInlineAttachment(attachment: WebSubmitAttachment | undefined): boolean {
  if (!attachment) return false;
  return attachment.kind === "photo" || attachment.kind === "video";
}
