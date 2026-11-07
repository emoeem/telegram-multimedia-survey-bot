/**
 * 投稿墙（showcase）—— 已发布投稿的公开只读面。
 *
 * approve 之后内容此前止步于 status='published'（+ 可选的 TG 频道推送，
 * review.service.ts），站内没有任何公开面；这里是第一块：一条无鉴权的
 * GET /api/submit/gallery，把 published 行按运营配置的字段白名单投影出去，
 * 外加一条 /api/submit/gallery/media/:assetId 供墙上的附件取字节。
 *
 * 隐私双闸（两把锁都过才出网，默认不出网）：
 *   1. system_settings web_submit_form 的 showcaseEnabled（默认 false）；
 *   2. showcaseFields 字段白名单（默认空数组）。白名单在 mergeWebSubmitForm
 *      里已与当前 steps 求过交集，settings 残留的旧 step id 带不出网；data
 *      里 __ 开头的内部键（__nickname/__email/__ip）不是 step id，永远在
 *      白名单外。
 * 昵称额外一闸：署名方式选了「匿名投稿」的作者可能在表单里随手填过昵称
 * （SubmitScreen 的「选填」输入框），上墙按 TG 卡片同一套署名规则
 * （composeWebSubmissionText）投影——匿名不署名，「显示我的昵称」才带昵称，
 * 「自定义署名」带署名文本。墙上的信息不比频道里已经公开的多。
 *
 * KV 戳式缓存（与 survey catalog / trial leaderboard 同构，见
 * trial-api.ts 的注释）：
 *   键 = `web-submit-gallery:<PROJECTION_VERSION>:<settingsUpdatedAt>:<count>:<maxPublishedAt>:<maxUpdatedAt>`
 *
 *   戳探针一条语句同时取 published 行的 COUNT、MAX(published_at)、全表
 *   MAX(updated_at) 与设置行 updated_at（system_settings.updated_at
 *   TEXT NOT NULL，migration 0030）。三类变化任一都翻键、首请求重建缓存：
 *     - 旧稿后过审 / unpublish → COUNT 与 MAX(published_at) 变（unpublish
 *       转 recalled，COUNT 直接减一）；
 *     - 切换 showcaseEnabled / 增删 showcaseFields → 设置行 updated_at 变
 *       （setSystemSetting 每次写都刷新），旧缓存（含关闭期的空集）立即失效。
 *   用 MAX(published_at) 而非 MAX(id)：published_at 由 setStatus(to_published)
 *   与状态同语句盖戳（store.ts），先过审后补录的旧行不会把新戳顶掉
 *   （MAX(id) 在迁移数据乱序入库时会翻错顺序）。
 *   第三个戳 MAX(updated_at)（全表）是**单调**的：每次状态迁移（含 unpublish）
 *   都把某行 updated_at 盖成 now，且本表无硬删除——没有它，「下架最新一条」
 *   会把 (count, maxPublishedAt) 翻**回**某个 TTL 内还活着的旧键，旧 payload
 *   直接命中，最坏同秒序列里能把已下架的内容顶回墙上。单调戳保证键不复用，
 *   下架后的首次请求必然 miss 重建。
 *   PROJECTION_VERSION 手工 bump：载荷形状变化时防止滚动期新旧 Worker 互串
 *   旧投影（catalog.ts:59-66 记载的 theme.sprite / theme.audio.sfx 事故）。
 *
 *   成本声明：戳探针**每请求仍发生**，命中省的是 payload 行读——这是戳式
 *   缓存的新鲜度机制本身（catalog.ts:31-33 原话：探针花几百行，命中省掉的
 *   是 payload）。关闭态（默认）在读配置后直接空集返回，连探针都不发。
 */
import type { Env } from "../index";
import { fail, json } from "./api-response";
import {
  attachmentsOf,
  loadWebSubmitFormSetting,
  textOf,
  WEB_SUBMIT_FORM_SETTING_KEY,
  type WebSubmitFormConfig,
} from "../services/submit/form-config";
import { WebSubmitStore, type WebSubmissionRow } from "../services/submit/store";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { readCachedJson, writeCachedJson } from "../services/kv-cache.service";

/** 投稿墙单页上限：KV payload 与投影行数的硬顶。 */
const GALLERY_MAX_ITEMS = 100;

export const WEB_SUBMIT_GALLERY_CACHE_VERSION = "v1";
export const WEB_SUBMIT_GALLERY_CACHE_TTL_SECONDS = 6 * 60 * 60;

export function webSubmitGalleryCacheKey(stamp: string): string {
  return `web-submit-gallery:${WEB_SUBMIT_GALLERY_CACHE_VERSION}:${stamp}`;
}

/** 一条投稿在墙上的投影：白名单字段 + 附件资产 id，绝无 email/ip/viewer。 */
export interface GalleryItem {
  id: number;
  nickname: string | null;
  createdAt: number;
  fields: Record<string, string>;
  mediaAssetIds: number[];
}

/**
 * 墙上的署名（与 composeWebSubmissionText 同一套规则）。
 * 返回 null = 匿名展示，前端渲染「匿名」。
 */
function showcaseDisplayName(row: WebSubmissionRow): string | null {
  const authorChoice = String(row.data.author ?? "");
  if (authorChoice === "显示我的昵称") {
    const name = typeof row.data.__nickname === "string" ? row.data.__nickname.trim() : "";
    return name || null;
  }
  if (authorChoice === "自定义署名") {
    const name = textOf(row.data.signature).trim();
    return name || null;
  }
  /* 匿名投稿 / 未选择：昵称字段哪怕填了也不上墙。 */
  return null;
}

function projectGalleryItem(row: WebSubmissionRow, config: WebSubmitFormConfig): GalleryItem {
  const showcaseSteps = config.steps.filter((step) => config.showcaseFields.includes(step.id));
  const fields: Record<string, string> = {};
  for (const step of showcaseSteps) {
    if (step.type === "media") continue;
    const value = textOf(row.data[step.id]).trim();
    if (value) fields[step.id] = value;
  }
  /* 附件跟着媒体步骤的 id 走白名单：媒体步骤没被勾选，资产 id 一样不出网。 */
  const mediaStep = showcaseSteps.find((step) => step.type === "media");
  const mediaAssetIds = mediaStep
    ? attachmentsOf(row.data, config.steps)
        .map((item) => item.mediaAssetId)
        .filter((id): id is number => typeof id === "number" && id > 0)
    : [];
  return { id: row.id, nickname: showcaseDisplayName(row), createdAt: row.createdAt, fields, mediaAssetIds };
}

/** 戳探针：一条语句同时取 COUNT、MAX(published_at)、全表 MAX(updated_at) 与设置行 updated_at。 */
async function loadGalleryStamp(db: D1Database): Promise<{
  count: number;
  maxPublishedAt: number;
  maxUpdatedAt: number;
  settingsUpdatedAt: string | null;
}> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM web_submissions WHERE status = 'published') AS n,
         (SELECT MAX(published_at) FROM web_submissions WHERE status = 'published') AS max_published_at,
         (SELECT MAX(updated_at) FROM web_submissions) AS max_updated_at,
         (SELECT updated_at FROM system_settings WHERE key = ?) AS settings_updated_at`,
    )
    .bind(WEB_SUBMIT_FORM_SETTING_KEY)
    .first<{
      n: number;
      max_published_at: number | null;
      max_updated_at: number | null;
      settings_updated_at: string | null;
    }>();
  return {
    count: Number(row?.n ?? 0),
    maxPublishedAt: Number(row?.max_published_at ?? 0),
    maxUpdatedAt: Number(row?.max_updated_at ?? 0),
    settingsUpdatedAt: row?.settings_updated_at ?? null,
  };
}

/** GET /api/submit/gallery —— 公开只读，无鉴权。 */
export async function handleWebSubmitGallery(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const config = await loadWebSubmitFormSetting(env.DB);
  /* 双闸其一（总开关）或其二（白名单空）不过 → 空集。默认态零探针、零 KV。 */
  if (!config.showcaseEnabled || config.showcaseFields.length === 0) {
    return json({ ok: true, items: [] });
  }

  const stamp = await loadGalleryStamp(env.DB);
  const cacheKey = webSubmitGalleryCacheKey(
    `${stamp.settingsUpdatedAt ?? "none"}:${stamp.count}:${stamp.maxPublishedAt}:${stamp.maxUpdatedAt}`,
  );
  const cached = await readCachedJson<GalleryItem[]>(env.CACHE, cacheKey);
  if (cached) return json({ ok: true, items: cached });

  const rows = await new WebSubmitStore(env.DB).listPublished(GALLERY_MAX_ITEMS);
  const items = rows.map((row) => projectGalleryItem(row, config));
  await writeCachedJson(env.CACHE, cacheKey, items, WEB_SUBMIT_GALLERY_CACHE_TTL_SECONDS);
  return json({ ok: true, items });
}

/**
 * GET /api/submit/gallery/media/:assetId —— 墙上附件的公开取字节。
 *
 * 校验与广场个人资料的媒体先例（plaza-api.ts profileMediaMatch）同构，三重：
 *   1. asset_scope = 'response'（投稿附件因 0017 的 CHECK 约束写这个 scope，
 *      submit-api.ts storeWebMedia 的注释）；
 *   2. storage_key 前缀 media:websubmit:（真正区分投稿附件的标记）；
 *   3. media_refs 归属：投稿时登记的 ref_key 形如
 *      websubmit:<submissionId>:<assetId>，任一归属行指向 published 投稿
 *      才可读——未关联、或只挂在 pending/recalled 行上的资产一律 404。
 * 通过后走 buildMediaResponse，缓存头沿用其按存储分支的判定：R2/KV 的
 * 不可变字节得 public 短缓存，temporary 存储保持 private no-store——这里
 * 不像广场那样统一覆盖成 public，避免把 temporary 字节推进共享缓存。
 */
export async function handleWebSubmitGalleryMedia(env: Env, assetIdRaw: string): Promise<Response> {
  const assetId = Number.parseInt(assetIdRaw, 10);
  if (!Number.isInteger(assetId) || assetId <= 0) return fail(404, "not_found", "附件不存在");

  const asset = await getMediaAssetById(env.DB, assetId);
  if (!asset || asset.scope !== "response" || !asset.storageKey?.startsWith("media:websubmit:")) {
    return fail(404, "not_found", "附件不存在");
  }
  const linked = await env.DB.prepare(
    `SELECT 1 AS found
         FROM media_refs r
         JOIN web_submissions s
           ON r.ref_key = 'websubmit:' || s.id || ':' || r.asset_id
          AND s.status = 'published'
        WHERE r.ref_type = 'web_submission' AND r.asset_id = ?
        LIMIT 1`,
  )
    .bind(assetId)
    .first<{ found: number }>();
  if (!linked) return fail(404, "not_found", "附件不存在");

  const response = await buildMediaResponse(env, asset);
  if (!response) return fail(410, "gone", "附件已被清理");
  return response;
}
