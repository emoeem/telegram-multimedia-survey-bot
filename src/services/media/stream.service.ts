/**
 * Cloudflare Stream 视频托管（Pro 能力，docs/CLOUDFLARE_PLAN_TIERS.md）。
 *
 * 参与者的视频答卷走 **直传（direct upload）**：Worker 只铸造一张带元数据的
 * 上传凭证，浏览器把视频直传给 Cloudflare——视频不经过 Worker，因此不受
 * 请求体 20MB 的约束（免费管线的天花板），转码与 HLS 播放由 Stream 托管。
 *
 * 凭证链路：`POST /media/stream-ticket`（本仓库 survey API）创建 direct upload
 * 并落一条 `storage_kind='stream'` 的 media_assets 行（storage_key = video uid，
 * expires_at = 凭证过期点）；上传完成后播放经 media 端点按 Stream 状态分流。
 * 从未完成的凭证由每日维护 cron 对账清理（`sweepStaleStreamUploads`）。
 *
 * 本模块不做任何缓存：每个调用都是一次真实的 Cloudflare API 往返，调用方
 * （媒体端点、cron）自行决定频率。
 */

export interface StreamEnv {
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  /**
   * 硬开关：置 "true" 时无视 `STREAM_ACCOUNT_ID` / `STREAM_API_TOKEN` 一律视为未启用。
   *
   * 存在的理由是计费而不是功能。Stream 按分钟计费（$5 / 1000 分钟），是这个部署里
   * 唯一「单价随使用时长线性增长」的资源；凭证一旦能被铸造，暴露面就不再由代码
   * 决定，而由谁拿到一张直传凭证决定。想停用它时，删掉线上那两个 secret 也能达到
   * 同样效果，但那是**隐式**的——下一次有人为了别的目的补回 token，视频通道会
   * 无声无息地重新打开。一个显式的、写在 wrangler.toml 里的 `"true"` 才是可审计的
   * 停用声明：要开就得改这行，改这行就必然进 diff。
   */
  STREAM_DISABLED?: string;
}

/** `STREAM_DISABLED` 是否显式声明停用（大小写与空白不敏感）。 */
export function isStreamDisabled(env: { STREAM_DISABLED?: string } | undefined | null): boolean {
  if (!env || typeof env.STREAM_DISABLED !== "string") return false;
  return env.STREAM_DISABLED.trim().toLowerCase() === "true";
}

export interface StreamUploadTicket {
  videoUid: string;
  uploadUrl: string;
}

export type StreamVideoState = "ready" | "processing" | "not_found" | "errored";

export interface StreamVideoStatus {
  state: StreamVideoState;
  /** state === "ready" 时的 HLS 播放地址（Stream 返回什么就用什么）。 */
  hlsUrl?: string;
  /** state === "ready" 时的封面图地址（报告列表/卡片用）。 */
  thumbnailUrl?: string;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
/** 直传凭证的有效期：一次答卷媒体上传绰绰有余，过期未用由 cron 清理。 */
export const STREAM_TICKET_TTL_SECONDS = 24 * 60 * 60;
/** 单条视频的最长时长（秒）：答卷场景不可能更长，收敛 API 滥用面。 */
export const STREAM_MAX_DURATION_SECONDS = 15 * 60;

export function streamConfigured(env: StreamEnv): boolean {
  // 停用声明优先于配置：即使两个 secret 都在，`STREAM_DISABLED=true` 也一律不启用。
  if (isStreamDisabled(env)) return false;
  return (
    typeof env.STREAM_ACCOUNT_ID === "string" &&
    env.STREAM_ACCOUNT_ID.trim().length > 0 &&
    typeof env.STREAM_API_TOKEN === "string" &&
    env.STREAM_API_TOKEN.trim().length > 0
  );
}

function apiError(detail: unknown, fallback: string): Error {
  if (detail instanceof Error) return detail;
  if (typeof detail === "string" && detail.trim().length > 0) return new Error(`${fallback}：${detail}`);
  return new Error(fallback);
}

/** 铸造一张浏览器直传凭证。meta 带业务 id，便于在 Stream 控制台对账。 */
export async function createStreamDirectUpload(
  env: StreamEnv,
  input: { maxDurationSeconds?: number; metaName: string },
): Promise<StreamUploadTicket> {
  if (!streamConfigured(env)) throw new Error("Stream 未配置");
  const response = await fetch(`${API_BASE}/accounts/${env.STREAM_ACCOUNT_ID}/stream/direct-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      maxDurationSeconds: Math.min(
        Math.max(input.maxDurationSeconds ?? STREAM_MAX_DURATION_SECONDS, 1),
        STREAM_MAX_DURATION_SECONDS,
      ),
      expiry: new Date(Date.now() + STREAM_TICKET_TTL_SECONDS * 1000).toISOString(),
      meta: { name: input.metaName },
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: { uploadURL?: string; uid?: string };
  } | null;
  if (!response.ok || !payload?.success || !payload.result?.uploadURL || !payload.result.uid) {
    throw apiError(payload?.errors?.[0]?.message, `Stream direct-upload 创建失败（HTTP ${response.status}）`);
  }
  return { videoUid: payload.result.uid, uploadUrl: payload.result.uploadURL };
}

/** 查询视频状态。HTTP 404 → not_found（上传从未完成或已被清理）。 */
export async function getStreamVideoStatus(env: StreamEnv, videoUid: string): Promise<StreamVideoStatus> {
  if (!streamConfigured(env)) throw new Error("Stream 未配置");
  const response = await fetch(`${API_BASE}/accounts/${env.STREAM_ACCOUNT_ID}/stream/${encodeURIComponent(videoUid)}`, {
    headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` },
  });
  if (response.status === 404) return { state: "not_found" };
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: {
      status?: string;
      readyToStream?: boolean;
      playback?: { hls?: string; dash?: string };
      thumbnail?: string;
    };
  } | null;
  if (!response.ok || !payload?.success || !payload.result) {
    throw apiError(payload?.errors?.[0]?.message, `Stream 状态查询失败（HTTP ${response.status}）`);
  }
  const { readyToStream, status, playback, thumbnail } = payload.result;
  if (readyToStream) {
    const next: StreamVideoStatus = { state: "ready" };
    if (playback?.hls) next.hlsUrl = playback.hls;
    if (thumbnail) next.thumbnailUrl = thumbnail;
    return next;
  }
  // "in_progress" / "queued" / 下载中等都归为 processing；"errored" 单列。
  if (status === "errored" || status === "error") return { state: "errored" };
  return { state: "processing" };
}

/** 删除 Stream 视频（cron 对账、答卷删除时调用）。404 视为已删除。 */
export async function deleteStreamVideo(env: StreamEnv, videoUid: string): Promise<void> {
  if (!streamConfigured(env)) throw new Error("Stream 未配置");
  const response = await fetch(`${API_BASE}/accounts/${env.STREAM_ACCOUNT_ID}/stream/${encodeURIComponent(videoUid)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Stream 删除失败（HTTP ${response.status}）`);
  }
}

/**
 * 每日对账：从未完成的直传凭证。
 *
 * 占位行（storage_kind='stream'）带凭证期的 expires_at；过期即说明浏览器从未
 * 完成上传——删 Stream 侧对象（404 视为已删）并失效行。已完成上传的行在媒体
 * 端点转正（expires_at 清空），天然跳过本清扫。
 *
 * 返回删除数；单次最多 `limit` 行，超出的交给明天的 cron（与媒体清扫同预算纪律）。
 */
export async function sweepStaleStreamUploads(
  db: D1Database,
  env: StreamEnv,
  limit = 25,
): Promise<{ deleted: number; failed: number }> {
  const now = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT id, storage_key FROM media_assets
        WHERE storage_kind = 'stream' AND expires_at IS NOT NULL AND expires_at < ?
        ORDER BY id LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ id: number; storage_key: string | null }>();

  let deleted = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    const key = row.storage_key ?? "";
    const videoUid = key.includes(":") ? (key.split(":")[2] ?? "") : key;
    try {
      if (videoUid) await deleteStreamVideo(env, videoUid);
      await db
        .prepare("UPDATE media_assets SET expires_at = ?, updated_at = ? WHERE id = ?")
        .bind(new Date(0).toISOString(), new Date().toISOString(), row.id)
        .run();
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error("Stream sweep delete failed", { videoUid, error });
    }
  }
  return { deleted, failed };
}
