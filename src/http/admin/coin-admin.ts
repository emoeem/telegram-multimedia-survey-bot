import type { Env } from "../../index";
import type { WriteContext } from "./helpers";
import { writeAudit } from "./helpers";
import { loadCoinConfig, saveCoinConfigSection, type CoinEconomyConfig } from "../../services/coin/config.service";
import { getCoinAccount, describeAdjustStatements } from "../../services/coin/ledger.service";
import { getUserById, getUserByTelegramId } from "../../db/repositories/user.repository";
import { getSubmissionById, reviewSubmission, addSubmissionToPool, SubmissionError } from "../../services/coin/submission.service";
import { getPoolById, loadPoolSnapshot } from "../../services/coin/gacha.service";

/**
 * 金币经济 · 管理端 API（/api/admin/coins、/api/admin/gacha、/api/admin/submissions）。
 *
 * 权限：仅平台管理员（isAdmin）。调账必须写原因并落 audit_logs；流水不可改删，
 * 纠错走反向 admin_adjust 流水。
 */

const COIN_SECTIONS = new Set(["checkin", "challenges", "pricing", "submissions", "gacha", "moderation"]);

function assertAdmin(ctx: WriteContext): Response | null {
  if (!ctx.isAdmin) return ctx.fail(403, "admin_required", "需要管理员权限");
  return null;
}

function adminActor(ctx: WriteContext): string {
  return `admin:${ctx.user?.id ?? "unknown"}`;
}

async function resolveParticipantHashForAdmin(
  db: D1Database,
  body: Record<string, unknown>,
): Promise<{ hash: string; userId: number | null } | null> {
  if (typeof body.participantHash === "string" && body.participantHash.length >= 8) {
    return { hash: body.participantHash, userId: null };
  }
  const userId = Number(body.userId);
  if (Number.isInteger(userId) && userId > 0) {
    const user = await getUserById(db, userId);
    if (!user) return null;
    // 与 participant 链接机制一致的 hash 由参与者体系生成；这里通过用户 id
    // 反查 participant_links。若无绑定则退化为 user_id 键（详见迁移注释）。
    const link = await db
      .prepare(`SELECT participant_hash FROM participant_links WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(userId)
      .first<{ participant_hash: string }>();
    if (link) return { hash: link.participant_hash, userId };
    return { hash: `user:${userId}`, userId };
  }
  const telegramId = Number(body.telegramUserId);
  if (Number.isInteger(telegramId) && telegramId > 0) {
    const user = await getUserByTelegramId(db, telegramId);
    if (!user) return null;
    const link = await db
      .prepare(`SELECT participant_hash FROM participant_links WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(user.id)
      .first<{ participant_hash: string }>();
    if (link) return { hash: link.participant_hash, userId: user.id };
    return { hash: `user:${user.id}`, userId: user.id };
  }
  return null;
}

export async function handleCoinAdminApi(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
): Promise<Response | null> {
  const path = url.pathname;
  if (
    !path.startsWith("/api/admin/coins") &&
    !path.startsWith("/api/admin/gacha") &&
    !path.startsWith("/api/admin/submissions")
  ) {
    return null;
  }
  const denied = assertAdmin(ctx);
  if (denied) return denied;
  const { fail, json } = ctx;
  const db = env.DB;

  const respond = async <T>(handler: () => Promise<T>): Promise<Response> => {
    try {
      return json(await handler());
    } catch (error) {
      if (error instanceof SubmissionError) return fail(400, error.code, error.message);
      if (error instanceof Error && error.name === "CoinLedgerError") {
        return fail(400, (error as { code?: string }).code ?? "coin_error", error.message);
      }
      console.error("Coin admin API failed", { path, error });
      return fail(500, "coin_admin_internal", "金币管理操作失败，请稍后重试");
    }
  };

  // ---- 运营配置 --------------------------------------------------------
  if (request.method === "GET" && path === "/api/admin/coins/config") {
    return respond(async () => loadCoinConfig(db));
  }
  if (request.method === "PUT" && path === "/api/admin/coins/config") {
    return respond(async () => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail(400, "invalid_body", "请求体必须是 JSON 对象");
      const section = String(body.section ?? "");
      if (!COIN_SECTIONS.has(section)) return fail(400, "invalid_section", "未知的配置分区");
      const value = body.value;
      if (!value || typeof value !== "object") return fail(400, "invalid_value", "配置值必须是对象");
      // 关键数值边界：不合法的上下限会直接破坏定价/奖励体系。
      if (section === "pricing") {
        const pricing = value as Partial<CoinEconomyConfig["pricing"]>;
        if (
          (pricing.minPrice !== undefined && (!Number.isInteger(pricing.minPrice) || pricing.minPrice < 0)) ||
          (pricing.maxPrice !== undefined && (!Number.isInteger(pricing.maxPrice) || pricing.maxPrice < 1))
        ) {
          return fail(400, "invalid_pricing", "价格上下限必须是非负整数且上限大于 0");
        }
        if (
          pricing.minPrice !== undefined &&
          pricing.maxPrice !== undefined &&
          pricing.minPrice > pricing.maxPrice
        ) {
          return fail(400, "invalid_pricing", "最低价不能高于最高价");
        }
      }
      if (section === "checkin") {
        const checkin = value as { backfill?: { enabled?: unknown; cost?: unknown; maxBackfillDays?: unknown } };
        const backfill = checkin.backfill;
        if (backfill) {
          if (backfill.cost !== undefined && (!Number.isInteger(Number(backfill.cost)) || Number(backfill.cost) < 0)) {
            return fail(400, "invalid_backfill", "补签费用必须是非负整数");
          }
          if (
            backfill.maxBackfillDays !== undefined &&
            (!Number.isInteger(Number(backfill.maxBackfillDays)) ||
              Number(backfill.maxBackfillDays) < 1 ||
              Number(backfill.maxBackfillDays) > 60)
          ) {
            return fail(400, "invalid_backfill", "补签窗口必须是 1..60 天");
          }
        }
      }
      if (section === "moderation") {
        const moderation = value as { enabled?: unknown; endpoint?: unknown; rejectBelow?: unknown; approveAbove?: unknown };
        if (moderation.enabled === true && typeof moderation.endpoint !== "string") {
          return fail(400, "invalid_moderation", "启用审核服务需要配置 endpoint");
        }
        if (typeof moderation.endpoint === "string" && moderation.endpoint && !/^https:\/\//.test(moderation.endpoint)) {
          return fail(400, "invalid_moderation", "endpoint 必须是 https 地址");
        }
        const rejectBelow = Number(moderation.rejectBelow ?? 0.85);
        const approveAbove = Number(moderation.approveAbove ?? 0.2);
        if (!Number.isFinite(rejectBelow) || !Number.isFinite(approveAbove) || approveAbove >= rejectBelow) {
          return fail(400, "invalid_moderation", "阈值必须满足 approveAbove < rejectBelow");
        }
      }
      const before = await loadCoinConfig(db);
      await saveCoinConfigSection(db, section, value, adminActor(ctx));
      await writeAudit(db, {
        actorUserId: ctx.user?.id ?? null,
        action: "coin.config.update",
        entityType: "coin_config",
        entityId: section,
        before: { [section]: (before as unknown as Record<string, unknown>)[section] },
        after: { [section]: value },
      });
      return loadCoinConfig(db);
    });
  }

  // ---- 调账与流水查询 --------------------------------------------------
  if (request.method === "GET" && path === "/api/admin/coins/account") {
    return respond(async () => {
      const resolved = await resolveParticipantHashForAdmin(db, Object.fromEntries(url.searchParams.entries()));
      if (!resolved) return fail(404, "participant_not_found", "未找到该用户的金币账户线索");
      const account = await getCoinAccount(db, resolved.hash);
      return { participantHash: resolved.hash, account };
    });
  }
  if (request.method === "GET" && path === "/api/admin/coins/transactions") {
    return respond(async () => {
      const hash = url.searchParams.get("participantHash") ?? "";
      if (hash.length < 8) return fail(400, "invalid_participant", "participantHash 不合法");
      const rows = await db
        .prepare(
          `SELECT id, amount, balance_after AS balanceAfter, kind, ref_type AS refType, ref_id AS refId,
                  note, created_by AS createdBy, created_at AS createdAt
           FROM coin_transactions WHERE participant_hash = ? ORDER BY id DESC LIMIT 100`,
        )
        .bind(hash)
        .all();
      return { transactions: rows.results ?? [] };
    });
  }
  if (request.method === "POST" && path === "/api/admin/coins/adjust") {
    return respond(async () => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail(400, "invalid_body", "请求体必须是 JSON 对象");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length < 3) return fail(400, "reason_required", "必须填写调账原因（至少 3 字）");
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount === 0) return fail(400, "invalid_amount", "金额必须是整数且不为 0");
      const resolved = await resolveParticipantHashForAdmin(db, body);
      if (!resolved) return fail(404, "participant_not_found", "未找到该用户");

      const account = await getCoinAccount(db, resolved.hash);
      if (amount < 0 && (account?.balance ?? 0) + amount < 0) {
        return fail(409, "would_go_negative", "调账后余额为负，已拒绝");
      }
      const now = new Date().toISOString();
      const idempotencyKey = `admin-adjust:${crypto.randomUUID()}`;
      const statements = describeAdjustStatements(
        {
          participantHash: resolved.hash,
          userId: resolved.userId,
          amount,
          kind: "admin_adjust",
          idempotencyKey,
          refType: "admin_adjust",
          note: reason,
          createdBy: adminActor(ctx),
        },
        now,
      ).map((prepared) => db.prepare(prepared.sql).bind(...prepared.params));
      await db.batch(statements);
      const after = await getCoinAccount(db, resolved.hash);
      await writeAudit(db, {
        actorUserId: ctx.user?.id ?? null,
        action: "coin.adjust",
        entityType: "coin_account",
        entityId: resolved.hash,
        before: { balance: account?.balance ?? 0 },
        after: { balance: after?.balance ?? 0, amount, reason },
      });
      return { ok: true, participantHash: resolved.hash, amount, balance: after?.balance ?? 0 };
    });
  }

  // ---- 投稿审核 --------------------------------------------------------
  if (request.method === "GET" && path === "/api/admin/submissions") {
    return respond(async () => {
      const status = url.searchParams.get("status");
      const where = status ? `WHERE status = ?` : "WHERE status IN ('pending', 'changes_requested')";
      const params = status ? [status] : [];
      const rows = await db
        .prepare(
          `SELECT id, participant_hash AS participantHash, user_id AS userId, type, title, description,
                  content_text AS contentText, media_asset_id AS mediaAssetId,
                  thumb_media_asset_id AS thumbMediaAssetId, media_duration_seconds AS mediaDurationSeconds,
                  survey_id AS surveyId,
                  response_id AS responseId, status, quality_tier AS qualityTier, reward_amount AS rewardAmount,
                  review_note AS reviewNote, created_at AS createdAt
           FROM submissions ${where} ORDER BY id DESC LIMIT 50`,
        )
        .bind(...params)
        .all();
      return { submissions: rows.results ?? [] };
    });
  }

  const reviewMatch = path.match(/^\/api\/admin\/submissions\/(\d+)\/review$/);
  if (request.method === "POST" && reviewMatch) {
    return respond(async () => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail(400, "invalid_body", "请求体必须是 JSON 对象");
      const decision = String(body.decision ?? "");
      if (!["approved", "rejected", "changes_requested"].includes(decision)) {
        return fail(400, "invalid_decision", "决定必须是 approved / rejected / changes_requested");
      }
      const qualityTier = Number(body.qualityTier ?? 2);
      if (![1, 2, 3].includes(qualityTier)) return fail(400, "invalid_tier", "质量档必须是 1..3");
      const before = await getSubmissionById(db, Number(reviewMatch[1]));
      const result = await reviewSubmission(db, Number(reviewMatch[1]), decision as "approved", adminActor(ctx), {
        qualityTier: qualityTier as 1 | 2 | 3,
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      await writeAudit(db, {
        actorUserId: ctx.user?.id ?? null,
        action: "submission.review",
        entityType: "submission",
        ...(reviewMatch[1] !== undefined ? { entityId: reviewMatch[1] } : {}),
        before: { status: before?.status ?? null },
        after: { decision, qualityTier, reward: result.reward },
      });
      return result;
    });
  }

  const poolAddMatch = path.match(/^\/api\/admin\/submissions\/(\d+)\/pool$/);
  if (request.method === "POST" && poolAddMatch) {
    return respond(async () => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const poolId = Number(body?.poolId);
      const rarity = String(body?.rarity ?? "N");
      if (!Number.isInteger(poolId) || poolId <= 0) return fail(400, "invalid_pool", "poolId 不合法");
      if (!["N", "R", "SR", "SSR"].includes(rarity)) return fail(400, "invalid_rarity", "稀有度必须是 N/R/SR/SSR");
      const result = await addSubmissionToPool(db, Number(poolAddMatch[1]), poolId, rarity as "N", {
        ...(typeof body?.weight === "number" ? { weight: body.weight } : {}),
        stock: typeof body?.stock === "number" ? body.stock : null,
      });
      await writeAudit(db, {
        actorUserId: ctx.user?.id ?? null,
        action: "submission.add_to_pool",
        entityType: "submission",
        ...(poolAddMatch[1] !== undefined ? { entityId: poolAddMatch[1] } : {}),
        after: { poolId, rarity, itemId: result.itemId, poolVersion: result.poolVersion },
      });
      return result;
    });
  }

  // ---- 奖池 ------------------------------------------------------------
  if (request.method === "GET" && path === "/api/admin/gacha/pools") {
    return respond(async () => {
      const pools = await db
        .prepare(
          `SELECT id, slug, name, description, cost_single AS costSingle, cost_multi AS costMulti,
                  status, start_at AS startAt, end_at AS endAt, pity_at AS pityAt,
                  default_access AS defaultAccess, version, created_at AS createdAt
           FROM gacha_pools ORDER BY id DESC`,
        )
        .all();
      const withCounts = await Promise.all(
        (pools.results ?? []).map(async (pool: Record<string, unknown>) => {
          const count = await db
            .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(weight), 0) AS w FROM gacha_pool_items WHERE pool_id = ? AND active = 1`)
            .bind(Number(pool.id))
            .first<{ n: number; w: number }>();
          return { ...pool, itemCount: Number(count?.n ?? 0), totalWeight: Number(count?.w ?? 0) };
        }),
      );
      return { pools: withCounts };
    });
  }

  if (request.method === "POST" && path === "/api/admin/gacha/pools") {
    return respond(async () => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const slug = String(body?.slug ?? "").trim();
      const name = String(body?.name ?? "").trim();
      const costSingle = Number(body?.costSingle ?? 0);
      if (!/^[a-z0-9-]{2,64}$/.test(slug)) return fail(400, "invalid_slug", "slug 只允许小写字母、数字和短横线");
      if (!name) return fail(400, "invalid_name", "奖池名称必填");
      if (!Number.isInteger(costSingle) || costSingle <= 0) return fail(400, "invalid_cost", "单抽价格必须是正整数");
      const now = new Date().toISOString();
      const result = await db
        .prepare(
          `INSERT INTO gacha_pools (slug, name, description, cost_single, cost_multi, status,
              start_at, end_at, pity_at, default_access, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, 'permanent', 0, ?, ?)`,
        )
        .bind(
          slug,
          name,
          String(body?.description ?? ""),
          costSingle,
          body?.costMulti == null ? null : Number(body.costMulti),
          typeof body?.startAt === "string" ? body.startAt : null,
          typeof body?.endAt === "string" ? body.endAt : null,
          body?.pityAt == null ? null : Number(body.pityAt),
          now,
          now,
        )
        .run();
      await writeAudit(db, {
        actorUserId: ctx.user?.id ?? null,
        action: "gacha.pool.create",
        entityType: "gacha_pool",
        entityId: String(result.meta.last_row_id),
        after: { slug, name, costSingle },
      });
      return { id: Number(result.meta.last_row_id), slug };
    });
  }

  const poolUpdateMatch = path.match(/^\/api\/admin\/gacha\/pools\/(\d+)$/);
  if (poolUpdateMatch && (request.method === "PUT" || request.method === "PATCH")) {
    return respond(async () => {
      const poolId = Number(poolUpdateMatch[1]);
      const pool = await getPoolById(db, poolId);
      if (!pool) return fail(404, "pool_not_found", "奖池不存在");
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail(400, "invalid_body", "请求体必须是 JSON 对象");
      const now = new Date().toISOString();
      const status = typeof body.status === "string" ? body.status : pool.status;
      if (!["draft", "active", "ended"].includes(status)) return fail(400, "invalid_status", "状态不合法");
      // 状态推进到 active 前必须有版本快照（保证抽取可审计）。
      if (status === "active" && pool.version === 0) {
        return fail(400, "snapshot_required", "上架前需要先生成奖池快照（加入至少一个内容）");
      }
      await db
        .prepare(
          `UPDATE gacha_pools SET status = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(status, now, poolId);
      await writeAudit(db, {
        actorUserId: ctx.user?.id ?? null,
        action: "gacha.pool.update",
        entityType: "gacha_pool",
        entityId: String(poolId),
        before: { status: pool.status },
        after: { status },
      });
      return { ok: true, status };
    });
  }

  const poolItemsMatch = path.match(/^\/api\/admin\/gacha\/pools\/(\d+)$/);
  if (request.method === "GET" && poolItemsMatch) {
    return respond(async () => {
      const poolId = Number(poolItemsMatch[1]);
      const pool = await getPoolById(db, poolId);
      if (!pool) return fail(404, "pool_not_found", "奖池不存在");
      const items = await loadPoolSnapshot(db, pool);
      return { pool, items };
    });
  }

  // ---- 挑战定义 CRUD ---------------------------------------------------
  if (path === "/api/admin/coins/challenges") {
    if (request.method === "GET") {
      return respond(async () => {
        const rows = await db
          .prepare(
            `SELECT id, code, title, description, icon, goal_type AS goalType, goal_target AS goalTarget,
                    reward, period, start_at AS startAt, end_at AS endAt, active, sort
             FROM coin_challenges ORDER BY sort, id`,
          )
          .all();
        return { challenges: rows.results ?? [] };
      });
    }
    if (request.method === "POST") {
      return respond(async () => {
        const body = await readJson(request);
        const parsed = parseChallengePayload(body);
        if ("error" in parsed) return fail(400, "invalid_challenge", parsed.error);
        const now = new Date().toISOString();
        const result = await db
          .prepare(
            `INSERT INTO coin_challenges
               (code, title, description, icon, goal_type, goal_target, reward, period,
                start_at, end_at, active, sort, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            parsed.value.code,
            parsed.value.title,
            parsed.value.description,
            parsed.value.icon,
            parsed.value.goalType,
            parsed.value.goalTarget,
            parsed.value.reward,
            parsed.value.period,
            parsed.value.startAt,
            parsed.value.endAt,
            parsed.value.active,
            parsed.value.sort,
            now,
            now,
          )
          .run();
        await writeAudit(db, {
          actorUserId: ctx.user?.id ?? null,
          action: "coin.challenge.create",
          entityType: "coin_challenge",
          entityId: String(result.meta.last_row_id),
          after: parsed.value,
        });
        return { id: Number(result.meta.last_row_id) };
      });
    }
  }

  const challengeMatch = path.match(/^\/api\/admin\/coins\/challenges\/(\d+)$/);
  if (challengeMatch) {
    const challengeId = Number(challengeMatch[1]);
    if (request.method === "PUT" || request.method === "PATCH") {
      return respond(async () => {
        const before = await db
          .prepare(`SELECT * FROM coin_challenges WHERE id = ?`)
          .bind(challengeId)
          .first<Record<string, unknown>>();
        if (!before) return fail(404, "not_found", "挑战不存在");
        const body = await readJson(request);
        const parsed = parseChallengePayload(body, before);
        if ("error" in parsed) return fail(400, "invalid_challenge", parsed.error);
        await db
          .prepare(
            `UPDATE coin_challenges SET
               code = ?, title = ?, description = ?, icon = ?, goal_type = ?, goal_target = ?,
               reward = ?, period = ?, start_at = ?, end_at = ?, active = ?, sort = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            parsed.value.code,
            parsed.value.title,
            parsed.value.description,
            parsed.value.icon,
            parsed.value.goalType,
            parsed.value.goalTarget,
            parsed.value.reward,
            parsed.value.period,
            parsed.value.startAt,
            parsed.value.endAt,
            parsed.value.active,
            parsed.value.sort,
            new Date().toISOString(),
            challengeId,
          )
          .run();
        await writeAudit(db, {
          actorUserId: ctx.user?.id ?? null,
          action: "coin.challenge.update",
          entityType: "coin_challenge",
          entityId: String(challengeId),
          before,
          after: parsed.value,
        });
        return { ok: true };
      });
    }
    if (request.method === "DELETE") {
      return respond(async () => {
        const before = await db
          .prepare(`SELECT * FROM coin_challenges WHERE id = ?`)
          .bind(challengeId)
          .first<Record<string, unknown>>();
        if (!before) return fail(404, "not_found", "挑战不存在");
        // 软删除（active=0）：已领取记录与审计保留，历史可追溯。
        await db
          .prepare(`UPDATE coin_challenges SET active = 0, updated_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), challengeId)
          .run();
        await writeAudit(db, {
          actorUserId: ctx.user?.id ?? null,
          action: "coin.challenge.disable",
          entityType: "coin_challenge",
          entityId: String(challengeId),
          before,
        });
        return { ok: true };
      });
    }
  }

  return fail(404, "not_found", "接口不存在");
}

const CHALLENGE_GOAL_TYPES = new Set([
  "completed_surveys",
  "checkin_streak",
  "submissions_approved",
  "gacha_pulls",
  "plaza_posts",
]);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return body ?? {};
}

function parseChallengePayload(
  body: Record<string, unknown>,
  before?: Record<string, unknown>,
): { value: {
  code: string; title: string; description: string; icon: string; goalType: string;
  goalTarget: number; reward: number; period: string; startAt: string | null; endAt: string | null;
  active: number; sort: number;
} } | { error: string } {
  const code = String(body.code ?? before?.code ?? "").trim();
  const title = String(body.title ?? before?.title ?? "").trim();
  const goalType = String(body.goalType ?? before?.goal_type ?? "");
  const goalTarget = Number(body.goalTarget ?? before?.goal_target ?? 1);
  const reward = Number(body.reward ?? before?.reward ?? 0);
  const period = String(body.period ?? before?.period ?? "once");
  if (!/^[a-z0-9_-]{2,64}$/.test(code)) return { error: "code 只允许小写字母、数字、下划线与短横线" };
  if (!title) return { error: "标题必填" };
  if (!CHALLENGE_GOAL_TYPES.has(goalType)) {
    return { error: `goalType 必须是 ${[...CHALLENGE_GOAL_TYPES].join(" / ")}` };
  }
  if (!Number.isInteger(goalTarget) || goalTarget < 1) return { error: "目标数必须是正整数" };
  if (!Number.isInteger(reward) || reward <= 0) return { error: "奖励必须是正整数" };
  if (!["once", "daily", "weekly"].includes(period)) return { error: "period 必须是 once / daily / weekly" };
  const startAt = body.startAt === undefined ? (before?.start_at as string | null) ?? null : (body.startAt as string | null);
  const endAt = body.endAt === undefined ? (before?.end_at as string | null) ?? null : (body.endAt as string | null);
  if (startAt && endAt && Date.parse(startAt) > Date.parse(endAt)) return { error: "开始时间不能晚于结束时间" };
  const active = body.active === undefined ? Number(before?.active ?? 1) : body.active === true ? 1 : 0;
  const sort = Number(body.sort ?? before?.sort ?? 0);
  if (!Number.isInteger(sort)) return { error: "排序必须是整数" };
  return {
    value: {
      code,
      title,
      description: String(body.description ?? before?.description ?? ""),
      icon: String(body.icon ?? before?.icon ?? "🎯"),
      goalType,
      goalTarget,
      reward,
      period,
      startAt: startAt ?? null,
      endAt: endAt ?? null,
      active,
      sort,
    },
  };
}
