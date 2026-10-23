/**
 * `/api/cert/share` —— 认证卡生成器「完成制作」时，把用户的原图与成品图
 * 同步一份到作者频道。
 *
 * 设计上的四条硬约束：
 *
 * 1. **默认关闭、按需开启，且只有一个事实来源**。目标频道与「报告归档频道」
 *    共用同一条解析链（系统设置 → KV 缓存 → 环境变量），见
 *    {@link resolveCertShareChannel}：
 *
 *      - 管理员在控制中心单独设了 `cert_share_channel_id` → 用它；
 *      - 环境变量 `CERT_SHARE_CHANNEL` 有值 → 用它（便于一次性部署脚本）；
 *      - 否则**继承报告归档频道**。这一档是刻意的：归档频道本来就在收每一份
 *        答卷的 ZIP，把访客自制的照片也发到同一个地方符合管理员的直觉，
 *        也避免「后台显示频道已配好、卡片却一张都没到」这类静默分叉。
 *
 *    `CERT_SHARE_DISABLED=true` 凌驾于以上全部。频道 id 之所以是配置项而不是
 *    常量，是因为同一个 Worker 会以 `DEPLOYMENT_ROLE = "customer"` 派发给客户
 *    （见 scripts/deploy-customer.mjs），那些部署不该把访客照片发到厂商频道。
 *
 * 2. **只认本应用前端**。上传会把访客照片转存到第三方（Telegram），前端点导出
 *    即上传、不再弹窗询问，所以本端点改用一个来源标记头
 *    `X-Cert-Share-Origin: cert-generator` 作为门槛：它是自定义头，跨站的
 *    简单表单 POST 带不出来（需走 preflight），挡住了「别的站拿这张表偷偷
 *    塞图片」这类滥用。它证明请求来自本应用，不证明任何个人同意——这层
 *    语义已随弹窗一起移除。
 *    旧头 `X-Cert-Share-Consent: yes` 仍被接受，只为照顾缓存里还挂着旧
 *    app.js 的浏览器；等 CDN 缓存自然过期（保守按 7 天）即可删除该兼容分支。
 *
 * 3. **失败不打扰用户**。上传是导出之后的旁路，任何失败都只回结构化错误，
 *    前端只写 console.warn。导出 PNG 本身不依赖这个请求。
 *
 * 4. **只信字节不信扩展名**。所有图片走 detectContent() 的 magic-byte 判定，
 *    `content-type` 与文件名都不作为依据。
 */

import { sendPhoto, sendPhotoAlbum } from "../bot/telegram";
import { detectContent } from "../services/media/upload-validation.service";
import { resolveReportChannel } from "../services/report-delivery.service";
import { checkRateLimit, rateLimitResponse } from "../services/rate-limit.service";
import { getSystemSettingValue } from "../services/system-settings.service";
import { imagesConfigured, uploadImage } from "../services/media/images.service";

export const CERT_SHARE_PATH = "/api/cert/share";

/** 单次导出最多带 9 张原图（与前端 PHOTO_MAX 对齐）。 */
const MAX_SOURCES = 9;
/** 成品 PNG 上限。9 宫格 2000×3000 的 PNG 一般 < 3MB，8MB 留足余量。 */
const MAX_CARD_BYTES = 8 * 1024 * 1024;
/** 单张原图上限，与 Telegram 照片接口的实际收口一致。 */
const MAX_SOURCE_BYTES = 6 * 1024 * 1024;
/**
 * 同一来源 10 分钟最多 20 次。
 *
 * 早先设想的是 6 次，但「反复调参数再导出一遍」是这个页面的正常用法：
 * 一个人改版式「拍立得 → 印样联片」、换画幅、再补两张照片，十几分钟里
 * 导出十几张不算异常。20 次既不挡正常用户，也把脚本压在每分钟 2 张以内。
 */
const RATE_LIMIT = { limit: 20, windowSeconds: 600 };
/** 来源标记头，见上文约束 2。值必须完全匹配 CERT_SHARE_ORIGIN_VALUE。 */
export const CERT_SHARE_ORIGIN_HEADER = "x-cert-share-origin";
export const CERT_SHARE_ORIGIN_VALUE = "cert-generator";
/**
 * 旧版的同意证明头。前端已不再发送，保留只为缓存期兼容，过期后可删。
 */
export const CERT_SHARE_LEGACY_CONSENT_HEADER = "x-cert-share-consent";

export interface CertShareEnv {
  BOT_TOKEN?: string;
  /** 解析系统设置（含归档频道回落）需要；缺省时只走环境变量。 */
  DB?: D1Database;
  /* 以下四项与 ReportChannelEnvironment / 全局 Env 保持 `null | undefined` 兼容，
     否则在 exactOptionalPropertyTypes 下无法直接传 env。 */
  CACHE?: KVNamespace | null | undefined;
  REPORT_CHANNEL_ID?: string | null | undefined;
  CERT_SHARE_CHANNEL?: string | null | undefined;
  /** 置 "true" 时整体停用，优先于任何频道配置。 */
  CERT_SHARE_DISABLED?: string | null | undefined;
  /** Images 管线（Pro）：三项齐备时成品图旁路上传，响应带 imageUrl。 */
  IMAGES_ACCOUNT_ID?: string | null | undefined;
  IMAGES_DELIVERY_HASH?: string | null | undefined;
  CLOUDFLARE_API_TOKEN?: string | null | undefined;
}

/** 目标频道从哪一层取到，供控制中心如实展示。 */
export type CertShareChannelSource = "settings" | "env" | "archive";

export interface ResolvedCertShareChannel {
  chatId: number;
  source: CertShareChannelSource;
}

export interface CertShareSender {
  album(chatId: number, photos: Array<{ bytes: Uint8Array; caption?: string }>): Promise<void>;
  single(chatId: number, bytes: Uint8Array, caption?: string): Promise<void>;
}

export interface CertShareOptions {
  /** 访客标识（IP 或中继转发的真实地址），只用于限流分桶。 */
  clientKey: string;
  /** 测试注入用；生产走 Telegram Bot API。 */
  sender?: CertShareSender;
}

/**
 * 把配置值解析成可发送的 chat id。null = 没配好。
 *
 * 只接受数字型 chat id（`-100…` 这种）：`sendPhotoAlbum` 的签名是
 * `chatId: number`，而 `@channel` 形式的用户名无法安全地转成 number，
 * 与其在发送时才 400，不如在这里就判定为「未配置」。
 */
function parseChatId(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const id = Number(trimmed);
  if (!Number.isSafeInteger(id) || id === 0) return null;
  return id;
}

/**
 * 全局停用开关（`CERT_SHARE_DISABLED=true`）。
 *
 * 导出成公开函数，是为了让控制中心的 GET 能区分两种「看起来一样」的状态：
 * 「管理员填了频道但功能被全局停用」与「什么都没配」。两者都解析成 null，
 * 但处置完全不同——面板必须能说清是哪一种。
 */
export function isCertShareDisabled(env: CertShareEnv): boolean {
  return (env.CERT_SHARE_DISABLED ?? "").trim().toLowerCase() === "true";
}

/**
 * 环境变量这一层的解析（不含系统设置与归档频道回落）。
 *
 * 保留成同步纯函数是因为它同时被 {@link resolveCertShareChannel} 与单元测试
 * 直接调用；**业务入口不应该只用它**，否则会漏掉后台配置。
 */
export function certShareChannel(env: CertShareEnv): number | null {
  if (isCertShareDisabled(env)) return null;
  return parseChatId(env.CERT_SHARE_CHANNEL) ?? parseChatId(env.REPORT_CHANNEL_ID);
}

/**
 * 生产入口：解析认证卡照片的发送目标。
 *
 * 顺序（先命中先用）：
 *   1. `CERT_SHARE_DISABLED=true` → 关闭；
 *   2. 系统设置 `cert_share_channel_id`（控制中心编辑）→ `"settings"`；
 *   3. 环境变量 `CERT_SHARE_CHANNEL` → `"env"`；
 *   4. 报告归档频道（{@link resolveReportChannel}：设置 → KV 缓存 → 环境变量）
 *      → `"archive"`。
 *
 * 第 4 档与第 2 档都读 system_settings，但读的是**不同的键**：管理员可以只配
 * 归档频道就让两者一起生效，也可以在控制中心把认证卡单独指到另一个频道。
 *
 * `env.DB` 缺省时（纯环境变量的单元测试、极简部署）跳过所有数据库档，
 * 退化成 {@link certShareChannel}，不会因为拿不到 DB 就静默不发。
 */
export async function resolveCertShareChannel(
  env: CertShareEnv,
): Promise<ResolvedCertShareChannel | null> {
  if (isCertShareDisabled(env)) return null;

  const envChannel = parseChatId(env.CERT_SHARE_CHANNEL);
  if (!env.DB) {
    // 没有 DB 就够不到系统设置，也就没有「归档频道」可继承；此时退化成完整的
    // 环境变量解析（含 REPORT_CHANNEL_ID 回落），而不是只看 CERT_SHARE_CHANNEL
    // ——否则只配了 REPORT_CHANNEL_ID 的部署会从「能发」变成「静默不发」。
    const fallback = certShareChannel(env);
    return fallback === null ? null : { chatId: fallback, source: "env" };
  }

  const settingsChannel = parseChatId(await getSystemSettingValue(env.DB, "cert_share_channel_id"));
  if (settingsChannel !== null) return { chatId: settingsChannel, source: "settings" };
  if (envChannel !== null) return { chatId: envChannel, source: "env" };

  const archive = await resolveReportChannel({
    DB: env.DB,
    CACHE: env.CACHE ?? null,
    REPORT_CHANNEL_ID: env.REPORT_CHANNEL_ID ?? null,
  });
  return archive === null ? null : { chatId: archive.chatId, source: "archive" };
}

function defaultSender(botToken: string): CertShareSender {
  return {
    async album(chatId, photos) {
      await sendPhotoAlbum(botToken, chatId, photos);
    },
    async single(chatId, bytes, caption) {
      await sendPhoto(botToken, chatId, bytes, caption);
    },
  };
}

/** 只保留可安全进 caption 的短字符串：截断、去换行、去控制字符。 */
function captionField(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim();
  return cleaned.slice(0, 60) || fallback;
}

/**
 * caption 最多带几个标签、每个多长。
 * 这是给频道里认人用的，不是给长文本用的：有人会把整段话塞进标签，
 * 所以按条数和字符数双重截断，而不是只截总长。
 */
const TAG_LIMIT = 8;
const TAG_MAX_CHARS = 16;
/** Telegram caption 上限 1024 字节，中文一个字 3 字节，留足余量。 */
const CAPTION_MAX_CHARS = 300;

/**
 * 把标签整理成 Telegram 可识别的 hashtag。
 * 空格和 `#` 会切断 hashtag，统一换成下划线；去重不区分大小写。
 */
function captionTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = captionField(entry, "")
      .replace(/^#+/, "")
      .trim();
    if (!text || text.length > TAG_MAX_CHARS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${text.replace(/[\s#]+/g, "_")}`);
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

/**
 * 卡片指纹：成品图字节的 SHA-256 取前 6 位十六进制。
 * 用途是让同一条消息在频道里可被单独指认（"是 A1B2C3 那条"），
 * 同时同样的卡片重复导出会得到同一个指纹，便于对照。
 */
async function cardFingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const head = new Uint8Array(digest).subarray(0, 3);
  return Array.from(head, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** 频道里看的时间用北京时间，和作者时区一致；标注出来避免误读。 */
function captionTimestamp(now: Date): string {
  const text = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `${text.replace(/\//g, "-")} (UTC+8)`;
}

function buildCaption(
  meta: Record<string, unknown>,
  sourceCount: number,
  fingerprint: string,
  now: Date,
): string {
  /* 第一行就是"这是谁的"——频道里认人靠它，所以放在最上面。 */
  const signer = captionField(meta.signer);
  const lines = ["🎴 认证卡生成器 · 新作品"];
  lines.push(signer ? `署名：${signer}` : "署名：（未填写）");

  const name = captionField(meta.name);
  if (name) lines.push(`姓名：${name}`);

  const style = captionField(meta.style);
  const ratio = captionField(meta.ratio);
  const theme = captionField(meta.theme);
  if (style || ratio) lines.push([style, ratio && `画幅 ${ratio}`].filter(Boolean).join("｜"));
  if (theme) lines.push(`主题：${theme}`);

  const tags = captionTags(meta.tags);
  if (tags.length > 0) lines.push(`标签：${tags.join(" ")}`);

  lines.push(sourceCount > 0 ? `成品 1 张 + 原图 ${sourceCount} 张` : "成品 1 张（未上传原图）");
  lines.push(`🕒 ${captionTimestamp(now)} · 指纹 ${fingerprint}`);

  const text = lines.join("\n");
  return text.length > CAPTION_MAX_CHARS ? `${text.slice(0, CAPTION_MAX_CHARS - 1)}…` : text;
}

interface ParsedImage {
  bytes: Uint8Array;
  mime: string;
}

/**
 * 从 `File` 取出并校验成一张可用图片。
 * 返回字符串就是拒绝原因（已可直出给前端），返回对象就是通过。
 */
async function readImage(file: File, maxBytes: number, label: string): Promise<ParsedImage | string> {
  if (file.size === 0) return `${label} 是空文件`;
  if (file.size > maxBytes) return `${label} 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectContent(bytes);
  if (!detected || detected.family !== "image") return `${label} 不是可识别的图片`;
  /* Telegram 照片接口只吃 png/jpeg/webp，GIF 只作为普通图片，其余一律拒。 */
  if (!["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) {
    return `${label} 的格式（${detected.format}）不支持，请用 PNG / JPEG / WebP`;
  }
  return { bytes, mime: detected.mime };
}

function enabledResponse(enabled: boolean, source?: CertShareChannelSource, reason?: string): Response {
  return Response.json(
    { ok: true, enabled, ...(source ? { channelSource: source } : {}), ...(reason ? { reason } : {}) },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * 来源判别。新头为准；旧头在兼容期内同样放行（见文件头约束 2）。
 * 两者都缺 → 拒绝：让「别的站拿一张跨站表单直接 POST 图片」走不通。
 */
function isAppOrigin(request: Request): boolean {
  const origin = (request.headers.get(CERT_SHARE_ORIGIN_HEADER) ?? "").trim().toLowerCase();
  if (origin === CERT_SHARE_ORIGIN_VALUE) return true;
  const legacy = (request.headers.get(CERT_SHARE_LEGACY_CONSENT_HEADER) ?? "").toLowerCase();
  return legacy === "yes";
}

export async function handleCertShare(
  request: Request,
  env: CertShareEnv,
  options: CertShareOptions,
): Promise<Response> {
  const resolved = await resolveCertShareChannel(env);
  const channel = resolved?.chatId ?? null;

  if (request.method === "GET") {
    return enabledResponse(channel !== null && !!env.BOT_TOKEN, resolved?.source);
  }

  if (request.method !== "POST") {
    return Response.json({ ok: false, code: "method_not_allowed" }, { status: 405 });
  }

  if (channel === null) return Response.json({ ok: false, code: "disabled" }, { status: 404 });
  if (!env.BOT_TOKEN) {
    console.warn("Cert share is configured but BOT_TOKEN is missing");
    return Response.json({ ok: false, code: "disabled" }, { status: 404 });
  }

  if (!isAppOrigin(request)) {
    return Response.json(
      { ok: false, code: "missing_origin", message: "请求未标明来自认证卡生成器" },
      { status: 403 },
    );
  }

  if (env.CACHE) {
    const limited = await checkRateLimit(
      env.CACHE,
      "cert-share",
      options.clientKey || "unknown",
      RATE_LIMIT.limit,
      RATE_LIMIT.windowSeconds,
    );
    if (!limited.allowed) return rateLimitResponse(limited.retryAfterSeconds);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, code: "bad_form" }, { status: 400 });
  }

  const cardFile = form.get("card");
  if (!(cardFile instanceof File)) {
    return Response.json({ ok: false, code: "missing_card", message: "缺少成品图" }, { status: 400 });
  }
  const card = await readImage(cardFile, MAX_CARD_BYTES, "成品图");
  if (typeof card === "string") {
    return Response.json({ ok: false, code: "bad_card", message: card }, { status: 400 });
  }

  const sources: ParsedImage[] = [];
  for (let i = 0; i < MAX_SOURCES; i += 1) {
    const entry = form.get(`source${i}`);
    if (entry === null) continue;
    if (!(entry instanceof File)) {
      return Response.json({ ok: false, code: "bad_source", message: `原图 ${i} 无效` }, { status: 400 });
    }
    const parsed = await readImage(entry, MAX_SOURCE_BYTES, `原图 ${i + 1}`);
    if (typeof parsed === "string") {
      return Response.json({ ok: false, code: "bad_source", message: parsed }, { status: 400 });
    }
    sources.push(parsed);
  }

  let meta: Record<string, unknown> = {};
  const rawMeta = form.get("meta");
  if (typeof rawMeta === "string" && rawMeta.length <= 2048) {
    try {
      const parsed = JSON.parse(rawMeta) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      /* meta 只是装饰，解析失败不阻断 */
    }
  }

  const fingerprint = await cardFingerprint(card.bytes);
  const caption = buildCaption(meta, sources.length, fingerprint, new Date());
  const sender = options.sender ?? defaultSender(env.BOT_TOKEN);

  try {
    if (sources.length === 0) {
      await sender.single(channel, card.bytes, caption);
    } else {
      await sender.album(channel, [
        { bytes: card.bytes, caption },
        ...sources.map((source) => ({ bytes: source.bytes })),
      ]);
    }
  } catch (error) {
    /* 不把 Telegram 的原始报错回给前端：里面可能带 chat id 与描述。 */
    console.warn("Cert share delivery failed", error instanceof Error ? error.message : error);
    return Response.json({ ok: false, code: "delivery_failed" }, { status: 502 });
  }

  // Images 管线（Pro）：成品图旁路上传，拿到可直链的交付地址。失败只记日志
  // ——TG 频道发送已经成功，这里绝不能把一次成功的分享变成报错。
  let imageUrl: string | undefined;
  if (imagesConfigured(env)) {
    try {
      const uploaded = await uploadImage(env, {
        bytes: card.bytes,
        name: `cert-card-${fingerprint}.png`,
        contentType: card.mime,
      });
      imageUrl = uploaded.url;
    } catch (error) {
      console.warn("Cert card Images upload failed", error instanceof Error ? error.message : error);
    }
  }

  return Response.json(
    { ok: true, photos: sources.length + 1, fingerprint, ...(imageUrl ? { imageUrl } : {}) },
    { headers: { "cache-control": "no-store" } },
  );
}
