import type { Env } from "../../index";
import { loadCoinConfig, type CoinEconomyConfig } from "./config.service";
import { CoinLedgerError, getCoinAccount, runSpendBatch } from "./ledger.service";

/**
 * 问卷金币解锁（需求 5.x）。
 *
 * - 默认免费：survey_coin_access 缺行/未启用 = 免费，行为与现状完全一致。
 * - 金币解锁与密码访问互不替代：密码流程照旧独立生效；作者启用金币解锁后
 *   内容还需解锁记录（见 survey/handler.ts 的集成点）。拥有密码 ≠ 解锁金币。
 * - 定价：price = clamp(round(base * (1 + hotWeight*ln1p(recent30d)) * quality))，
 *   参数全部来自 coin_config；带缓存刷新间隔，短时刷量被 ln1p 平滑。
 * - 购买原子性：扣款 + 解锁行同一 D1 batch；幂等键挡重复扣款；既有解锁行
 *   直接返回已解锁（涨价不影响已解锁者）。失败不扣款。
 */


/**
 * 列表页批量定价：一次查访问配置、一次分组统计近 30 天完成量，之后纯计算。
 * 不写库（列表是高频只读路径；价格缓存由详情页的 computePrice 负责），
 * 但公式与 computePrice 完全一致，因此列表价与解锁实收价不会打架。
 * 无任何问卷启用金币解锁时零查询返回。
 */
export async function resolveListCoinPrices(
  db: D1Database,
  surveyIds: number[],
): Promise<Map<number, number>> {
  const prices = new Map<number, number>();
  if (surveyIds.length === 0) return prices;
  const placeholders = surveyIds.map(() => "?").join(",");
  const accessRows = await db
    .prepare(
      `SELECT survey_id, enabled, base_price, auto_price, fixed_price
       FROM survey_coin_access WHERE enabled = 1 AND survey_id IN (${placeholders})`,
    )
    .bind(...surveyIds)
    .all<{
      survey_id: number;
      enabled: number;
      base_price: number;
      auto_price: number;
      fixed_price: number | null;
    }>();
  const enabled = accessRows.results ?? [];
  if (enabled.length === 0) return prices;

  const config = await loadCoinConfig(db);
  // 只有需要自动定价的问卷才值得再查一次热度。
  const autoPricedIds = enabled
    .filter((row) => Number(row.auto_price) === 1 && row.fixed_price == null)
    .map((row) => Number(row.survey_id));
  const completions = new Map<number, number>();
  if (autoPricedIds.length > 0) {
    const autoPlaceholders = autoPricedIds.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT survey_id, COUNT(*) AS n FROM survey_responses
         WHERE status = 'completed' AND created_at >= datetime('now', '-30 days')
           AND survey_id IN (${autoPlaceholders})
         GROUP BY survey_id`,
      )
      .bind(...autoPricedIds)
      .all<{ survey_id: number; n: number }>();
    for (const row of rows.results ?? []) completions.set(Number(row.survey_id), Number(row.n));
  }

  for (const row of enabled) {
    const surveyId = Number(row.survey_id);
    const price = priceForAccess(
      {
        survey_id: surveyId,
        enabled: Number(row.enabled),
        base_price: Number(row.base_price),
        auto_price: Number(row.auto_price),
        fixed_price: row.fixed_price == null ? null : Number(row.fixed_price),
        price_cached: null,
        price_computed_at: null,
      },
      completions.get(surveyId) ?? 0,
      config,
    );
    prices.set(surveyId, price);
  }
  return prices;
}

/** 定价公式（纯函数）：与 computePrice 共用，保证列表价 = 实收价。 */
export function priceForAccess(
  access: SurveyCoinAccessRow,
  recentCompletions: number,
  config: CoinEconomyConfig,
): number {
  if (access.auto_price && access.fixed_price == null) {
    const raw =
      Number(access.base_price) *
      (1 + config.pricing.hotWeight * Math.log1p(Math.max(0, recentCompletions))) *
      config.pricing.qualityFactor;
    return Math.min(config.pricing.maxPrice, Math.max(config.pricing.minPrice, Math.round(raw)));
  }
  return Math.max(0, Number(access.fixed_price ?? access.base_price ?? 0));
}

export interface SurveyCoinAccessRow {
  survey_id: number;
  enabled: number;
  base_price: number;
  auto_price: number;
  fixed_price: number | null;
  price_cached: number | null;
  price_computed_at: string | null;
}

export interface CoinGate {
  enabled: boolean;
  unlocked: boolean;
  price: number;
}

/** 轻量探测：问卷是否启用了金币解锁（免费问卷热路径零额外查询的开关）。 */
export async function isCoinAccessEnabled(db: D1Database, surveyId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT enabled FROM survey_coin_access WHERE survey_id = ?`)
    .bind(surveyId)
    .first<{ enabled: number }>();
  return Boolean(row && Number(row.enabled));
}

export async function getSurveyCoinAccess(db: D1Database, surveyId: number): Promise<SurveyCoinAccessRow | null> {
  return db
    .prepare(`SELECT survey_id, enabled, base_price, auto_price, fixed_price, price_cached, price_computed_at
              FROM survey_coin_access WHERE survey_id = ?`)
    .bind(surveyId)
    .first<SurveyCoinAccessRow>();
}

/** 近 30 天完成答卷数（热度信号，去重靠响应行本身）。 */
async function recentCompletions(db: D1Database, surveyId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM survey_responses
       WHERE survey_id = ? AND status = 'completed' AND created_at >= datetime('now', '-30 days')`,
    )
    .bind(surveyId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function computePrice(
  db: D1Database,
  access: SurveyCoinAccessRow,
): Promise<number> {
  const cfg = await loadCoinConfig(db);
  if (access.auto_price && access.fixed_price == null) {
    const now = Date.now();
    const computedAt = access.price_computed_at ? Date.parse(access.price_computed_at) : 0;
    if (access.price_cached != null && now - computedAt < cfg.pricing.refreshSeconds * 1000) {
      return Number(access.price_cached);
    }
    const recent = await recentCompletions(db, access.survey_id);
    const price = priceForAccess(access, recent, cfg);
    await db
      .prepare(`UPDATE survey_coin_access SET price_cached = ?, price_computed_at = ? WHERE survey_id = ?`)
      .bind(price, new Date(now).toISOString(), access.survey_id)
      .run();
    return price;
  }
  return Math.max(0, Number(access.fixed_price ?? access.base_price ?? 0));
}

export async function hasUnlock(db: D1Database, surveyId: number, participantHash: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM survey_unlocks WHERE survey_id = ? AND participant_hash = ?`)
    .bind(surveyId, participantHash)
    .first();
  return Boolean(row);
}

/**
 * 访问判定：enabled 且（未解锁）时上锁。ownerUserId / adminIds 传 null 表示
 * 不做豁免（匿名调用方）。
 */
export async function resolveCoinGate(
  db: D1Database,
  survey: { id: number; ownerId: number },
  participant: { participantHash: string; dbUserId: number | null } | null,
  adminIds: number[],
): Promise<CoinGate> {
  const access = await getSurveyCoinAccess(db, survey.id);
  if (!access || !Number(access.enabled)) {
    return { enabled: false, unlocked: true, price: 0 };
  }
  const price = await computePrice(db, access);
  if (participant) {
    if (participant.dbUserId != null && participant.dbUserId === survey.ownerId) {
      return { enabled: true, unlocked: true, price };
    }
    if (participant.dbUserId != null && adminIds.includes(participant.dbUserId)) {
      return { enabled: true, unlocked: true, price };
    }
    if (await hasUnlock(db, survey.id, participant.participantHash)) {
      return { enabled: true, unlocked: true, price };
    }
    return { enabled: true, unlocked: false, price };
  }
  return { enabled: true, unlocked: false, price };
}

export interface UnlockResult {
  ok: boolean;
  duplicate: boolean;
  pricePaid: number;
  balance: number;
}

export async function unlockSurvey(
  db: D1Database,
  survey: { id: number; ownerId: number },
  participant: { participantHash: string; dbUserId: number | null },
  idempotencyKey: string,
): Promise<UnlockResult> {
  // 幂等键格式校验：客户端提供的键只用于"重试同一请求"，不允许伪造他人键。
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
    throw new CoinLedgerError("invalid_amount", "幂等键格式不合法");
  }

  const access = await getSurveyCoinAccess(db, survey.id);
  if (!access || !Number(access.enabled)) {
    // 未启用金币解锁 = 免费问卷：无需购买即视为已解锁。
    return { ok: true, duplicate: false, pricePaid: 0, balance: 0 };
  }

  const existing = await db
    .prepare(`SELECT price_paid FROM survey_unlocks WHERE survey_id = ? AND participant_hash = ?`)
    .bind(survey.id, participant.participantHash)
    .first<{ price_paid: number }>();
  const account0 = await getCoinAccount(db, participant.participantHash);
  if (existing) {
    return { ok: true, duplicate: true, pricePaid: Number(existing.price_paid), balance: account0?.balance ?? 0 };
  }

  const price = await computePrice(db, access);
  if (price <= 0) {
    // 免费开放的"活动访问"：直接落一条 0 元解锁记录（幂等）。
    const nowIso = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          `INSERT INTO survey_unlocks (survey_id, participant_hash, price_paid, created_at)
           VALUES (?, ?, 0, ?) ON CONFLICT(survey_id, participant_hash) DO NOTHING`,
        )
        .bind(survey.id, participant.participantHash, nowIso),
    ]);
    return { ok: true, duplicate: false, pricePaid: 0, balance: account0?.balance ?? 0 };
  }

  const entry = {
    participantHash: participant.participantHash,
    userId: participant.dbUserId,
    amount: price,
    kind: "survey_unlock" as const,
    idempotencyKey: `unlock:${idempotencyKey}`,
    refType: "survey",
    refId: String(survey.id),
    note: `解锁问卷 #${survey.id}`,
  };
  const nowIso = new Date().toISOString();
  // 解锁行以扣款流水为守卫：余额不足时两者都不生效，失败不扣款。
  let outcome;
  try {
    outcome = await runSpendBatch(db, entry, (charged) => [
      {
        sql: `INSERT INTO survey_unlocks (survey_id, participant_hash, price_paid, created_at)
              SELECT ?, ?, ?, ? WHERE ${charged.sql}`,
        params: [survey.id, participant.participantHash, price, nowIso, ...charged.params],
      },
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed.*survey_unlocks/i.test(String((error as Error)?.message ?? ""))) {
      // 并发下另一请求（不同幂等键）先解锁成功：本批整体回滚，未扣款。
      const account = await getCoinAccount(db, participant.participantHash);
      return { ok: true, duplicate: true, pricePaid: 0, balance: account?.balance ?? 0 };
    }
    throw error;
  }
  if (outcome.duplicate) {
    const unlock = await db
      .prepare(`SELECT price_paid FROM survey_unlocks WHERE survey_id = ? AND participant_hash = ?`)
      .bind(survey.id, participant.participantHash)
      .first<{ price_paid: number }>();
    const account = await getCoinAccount(db, participant.participantHash);
    return {
      ok: true,
      duplicate: true,
      pricePaid: Number(unlock?.price_paid ?? price),
      balance: account?.balance ?? outcome.balance,
    };
  }
  if (!outcome.applied) {
    const account = await getCoinAccount(db, participant.participantHash);
    throw new CoinLedgerError("insufficient_funds", `金币不足，需要 ${price} 金币`);
  }
  return { ok: true, duplicate: false, pricePaid: price, balance: outcome.balance };
}

export async function listUnlocksFor(db: D1Database, participantHash: string) {
  const result = await db
    .prepare(
      `SELECT u.survey_id AS surveyId, u.price_paid AS pricePaid, u.created_at AS createdAt,
              s.title AS surveyTitle
       FROM survey_unlocks u LEFT JOIN surveys s ON s.id = u.survey_id
       WHERE u.participant_hash = ? ORDER BY u.id DESC LIMIT 100`,
    )
    .bind(participantHash)
    .all();
  return result.results ?? [];
}
