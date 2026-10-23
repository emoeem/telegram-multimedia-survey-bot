import type { Env } from "../index";
import { fail, json } from "./api-response";
import { resolveParticipant } from "./survey/participant";
import { isParticipantAgeVerified, r18ParticipantGate } from "../services/content-rating.service";
import { checkAtomicRateLimit, rateLimitResponse } from "../services/rate-limit.service";
import { getCoinAccountOrCreate } from "../services/coin/ledger.service";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { backfillCheckin, getCheckinStatus, performCheckin, listCheckinDays } from "../services/coin/checkin.service";
import { listChallengesFor, claimChallenge, ChallengeError } from "../services/coin/challenge.service";
import { loadCoinConfig, coinDayKey } from "../services/coin/config.service";
import { resolveCoinGate, unlockSurvey, listUnlocksFor, getSurveyCoinAccess } from "../services/coin/unlock.service";
import {
  listActivePools,
  getPoolBySlug,
  loadPoolSnapshot,
  pullGacha,
  listPullsFor,
  canViewItem,
  GachaError,
} from "../services/coin/gacha.service";
import {
  SUBMISSION_TYPES,
  createSubmission,
  getSubmissionById,
  listSubmissionsFor,
  withdrawSubmission,
  canViewSubmissionMedia,
  SubmissionError,
  type SubmissionType,
  type CreateSubmissionInput,
} from "../services/coin/submission.service";
import { getSurveyById } from "../db/repositories/survey.repository";
import { buildMediaResponse } from "../services/media/media-serve.service";
import { createReportAccessToken } from "../services/report-access-token.service";

/**
 * 金币经济 · 用户侧 API（/api/coins、/api/gacha、/api/submissions）。
 *
 * 身份沿用参与者解析（participant_hash）。所有写路径都过原子限流，幂等键
 * 由客户端生成但格式受限；金额、进度、结果一律服务端决定。
 */

function adminIdsOf(env: Env): number[] {
  return String(env.ADMIN_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value));
}

export async function handleCoinApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/coins/") && !path.startsWith("/api/gacha/") && !path.startsWith("/api/submissions")) {
    return null;
  }
  const participantResult = await resolveParticipant(request, env);
  if (participantResult instanceof Response) return participantResult;
  const participant = participantResult;

  const respond = async <T>(handler: () => Promise<T>): Promise<Response> => {
    try {
      return json(await handler());
    } catch (error) {
      if (error instanceof SubmissionError) return fail(400, error.code, error.message);
      if (error instanceof GachaError) return fail(400, error.code, error.message);
      if (error instanceof ChallengeError) return fail(400, error.code, error.message);
      if (error instanceof Error && error.name === "CoinLedgerError") {
        const code = (error as { code?: string }).code;
        if (code === "insufficient_funds") return fail(402, "insufficient_coins", error.message);
        return fail(400, code ?? "coin_error", error.message);
      }
      console.error("Coin API failed", { path, error });
      return fail(500, "coin_internal", "金币服务暂时不可用，请稍后重试");
    }
  };

  // ---- 金币账户与明细 -------------------------------------------------
  if (request.method === "GET" && path === "/api/coins/overview") {
    return respond(async () => {
      const cfg = await loadCoinConfig(env.DB);
      const account = await getCoinAccountOrCreate(env.DB, participant.participantHash, participant.dbUserId);
      const checkin = await getCheckinStatus(env.DB, participant.participantHash, cfg);
      const checkinDays = await listCheckinDays(env.DB, participant.participantHash, cfg.timezoneOffsetMinutes);
      const today = coinDayKey(Date.now(), cfg.timezoneOffsetMinutes);
      const earnedToday = await env.DB.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS n FROM coin_transactions
           WHERE participant_hash = ? AND amount > 0 AND kind IN ('checkin','challenge','submission_reward')
             AND created_at >= ?`,
      )
        .bind(participant.participantHash, `${today}T00:00:00Z`)
        .first<{ n: number }>();
      return {
        balance: account.balance,
        totalEarned: account.totalEarned,
        totalSpent: account.totalSpent,
        checkin: {
          ...checkin,
          days: checkinDays,
          // 补签入口只在管理员开启时显示；价格与窗口由服务端下发。
          backfill: cfg.checkin.backfill.enabled
            ? { enabled: true, cost: cfg.checkin.backfill.cost, maxDays: cfg.checkin.backfill.maxBackfillDays }
            : { enabled: false, cost: 0, maxDays: 0 },
        },
        earnedToday: Number(earnedToday?.n ?? 0),
        dailyRewardCap: cfg.submissions.dailyRewardCap,
        features: {
          checkin: cfg.checkin.enabled,
          challenges: cfg.challenges.enabled,
          gacha: cfg.gacha.enabled,
          submissions: cfg.submissions.enabled,
        },
      };
    });
  }

  if (request.method === "POST" && path === "/api/coins/checkin") {
    const limiter = await checkAtomicRateLimit(env.DB, env.CACHE, "coin-checkin", participant.participantHash, 5, 3600);
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    return respond(async () => {
      const result = await performCheckin(env.DB, participant.participantHash, participant.dbUserId);
      return result;
    });
  }

  if (request.method === "POST" && path === "/api/coins/checkin/backfill") {
    const limiter = await checkAtomicRateLimit(
      env.DB,
      env.CACHE,
      "coin-backfill",
      participant.participantHash,
      5,
      3600,
    );
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    return respond(async () => {
      const body = (await request.json().catch(() => null)) as { day?: unknown } | null;
      const day = typeof body?.day === "string" ? body.day : "";
      return backfillCheckin(env.DB, participant.participantHash, participant.dbUserId, day);
    });
  }

  if (request.method === "GET" && path === "/api/coins/transactions") {
    return respond(async () => {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
      const kindFilter = url.searchParams.get("kind");
      const pageSize = 20;
      const where = kindFilter ? `AND kind = ?` : "";
      const params = kindFilter ? [participant.participantHash, kindFilter] : [participant.participantHash];
      const rows = await env.DB.prepare(
        `SELECT id, amount, balance_after AS balanceAfter, kind, ref_type AS refType, ref_id AS refId,
                  note, created_at AS createdAt
           FROM coin_transactions WHERE participant_hash = ? ${where}
           ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
        .bind(...params, pageSize + 1, (page - 1) * pageSize)
        .all();
      const items = rows.results ?? [];
      return { items: items.slice(0, pageSize), hasMore: items.length > pageSize, page };
    });
  }

  // ---- 挑战 -----------------------------------------------------------
  if (request.method === "GET" && path === "/api/coins/challenges") {
    return respond(async () => ({ challenges: await listChallengesFor(env.DB, participant.participantHash) }));
  }

  const challengeClaimMatch = path.match(/^\/api\/coins\/challenges\/(\d+)\/claim$/);
  if (request.method === "POST" && challengeClaimMatch) {
    const limiter = await checkAtomicRateLimit(env.DB, env.CACHE, "coin-claim", participant.participantHash, 10, 3600);
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    return respond(async () =>
      claimChallenge(env.DB, participant.participantHash, participant.dbUserId, Number(challengeClaimMatch[1])),
    );
  }

  // ---- 问卷解锁 -------------------------------------------------------
  if (request.method === "GET" && path === "/api/coins/unlocks") {
    return respond(async () => ({ unlocks: await listUnlocksFor(env.DB, participant.participantHash) }));
  }

  const unlockMatch = path.match(/^\/api\/coins\/unlock\/(\d+)$/);
  if (request.method === "POST" && unlockMatch) {
    const limiter = await checkAtomicRateLimit(env.DB, env.CACHE, "coin-unlock", participant.participantHash, 10, 600);
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    return respond(async () => {
      const survey = await getSurveyById(env.DB, Number(unlockMatch[1]));
      if (!survey || survey.status !== "published") return fail(404, "survey_unavailable", "问卷不存在或未发布");
      const access = await getSurveyCoinAccess(env.DB, survey.id);
      if (!access || !Number(access.enabled)) {
        // 免费问卷：直接告知无需解锁（前端据此放行）。
        return { ok: true, required: false, duplicate: false, pricePaid: 0 };
      }
      const body = (await request.json().catch(() => null)) as { idempotencyKey?: unknown } | null;
      const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "";
      const gate = await resolveCoinGate(env.DB, survey, participant, adminIdsOf(env));
      if (gate.unlocked) return { ok: true, required: true, duplicate: true, pricePaid: 0 };
      const result = await unlockSurvey(
        env.DB,
        { id: survey.id, ownerId: survey.ownerId },
        participant,
        idempotencyKey,
      );
      return { required: true, ...result };
    });
  }

  // ---- 抽卡 -----------------------------------------------------------
  if (request.method === "GET" && path === "/api/gacha/pools") {
    return respond(async () => {
      const ageVerified = await isParticipantAgeVerified(env.DB, participant);
      const pools = (await listActivePools(env.DB)).filter((pool) => pool.contentRating === "all" || ageVerified);
      return {
        pools: pools.map((pool) => ({
          slug: pool.slug,
          name: pool.name,
          description: pool.description,
          costSingle: pool.costSingle,
          costMulti: pool.costMulti,
          endAt: pool.endAt,
          pityAt: pool.pityAt,
        })),
      };
    });
  }

  const poolDetailMatch = path.match(/^\/api\/gacha\/pools\/([A-Za-z0-9_-]+)$/);
  if (request.method === "GET" && poolDetailMatch) {
    return respond(async () => {
      const pool = await getPoolBySlug(env.DB, String(poolDetailMatch[1]));
      if (!pool || pool.status !== "active") return fail(404, "pool_not_found", "奖池不存在或未开放");
      const detailAgeGate = await r18ParticipantGate(env.DB, pool, participant);
      if (detailAgeGate) return detailAgeGate;
      const items = await loadPoolSnapshot(env.DB, pool);
      // 概率公示：与抽取算法同源（同一快照、同一权重）。
      const totalWeight = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
      return {
        pool: {
          slug: pool.slug,
          name: pool.name,
          description: pool.description,
          costSingle: pool.costSingle,
          costMulti: pool.costMulti,
          endAt: pool.endAt,
          pityAt: pool.pityAt,
        },
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          contentType: item.contentType,
          rarity: item.rarity,
          rate: totalWeight > 0 ? Math.round((Math.max(0, item.weight) / totalWeight) * 10000) / 100 : 0,
          soldOut: item.stock !== null && item.stock <= 0,
        })),
        rules: {
          currency: "金币（站内虚拟积分，不可兑换现金）",
          access: "抽中默认永久收藏，作者撤回后按平台规则停止展示",
          pity: pool.pityAt ? `连续 ${pool.pityAt} 抽未出 SR 及以上时必定获得 SR/SSR` : null,
        },
      };
    });
  }

  const pullMatch = path.match(/^\/api\/gacha\/pools\/([A-Za-z0-9_-]+)\/pull$/);
  if (request.method === "POST" && pullMatch) {
    const limiter = await checkAtomicRateLimit(env.DB, env.CACHE, "gacha-pull", participant.participantHash, 30, 3600);
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    return respond(async () => {
      const pool = await getPoolBySlug(env.DB, String(pullMatch[1]));
      if (!pool) return fail(404, "pool_not_found", "奖池不存在");
      const pullAgeGate = await r18ParticipantGate(env.DB, pool, participant);
      if (pullAgeGate) return pullAgeGate;
      const body = (await request.json().catch(() => null)) as { count?: unknown; idempotencyKey?: unknown } | null;
      const count = Number(body?.count ?? 1);
      const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "";
      const result = await pullGacha(env, pool, participant, count, idempotencyKey);
      if (result.insufficient) return fail(402, "insufficient_coins", "金币不足");
      if (result.poolEmpty) return fail(409, "pool_empty", "奖池已空");
      return result;
    });
  }

  if (request.method === "GET" && path === "/api/gacha/collection") {
    return respond(async () => ({ items: await listPullsFor(env.DB, participant.participantHash) }));
  }

  // 抽中内容的展示版本：报告走短时签名 URL（权限以抽取记录为准），文字
  // 直接给内容，媒体走受权端点——不暴露后台原始数据与作者账号信息。
  const itemContentMatch = path.match(/^\/api\/gacha\/items\/(\d+)\/content$/);
  if (request.method === "GET" && itemContentMatch) {
    return respond(async () => {
      const itemId = Number(itemContentMatch[1]);
      if (!(await canViewItem(env.DB, participant.participantHash, itemId))) {
        return fail(403, "not_owned", "尚未获得该内容");
      }
      const item = await env.DB.prepare(
        `SELECT item.id, item.title, item.description, item.content_type AS contentType,
                  item.media_asset_id AS mediaAssetId, item.submission_id AS submissionId,
                  COALESCE(item.preview_media_id, sub.thumb_media_asset_id, sub.media_asset_id) AS previewAssetId,
                  sub.content_text AS contentText, sub.response_id AS responseId,
                  sub.media_duration_seconds AS mediaDurationSeconds,
                  sub.owner_participant_hash = ? AS isOwn
           FROM gacha_pool_items item
           LEFT JOIN submissions sub ON sub.id = item.submission_id
           WHERE item.id = ?`,
      )
        .bind(participant.participantHash, itemId)
        .first();
      if (!item) return fail(404, "not_found", "内容不存在");
      const base = {
        id: Number(item.id),
        title: String(item.title),
        description: String(item.description ?? ""),
        contentType: String(item.contentType),
      };
      if (item.contentType === "survey_report" || item.contentType === "profile_card") {
        // 独立展示版本：概要 + 短时报告链接（7 天），不透出原始答题数据。
        const responseId = item.responseId == null ? null : Number(item.responseId);
        let reportUrl: string | null = null;
        if (responseId != null) {
          const token = await createReportAccessToken(
            env.WEBHOOK_SECRET,
            responseId,
            Math.floor(Date.now() / 1000),
            7 * 86_400,
          );
          reportUrl = `/report/${responseId}?t=${token}`;
        }
        return { ...base, reportUrl, summary: "该内容为答卷报告的展示版本；作答明细与作者账号信息不可见。" };
      }
      if (item.contentText) return { ...base, text: String(item.contentText) };
      if (item.mediaAssetId != null) {
        return {
          ...base,
          mediaUrl: `/api/submissions/media/${Number(item.mediaAssetId)}`,
          previewUrl: item.previewAssetId != null ? `/api/submissions/media/${Number(item.previewAssetId)}` : null,
          ...(item.mediaDurationSeconds != null ? { durationSeconds: Number(item.mediaDurationSeconds) } : {}),
        };
      }
      return base;
    });
  }

  // ---- 投稿 -----------------------------------------------------------
  if (request.method === "GET" && path === "/api/submissions") {
    return respond(async () => ({ submissions: await listSubmissionsFor(env.DB, participant.participantHash) }));
  }

  if (request.method === "POST" && path === "/api/submissions") {
    const limiter = await checkAtomicRateLimit(
      env.DB,
      env.CACHE,
      "submission-create",
      participant.participantHash,
      5,
      86_400,
    );
    if (!limiter.allowed) return rateLimitResponse(limiter.retryAfterSeconds);
    return respond(async () => {
      let input: CreateSubmissionInput;
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData().catch(() => null);
        if (!form) return fail(400, "invalid_form", "表单解析失败");
        const type = String(form.get("type") ?? "") as SubmissionType;
        const file = form.get("file");
        const thumb = form.get("thumb");
        const durationRaw = Number(form.get("durationSeconds"));
        input = {
          type,
          title: String(form.get("title") ?? ""),
          description: (form.get("description") as string) || null,
          contentText: (form.get("contentText") as string) || null,
          file: file instanceof File ? file : null,
          thumbFile: thumb instanceof File ? thumb : null,
          durationSeconds: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null,
          responseId: Number(form.get("responseId") ?? 0) || null,
          authorization: {
            publishToPool: String(form.get("publishToPool") ?? "") === "true",
            allowCollection: String(form.get("allowCollection") ?? "true") !== "false",
            confirmOwn: String(form.get("confirmOwn") ?? "") === "true",
          },
        };
      } else {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return fail(400, "invalid_json", "请求体无效");
        input = {
          type: String(body.type ?? "") as SubmissionType,
          title: String(body.title ?? ""),
          description: typeof body.description === "string" ? body.description : null,
          contentText: typeof body.contentText === "string" ? body.contentText : null,
          responseId: typeof body.responseId === "number" ? body.responseId : null,
          authorization: {
            publishToPool: body.publishToPool === true,
            allowCollection: body.allowCollection !== false,
            confirmOwn: body.confirmOwn === true,
          },
        };
      }
      if (!SUBMISSION_TYPES.includes(input.type)) return fail(400, "invalid_type", "不支持的投稿类型");
      const created = await createSubmission(env, participant, input);
      return created;
    });
  }

  const withdrawMatch = path.match(/^\/api\/submissions\/(\d+)\/withdraw$/);
  if (request.method === "POST" && withdrawMatch) {
    return respond(async () => {
      const ok = await withdrawSubmission(env.DB, participant.participantHash, Number(withdrawMatch[1]));
      if (!ok) return fail(404, "not_found", "投稿不存在");
      return { ok: true };
    });
  }

  // 投稿媒体读取：按投稿状态授权（撤回/下架/待审 → 仅作者与管理员）。
  const submissionMediaMatch = path.match(/^\/api\/submissions\/media\/(\d+)$/);
  if (request.method === "GET" && submissionMediaMatch) {
    const telegramUserId = participant.telegramUserId ?? -1;
    const viewer = {
      participantHash: participant.participantHash,
      dbUserId: participant.dbUserId,
      isAdmin: adminIdsOf(env).includes(telegramUserId),
    };
    const access = await canViewSubmissionMedia(env.DB, Number(submissionMediaMatch[1]), viewer);
    if (!access.ok || access.mediaAssetId === null) return fail(404, "not_found", "内容不存在或未公开");
    const asset = await getMediaAssetById(env.DB, access.mediaAssetId);
    if (!asset) return fail(404, "not_found", "媒体不存在");
    const media = await buildMediaResponse(env, asset);
    return media ?? fail(503, "media_unavailable", "媒体暂不可读");
  }

  return fail(404, "not_found", "接口不存在");
}
