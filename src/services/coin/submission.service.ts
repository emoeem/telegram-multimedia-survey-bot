import type { Env } from "../../index";
import { createMediaAsset, getMediaAssetById } from "../../db/repositories/media.repository";
import { createMediaStore, KVMediaStore } from "../media/temporary-media-store";
import { verifyUploadContent } from "../media/upload-validation.service";
import { loadCoinConfig, coinDayKey } from "./config.service";
import { earnCoins } from "./ledger.service";
import { moderateSubmission, type ModerationVerdict } from "./moderation.service";

/**
 * 投稿中心（需求 7.x / 8 / 9）。
 *
 * 分层检测：这里实现可靠的第一、二层（字段校验、字节签名验证、SHA-256
 * 去重、频次限流），第三层内容安全先以人工审核兜底（默认所有投稿进入
 * pending，管理端逐条审核；autoApproveText 可配置但默认关）。不伪造
 * AI 审核结果；如需接入外部审核服务，走 reviewSubmission 之前的一个
 * 独立适配器（TODO 位置已留）。
 *
 * 奖励：审核通过时按 类型基础奖励 × 质量档 发放，受每日上限约束；
 * 幂等键 `submission:{id}` 保证重复审核动作绝不重复发币。异常纠错走
 * 管理员的 admin_adjust 反向流水（流水永不删除）。
 *
 * 媒体：复用平台的 KVMediaStore（随机对象键、字节签名校验、media_assets
 * 元数据与字节分离）；读取侧按投稿状态授权（见 coin-api 的 media 端点），
 * 撤回/下架后立即不可读。
 */

export type SubmissionType = "text" | "image" | "audio" | "survey_report" | "profile_card";

export const SUBMISSION_TYPES: readonly SubmissionType[] = ["text", "image", "audio", "survey_report", "profile_card"];

export class SubmissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SubmissionError";
    this.code = code;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** 文本规范化：去空白差异，让"随机空格/换行"刷不出重复指纹的绕过。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 投稿服务只需要 DB/KV 与可选的审核密钥——完整 Env 由调用方传入。 */
export interface SubmissionEnv {
  DB: D1Database;
  MEDIA_KV: KVNamespace;
  /** 绑定后媒体走 R2 分层存储；缺省回落 KV（免费部署不变）。 */
  MEDIA?: R2Bucket | undefined;
  MODERATION_API_KEY?: string | undefined;
}

export interface CreateSubmissionInput {
  type: SubmissionType;
  title: string;
  description?: string | null;
  contentText?: string | null;
  /** image / audio 上传的文件。 */
  file?: File | null;
  /** 客户端生成的缩略图（图片投稿）：列表与奖池预览用它，避免加载原图。 */
  thumbFile?: File | null;
  /** 客户端探测的音频时长（秒）；服务端无解码能力，仅作展示与软限制。 */
  durationSeconds?: number | null;
  /** survey_report / profile_card：必须是自己完成的答卷。 */
  responseId?: number | null;
  /** 明示授权（客户端必须逐项确认，后端再校验必选项）。 */
  authorization: { publishToPool?: boolean; allowCollection?: boolean; confirmOwn?: boolean };
}

export async function createSubmission(
  env: SubmissionEnv,
  participant: { participantHash: string; dbUserId: number | null; kind: string },
  input: CreateSubmissionInput,
): Promise<{ id: number; status: string; duplicate: boolean; moderation: ModerationVerdict }> {
  const db = env.DB;
  const cfg = await loadCoinConfig(db);
  if (!cfg.submissions.enabled) throw new SubmissionError("submissions_disabled", "投稿未开放");
  // 问责性：投稿涉及公开内容与奖励，匿名身份不可投稿。
  if (participant.kind === "anonymous") {
    throw new SubmissionError("identity_required", "投稿需要邮箱或 Telegram 身份，请在「我的」中登录");
  }

  const title = (input.title ?? "").trim();
  if (!title || title.length > cfg.submissions.maxTitleLength) {
    throw new SubmissionError("invalid_title", `标题必填且不超过 ${cfg.submissions.maxTitleLength} 字`);
  }
  // description 与 title/contentText 同为入库字段：它是唯一漏掉上限的那个
  // （coin-api 的表单/JSON 两路提交都直通这里），补上同样的硬校验。
  const description = input.description?.trim() || null;
  if (description && description.length > cfg.submissions.maxDescriptionLength) {
    throw new SubmissionError("invalid_description", `简介不超过 ${cfg.submissions.maxDescriptionLength} 字`);
  }
  if (input.authorization?.confirmOwn !== true) {
    // 授权确认不能用默认勾选代替：后端强制要求显式 true。
    throw new SubmissionError("authorization_required", "请确认内容为你本人拥有并同意发布条款");
  }

  // 每人每自然日投稿上限（服务端日界）。
  const today = coinDayKey(Date.now(), cfg.timezoneOffsetMinutes);
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions
       WHERE participant_hash = ? AND created_at >= ?`,
    )
    .bind(participant.participantHash, `${today}T00:00:00Z`)
    .first<{ n: number }>();
  if (Number(countRow?.n ?? 0) >= cfg.submissions.maxPerDay) {
    throw new SubmissionError("daily_limit", `每天最多投稿 ${cfg.submissions.maxPerDay} 次`);
  }

  let contentText: string | null = null;
  let mediaAssetId: number | null = null;
  let thumbMediaAssetId: number | null = null;
  let mediaDurationSeconds: number | null = null;
  let surveyId: number | null = null;
  let responseId: number | null = null;
  let contentHash: string;

  if (input.type === "text") {
    const text = (input.contentText ?? "").trim();
    if (!text || text.length > cfg.submissions.maxTextLength) {
      throw new SubmissionError("invalid_content", `正文必填且不超过 ${cfg.submissions.maxTextLength} 字`);
    }
    contentText = text;
    contentHash = await sha256Hex(new TextEncoder().encode(`text:${normalizeText(text)}`));
  } else if (input.type === "image" || input.type === "audio") {
    const file = input.file;
    if (!file || file.size <= 0) throw new SubmissionError("media_required", "请选择要上传的文件");
    const maxBytes = input.type === "image" ? cfg.submissions.maxImageBytes : cfg.submissions.maxAudioBytes;
    if (file.size > maxBytes)
      throw new SubmissionError("media_too_large", `文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    // 声明 MIME 不可信：按字节签名验证（图片/音频魔数）。
    const verified = verifyUploadContent(bytes, file.type || "");
    if (!verified.ok || verified.detected?.family !== (input.type === "image" ? "image" : "audio")) {
      throw new SubmissionError("media_invalid", "文件内容与类型不符或无法识别");
    }
    const store = createMediaStore({ MEDIA: env.MEDIA, MEDIA_KV: env.MEDIA_KV });
    const storageKey = `media:submission:${crypto.randomUUID()}`;
    await store.put({ storageKey, bytes, contentType: verified.detected?.mime ?? file.type });
    const asset = await createMediaAsset(db, {
      scope: "response",
      mediaType: input.type === "image" ? "photo" : "audio",
      storageKind: store.kind,
      storageKey,
      expiresAt: null,
      mimeType: verified.detected?.mime ?? file.type,
      fileName: file.name || null,
      fileSize: bytes.byteLength,
    });
    mediaAssetId = asset.id;
    // 缩略图：客户端生成（浏览器 canvas）。同样做字节签名校验，
    // 校验不过就放弃缩略图而不是存下一团不可信数据。
    if (input.type === "image" && input.thumbFile && input.thumbFile.size > 0) {
      const thumbBytes = new Uint8Array(await input.thumbFile.arrayBuffer());
      const thumbType = (input.thumbFile.type || "image/jpeg").toLowerCase();
      const thumbVerified = verifyUploadContent(thumbBytes, thumbType);
      if (thumbVerified.ok && thumbVerified.detected?.family === "image") {
        const thumbKey = `media:submission:${crypto.randomUUID()}`;
        await store.put({ storageKey: thumbKey, bytes: thumbBytes, contentType: thumbVerified.detected.mime });
        const thumbAsset = await createMediaAsset(db, {
          scope: "response",
          mediaType: "photo",
          storageKind: store.kind,
          storageKey: thumbKey,
          expiresAt: null,
          mimeType: thumbVerified.detected.mime,
          fileName: null,
          fileSize: thumbBytes.byteLength,
        });
        thumbMediaAssetId = thumbAsset.id;
      }
    }
    // 音频时长：客户端探测；服务端只做范围合理性钳制后存展示值。
    if (input.type === "audio" && Number.isFinite(Number(input.durationSeconds))) {
      const seconds = Math.max(0, Math.min(3600, Math.floor(Number(input.durationSeconds))));
      mediaDurationSeconds = seconds > 0 ? seconds : null;
    }
    contentHash = await sha256Hex(bytes);
  } else if (input.type === "survey_report" || input.type === "profile_card") {
    // 公开自己的答卷报告/资料卡：答卷必须属于当前参与者且已完成。
    // 注意：公开的是本人的答卷，不涉及其他答题者的数据。
    const rid = Number(input.responseId);
    if (!Number.isInteger(rid) || rid <= 0) throw new SubmissionError("response_required", "请选择你的答卷");
    const response = await db
      .prepare(`SELECT id, survey_id AS surveyId, participant_hash AS hash, status FROM survey_responses WHERE id = ?`)
      .bind(rid)
      .first<{ id: number; surveyId: number; hash: string; status: string }>();
    if (!response || response.hash !== participant.participantHash) {
      throw new SubmissionError("response_not_owned", "只能投稿你自己的答卷");
    }
    if (response.status !== "completed") {
      throw new SubmissionError("response_incomplete", "该答卷尚未完成");
    }
    responseId = rid;
    surveyId = Number(response.surveyId);
    contentHash = await sha256Hex(new TextEncoder().encode(`${input.type}:${rid}`));
  } else {
    throw new SubmissionError("invalid_type", "不支持的投稿类型");
  }

  // 第三层内容安全：外部适配器（管理员配置后才调用）。默认返回
  // consulted=false / action=review，即照旧人工审核——绝不伪造结果。
  const moderation = await moderateSubmission(env, {
    type: input.type,
    title,
    description,
    text: contentText,
    mediaUrl: mediaAssetId === null ? null : `/api/submissions/media/${mediaAssetId}`,
  });
  if (moderation.action === "reject") {
    throw new SubmissionError(
      "content_rejected",
      moderation.reason ? `内容未通过安全检测：${moderation.reason}` : "内容未通过安全检测，请调整后重试",
    );
  }

  const now = new Date().toISOString();
  // 自动通过的两个入口：低风险文本（管理员开关，默认关）与外部适配器明确
  // 判定的 approve。其余一律人工。
  const status =
    moderation.action === "approve" || (input.type === "text" && cfg.submissions.autoApproveText)
      ? "approved"
      : "pending";
  try {
    const result = await db
      .prepare(
        `INSERT INTO submissions
           (participant_hash, user_id, type, title, description, content_text, media_asset_id,
            thumb_media_asset_id, media_duration_seconds,
            survey_id, response_id, status, content_hash, authorization_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        participant.participantHash,
        participant.dbUserId,
        input.type,
        title,
        description,
        contentText,
        mediaAssetId,
        thumbMediaAssetId,
        mediaDurationSeconds,
        surveyId,
        responseId,
        status,
        contentHash,
        JSON.stringify({
          publishToPool: input.authorization.publishToPool === true,
          allowCollection: input.authorization.allowCollection !== false,
          confirmedAt: now,
        }),
        now,
        now,
      )
      .run();
    return { id: Number(result.meta.last_row_id), status, duplicate: false, moderation };
  } catch (error) {
    if (
      /UNIQUE constraint failed.*idx_submissions_dedup|submissions\.participant_hash/i.test(
        String((error as Error)?.message ?? ""),
      )
    ) {
      throw new SubmissionError("duplicate_content", "相同内容已提交过，请勿重复投稿");
    }
    throw error;
  }
}

/** 投稿奖励：审核通过时发放。幂等 + 每日上限。返回 null 表示因上限未发放。 */
export async function grantSubmissionReward(
  db: D1Database,
  submissionId: number,
  participant: { participantHash: string; userId: number | null },
  qualityTier: 1 | 2 | 3,
): Promise<{ amount: number; capped: boolean } | null> {
  const cfg = await loadCoinConfig(db);
  const row = await db
    .prepare(`SELECT type FROM submissions WHERE id = ?`)
    .bind(submissionId)
    .first<{ type: string }>();
  if (!row) return null;
  const base = cfg.submissions.baseRewards[row.type] ?? 0;
  if (base <= 0) return { amount: 0, capped: false };
  const tierMultiplier = cfg.submissions.tierMultipliers[qualityTier - 1] ?? 1;
  let amount = Math.max(1, Math.round(base * tierMultiplier));

  // 每日奖励上限：统计今日已发的投稿奖励（有据可查，不删流水）。
  const today = coinDayKey(Date.now(), cfg.timezoneOffsetMinutes);
  const usedRow = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM coin_transactions
       WHERE participant_hash = ? AND kind = 'submission_reward' AND created_at >= ?`,
    )
    .bind(participant.participantHash, `${today}T00:00:00Z`)
    .first<{ n: number }>();
  const used = Number(usedRow?.n ?? 0);
  let capped = false;
  if (used + amount > cfg.submissions.dailyRewardCap) {
    amount = Math.max(0, cfg.submissions.dailyRewardCap - used);
    capped = true;
  }
  if (amount <= 0) return { amount: 0, capped: true };

  const reward = await earnCoins(db, {
    participantHash: participant.participantHash,
    userId: participant.userId,
    amount,
    kind: "submission_reward",
    idempotencyKey: `submission:${submissionId}`,
    refType: "submission",
    refId: String(submissionId),
    note: `投稿奖励（质量档 ${qualityTier}）`,
  });
  return { amount: reward.duplicate ? 0 : amount, capped };
}

export async function getSubmissionById(db: D1Database, id: number) {
  return db
    .prepare(
      `SELECT id, participant_hash AS participantHash, user_id AS userId, type, title, description,
              content_text AS contentText, media_asset_id AS mediaAssetId, survey_id AS surveyId,
              response_id AS responseId, status, quality_tier AS qualityTier, reward_amount AS rewardAmount,
              reviewer_id AS reviewerId, review_note AS reviewNote, created_at AS createdAt
       FROM submissions WHERE id = ?`,
    )
    .bind(id)
    .first();
}

export async function listSubmissionsFor(db: D1Database, participantHash: string) {
  const result = await db
    .prepare(
      `SELECT id, type, title, description, status, quality_tier AS qualityTier,
              reward_amount AS rewardAmount, review_note AS reviewNote,
              media_asset_id AS mediaAssetId, thumb_media_asset_id AS thumbMediaAssetId,
              media_duration_seconds AS mediaDurationSeconds, created_at AS createdAt
       FROM submissions WHERE participant_hash = ? ORDER BY id DESC LIMIT 100`,
    )
    .bind(participantHash)
    .all();
  return result.results ?? [];
}

/** 用户撤回：状态机单向；进池内容立即失去"可抽取"资格。 */
export async function withdrawSubmission(
  db: D1Database,
  participantHash: string,
  submissionId: number,
): Promise<boolean> {
  const row = await getSubmissionById(db, submissionId);
  if (!row || String(row.participantHash) !== participantHash) return false;
  const status = String(row.status);
  if (status === "withdrawn" || status === "removed") return true;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE submissions SET status = 'withdrawn', updated_at = ?
         WHERE id = ? AND participant_hash = ?`,
      )
      .bind(now, submissionId, participantHash),
    db.prepare(`UPDATE gacha_pool_items SET active = 0 WHERE submission_id = ?`).bind(submissionId),
  ]);
  return true;
}

/** 投稿媒体读取授权：所有者/管理员放行，公开状态（approved/in_pool）放行。 */
export async function canViewSubmissionMedia(
  db: D1Database,
  submissionId: number,
  viewer: { participantHash: string; dbUserId: number | null; isAdmin: boolean },
): Promise<{ ok: boolean; mediaAssetId: number | null }> {
  const row = await getSubmissionById(db, submissionId);
  if (!row) return { ok: false, mediaAssetId: null };
  const status = String(row.status);
  const isOwner = String(row.participantHash) === viewer.participantHash;
  const publicStatus = status === "approved" || status === "in_pool";
  if (!publicStatus && !isOwner && !viewer.isAdmin) return { ok: false, mediaAssetId: null };
  const assetId = row.mediaAssetId == null ? null : Number(row.mediaAssetId);
  return { ok: assetId !== null, mediaAssetId: assetId };
}

/** 管理端审核：通过（含奖励）/拒绝/需修改。状态机与审计由调用方写 audit。 */
export async function reviewSubmission(
  db: D1Database,
  submissionId: number,
  decision: "approved" | "rejected" | "changes_requested",
  reviewerId: string,
  options: { qualityTier?: 1 | 2 | 3; note?: string; addToPool?: boolean },
): Promise<{ ok: boolean; reward: number | null; capped: boolean }> {
  const row = (await getSubmissionById(db, submissionId)) as
    (Record<string, unknown> & { participantHash: string; userId: number | null; status: string }) | null;
  if (!row) throw new SubmissionError("not_found", "投稿不存在");
  const status = String(row.status);
  if (!["pending", "changes_requested", "approved"].includes(status)) {
    throw new SubmissionError("invalid_state", `当前状态 ${status} 不可审核`);
  }
  const now = new Date().toISOString();
  const qualityTier = options.qualityTier ?? 2;

  if (decision === "approved") {
    // 已批准过（in_pool/approved）的重复"通过"不再发奖——幂等。
    const alreadyRewarded = row.rewardAmount != null;
    await db
      .prepare(
        `UPDATE submissions SET status = 'approved', quality_tier = ?, review_note = ?, reviewer_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(qualityTier, options.note ?? null, reviewerId, now, submissionId)
      .run();
    let reward: number | null = null;
    let capped = false;
    if (!alreadyRewarded) {
      const grant = await grantSubmissionReward(
        db,
        submissionId,
        { participantHash: String(row.participantHash), userId: row.userId == null ? null : Number(row.userId) },
        qualityTier,
      );
      if (grant) {
        reward = grant.amount;
        capped = grant.capped;
        if (grant.amount > 0) {
          const txn = await db
            .prepare(`SELECT id FROM coin_transactions WHERE idempotency_key = ?`)
            .bind(`submission:${submissionId}`)
            .first<{ id: number }>();
          await db
            .prepare(`UPDATE submissions SET reward_amount = ?, reward_transaction_id = ? WHERE id = ?`)
            .bind(grant.amount, txn?.id ?? null, submissionId)
            .run();
        }
      }
    }
    return { ok: true, reward, capped };
  }

  await db
    .prepare(`UPDATE submissions SET status = ?, review_note = ?, reviewer_id = ?, updated_at = ? WHERE id = ?`)
    .bind(decision, options.note ?? null, reviewerId, now, submissionId)
    .run();
  return { ok: true, reward: null, capped: false };
}

/** 管理端：把投稿加入奖池（生成条目并推进奖池版本）。 */
export async function addSubmissionToPool(
  db: D1Database,
  submissionId: number,
  poolId: number,
  rarity: "N" | "R" | "SR" | "SSR",
  options: { weight?: number; stock?: number | null } = {},
): Promise<{ itemId: number; poolVersion: number }> {
  const row = await getSubmissionById(db, submissionId);
  if (!row) throw new SubmissionError("not_found", "投稿不存在");
  if (!["approved", "in_pool"].includes(String(row.status))) {
    throw new SubmissionError("invalid_state", "只有审核通过的投稿能进池");
  }
  const pool = await db
    .prepare(`SELECT id, version FROM gacha_pools WHERE id = ?`)
    .bind(poolId)
    .first<{ id: number; version: number }>();
  if (!pool) throw new SubmissionError("pool_not_found", "奖池不存在");
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT INTO gacha_pool_items
         (pool_id, submission_id, owner_participant_hash, title, description, content_type,
          rarity, weight, stock, remaining, preview_media_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      poolId,
      submissionId,
      String(row.participantHash),
      String(row.title),
      String(row.description ?? ""),
      String(row.type),
      rarity,
      options.weight ?? 10,
      options.stock ?? null,
      options.stock ?? null,
      row.mediaAssetId == null ? null : Number(row.mediaAssetId),
      now,
    )
    .run();
  const version = Number(pool.version) + 1;
  // 新版本快照：旧抽取记录仍指向旧版本，审计可回放。
  const items = await db
    .prepare(
      `SELECT id, submission_id, title, description, content_type, rarity, weight, stock, preview_media_id
       FROM gacha_pool_items WHERE pool_id = ? AND active = 1`,
    )
    .bind(poolId)
    .all();
  await db.batch([
    db
      .prepare(
        `INSERT INTO gacha_pool_versions (pool_id, version, snapshot, created_at, created_by)
                VALUES (?, ?, ?, ?, 'admin')`,
      )
      .bind(poolId, version, JSON.stringify({ items: items.results ?? [] }), now),
    db.prepare(`UPDATE gacha_pools SET version = ?, updated_at = ? WHERE id = ?`).bind(version, now, poolId),
    db.prepare(`UPDATE submissions SET status = 'in_pool', updated_at = ? WHERE id = ?`).bind(now, submissionId),
  ]);
  return { itemId: Number(inserted.meta.last_row_id), poolVersion: version };
}
