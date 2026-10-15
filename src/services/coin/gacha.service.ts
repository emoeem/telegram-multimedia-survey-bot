import type { Env } from "../../index";
import { loadCoinConfig } from "./config.service";
import {
  CoinLedgerError,
  describeSpendStatements,
  earnCoins,
  getCoinAccount,
  isDuplicateTransactionError,
  type PreparedStatement,
} from "./ledger.service";

/**
 * 报告抽卡（需求 6.x）。
 *
 * 公平性设计：
 * - 奖池每次配置变更生成新版本快照（条目/权重/稀有度/保底），抽取记录所用
 *   版本，事后可审计"当时概率是什么"；概率公示直接读快照，与算法同源。
 * - 结果由服务端 crypto 随机 + 权重抽取，前端不参与。
 * - 库存：扣减语句带 `AND (stock IS NULL OR remaining > 0)` 守卫，并发超发
 *   会被静默挡下（抽取行同样守卫在扣款流水上，全部落空 → 返回重试）。
 * - 保底：统计该参与者在当前保底周期内（自上次 SSR 起）的抽数，达到 pity_at
 *   且未出高稀有 → 强制在 SSR/SR 池里抽。
 * - 幂等：客户端提供 idempotencyKey；账本键 `pull:{key}`（十连 `pull:{key}#n`）
 *   唯一约束挡重复扣款，抽取行以扣款流水为守卫。
 */

export type GachaRarity = "N" | "R" | "SR" | "SSR";

export interface GachaItemSnapshot {
  id: number;
  submissionId: number | null;
  title: string;
  description: string;
  contentType: string;
  rarity: GachaRarity;
  weight: number;
  stock: number | null;
  previewMediaId: number | null;
}

export interface GachaPoolRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  costSingle: number;
  costMulti: number | null;
  status: "draft" | "active" | "ended";
  startAt: string | null;
  endAt: string | null;
  pityAt: number | null;
  defaultAccess: string;
  version: number;
}

interface RawPoolRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  cost_single: number;
  cost_multi: number | null;
  status: string;
  start_at: string | null;
  end_at: string | null;
  pity_at: number | null;
  default_access: string;
  version: number;
}

function rowToPool(row: RawPoolRow): GachaPoolRow {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    costSingle: Number(row.cost_single),
    costMulti: row.cost_multi == null ? null : Number(row.cost_multi),
    status: row.status as GachaPoolRow["status"],
    startAt: row.start_at,
    endAt: row.end_at,
    pityAt: row.pity_at == null ? null : Number(row.pity_at),
    defaultAccess: row.default_access,
    version: Number(row.version),
  };
}

export async function getPoolBySlug(db: D1Database, slug: string): Promise<GachaPoolRow | null> {
  const row = await db
    .prepare(
      `SELECT id, slug, name, description, cost_single, cost_multi, status, start_at, end_at,
              pity_at, default_access, version
       FROM gacha_pools WHERE slug = ?`,
    )
    .bind(slug)
    .first<RawPoolRow>();
  return row ? rowToPool(row) : null;
}

export async function getPoolById(db: D1Database, id: number): Promise<GachaPoolRow | null> {
  const row = await db
    .prepare(
      `SELECT id, slug, name, description, cost_single, cost_multi, status, start_at, end_at,
              pity_at, default_access, version
       FROM gacha_pools WHERE id = ?`,
    )
    .bind(id)
    .first<RawPoolRow>();
  return row ? rowToPool(row) : null;
}

export async function listActivePools(db: D1Database): Promise<GachaPoolRow[]> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `SELECT id, slug, name, description, cost_single, cost_multi, status, start_at, end_at,
              pity_at, default_access, version
       FROM gacha_pools
       WHERE status = 'active'
         AND (start_at IS NULL OR start_at <= ?)
         AND (end_at IS NULL OR end_at >= ?)
       ORDER BY id DESC`,
    )
    .bind(now, now)
    .all<RawPoolRow>();
  return (result.results ?? []).map(rowToPool);
}

/** 当前版本的条目快照（只含启用且有余量的条目参与抽取）。 */
export async function loadPoolSnapshot(db: D1Database, pool: GachaPoolRow): Promise<GachaItemSnapshot[]> {
  const result = await db
    .prepare(
      `SELECT id, submission_id, title, description, content_type, rarity, weight, stock, preview_media_id
       FROM gacha_pool_items WHERE pool_id = ? AND active = 1 ORDER BY id`,
    )
    .bind(pool.id)
    .all<{
      id: number;
      submission_id: number | null;
      title: string;
      description: string;
      content_type: string;
      rarity: string;
      weight: number;
      stock: number | null;
      preview_media_id: number | null;
    }>();
  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    submissionId: row.submission_id == null ? null : Number(row.submission_id),
    title: row.title,
    description: row.description,
    contentType: row.content_type,
    rarity: (row.rarity as GachaRarity) ?? "N",
    weight: Number(row.weight),
    stock: row.stock == null ? null : Number(row.stock),
    previewMediaId: row.preview_media_id == null ? null : Number(row.preview_media_id),
  }));
}

/** 服务端加权抽取：crypto 随机源，不支持外部指定结果。 */
export function drawWeighted(items: GachaItemSnapshot[], random: () => number): GachaItemSnapshot | null {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total <= 0 || items.length === 0) return null;
  let roll = random() * total;
  for (const item of items) {
    roll -= Math.max(0, item.weight);
    if (roll < 0) return item;
  }
  return items[items.length - 1] ?? null;
}

/** 该参与者自上次 SSR 以来的抽数（保底计数）。 */
async function pullsSinceLastHighRarity(
  db: D1Database,
  poolId: number,
  participantHash: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM gacha_pulls
       WHERE pool_id = ? AND participant_hash = ? AND rarity IN ('SR', 'SSR')
         AND id > (SELECT COALESCE(MAX(id), 0) FROM gacha_pulls
                   WHERE pool_id = ? AND participant_hash = ? AND rarity = 'SSR')`,
    )
    .bind(poolId, participantHash, poolId, participantHash)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface PullOutcomeItem {
  itemId: number;
  rarity: GachaRarity;
  title: string;
  contentType: string;
  pity: boolean;
}

export interface PullResult {
  ok: boolean;
  duplicate: boolean;
  insufficient: boolean;
  poolEmpty: boolean;
  results: PullOutcomeItem[];
  balance: number;
}

/**
 * 抽取 count 次（1 或多连）。count>1 时一次扣总价、逐条记录抽取结果，
 * 整批原子：任何一条失败全部回滚，不会出现"扣了钱抽了一半"。
 */
export async function pullGacha(
  env: Env,
  pool: GachaPoolRow,
  participant: { participantHash: string; dbUserId: number | null },
  count: number,
  idempotencyKey: string,
): Promise<PullResult> {
  const db = env.DB;
  const cfg = await loadCoinConfig(db);
  if (!cfg.gacha.enabled) throw new GachaError("gacha_disabled", "抽卡活动未开启");
  if (!Number.isInteger(count) || count < 1 || count > cfg.gacha.maxMulti) {
    throw new GachaError("invalid_count", `抽取次数必须在 1..${cfg.gacha.maxMulti}`);
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
    throw new GachaError("invalid_key", "幂等键格式不合法");
  }
  const nowMs = Date.now();
  if (
    pool.status !== "active" ||
    (pool.startAt !== null && nowMs < Date.parse(pool.startAt)) ||
    (pool.endAt !== null && nowMs > Date.parse(pool.endAt))
  ) {
    throw new GachaError("pool_closed", "奖池不在开放时间");
  }

  const cost = count === 1 ? pool.costSingle : (pool.costMulti ?? pool.costSingle * count);
  const snapshot = await loadPoolSnapshot(db, pool);
  const available = snapshot.filter((item) => item.stock === null || item.stock > 0);
  if (available.length === 0) {
    return { ok: false, duplicate: false, insufficient: false, poolEmpty: true, results: [], balance: 0 };
  }

  // 逐次抽取（服务端随机 + 保底），结果确定后才进入原子写入。
  const pulls: Array<{ item: GachaItemSnapshot; pity: boolean }> = [];
  for (let index = 0; index < count; index += 1) {
    const sinceHighRarity = await pullsSinceLastHighRarity(db, pool.id, participant.participantHash);
    const pityDue = pool.pityAt != null && pool.pityAt > 0 && sinceHighRarity + index + 1 >= pool.pityAt;
    let item: GachaItemSnapshot | null = null;
    if (pityDue) {
      const highPool = available.filter((entry) => entry.rarity === "SR" || entry.rarity === "SSR");
      item = drawWeighted(highPool.length ? highPool : available, cryptoRandom);
    } else {
      item = drawWeighted(available, cryptoRandom);
    }
    if (!item) {
      return { ok: false, duplicate: false, insufficient: false, poolEmpty: true, results: [], balance: 0 };
    }
    pulls.push({ item, pity: pityDue && (item.rarity === "SR" || item.rarity === "SSR") });
  }

  const chargeKey = `pull:${idempotencyKey}`;
  const nowIso = new Date(nowMs).toISOString();
  const spend = describeSpendStatements(
    {
      participantHash: participant.participantHash,
      userId: participant.dbUserId,
      amount: cost,
      kind: "gacha_pull",
      idempotencyKey: chargeKey,
      refType: "gacha_pool",
      refId: String(pool.id),
      note: `${pool.name} × ${count}`,
    },
    nowIso,
  );
  const charged: PreparedStatement = {
    sql: `(SELECT COUNT(*) FROM coin_transactions WHERE idempotency_key = ?) > 0`,
    params: [chargeKey],
  };
  // 每次抽取 = 库存扣减（守卫）+ 抽取记录（守卫扣款流水与库存）。抽取记录
  // 没写进去的情况（库存被并发抢完）由批次后的差额检测 + 补偿退款兜底。
  const pullStatements: PreparedStatement[] = pulls.flatMap((pull, pullIndex) => [
    {
      // INSERT 在前：以"扣减前"的库存做占位守卫；随后第二条再扣减。
      // 同一抽的两条语句在同一事务内顺序执行，第二抽的 INSERT 会看到
      // 第一抽扣减后的库存——剩余 0 即落空，由差额补偿退款兜底。
      sql: `INSERT INTO gacha_pulls
              (pool_id, pool_version, participant_hash, item_id, idempotency_key, batch_id, access_type, rarity, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ${charged.sql}
              AND EXISTS (
                SELECT 1 FROM gacha_pool_items
                WHERE id = ? AND active = 1 AND (stock IS NULL OR remaining > 0)
              )`,
      params: [
        pool.id,
        pool.version,
        participant.participantHash,
        pull.item.id,
        `${chargeKey}#${pullIndex}`,
        chargeKey, // 单抽/多连都记 batch_id，重放查找统一按批次键
        pool.defaultAccess,
        pull.item.rarity,
        nowIso,
        ...charged.params,
        pull.item.id,
      ],
    },
    {
      sql: `UPDATE gacha_pool_items
            SET remaining = CASE WHEN remaining IS NULL THEN NULL ELSE remaining - 1 END
            WHERE id = ? AND active = 1
              AND (stock IS NULL OR remaining > 0)
              AND (SELECT COUNT(*) FROM gacha_pulls WHERE idempotency_key = ?) > 0`,
      params: [pull.item.id, `${chargeKey}#${pullIndex}`],
    },
  ]);

  let batchResults: Array<{ meta?: { changes?: number } }>;
  try {
    batchResults = (await db.batch(
      [...spend, ...pullStatements].map((prepared) => db.prepare(prepared.sql).bind(...prepared.params)),
    )) as Array<{ meta?: { changes?: number } }>;
  } catch (error) {
    if (isDuplicateTransactionError(error)) {
      const rows = await db
        .prepare(
          `SELECT item_id, rarity FROM gacha_pulls
           WHERE idempotency_key = ? OR batch_id = ? ORDER BY id`,
        )
        .bind(chargeKey, chargeKey)
        .all<{ item_id: number; rarity: string }>();
      const byId = new Map(snapshot.map((item) => [item.id, item]));
      return {
        ok: true,
        duplicate: true,
        insufficient: false,
        poolEmpty: false,
        results: (rows.results ?? []).map((row) => {
          const item = byId.get(Number(row.item_id));
          return {
            itemId: Number(row.item_id),
            rarity: (row.rarity as GachaRarity) ?? "N",
            title: item?.title ?? "未知内容",
            contentType: item?.contentType ?? "text",
            pity: false,
          };
        }),
        balance: (await getCoinAccount(db, participant.participantHash))?.balance ?? 0,
      };
    }
    throw error;
  }

  // spend[1] 未生效 = 余额不足（抽取行有扣款守卫，必然也全部落空）。
  const chargeApplied = Number(batchResults[1]?.meta?.changes ?? 0) > 0;
  if (!chargeApplied) {
    return { ok: false, duplicate: false, insufficient: true, poolEmpty: false, results: [], balance: (await getCoinAccount(db, participant.participantHash))?.balance ?? 0 };
  }

  // 库存差额补偿：单元价 ×（应抽次数 - 实际入账次数），带幂等键的可审计
  // 反向流水。单抽恰好抢空的极端情况也走这里（该次金额退回）。
  const appliedPulls = pullStatements
    .map((_, offset) => batchResults[spend.length + offset])
    .filter((_, offset) => offset % 2 === 0)
    .reduce((sum, result) => sum + Number(result?.meta?.changes ?? 0), 0);
  let balance = (await getCoinAccount(db, participant.participantHash))?.balance ?? 0;
  if (appliedPulls < count) {
    const unitCost = count === 1 ? pool.costSingle : Math.floor(cost / count);
    const refund = unitCost * (count - appliedPulls);
    if (refund > 0) {
      await earnCoins(db, {
        participantHash: participant.participantHash,
        userId: participant.dbUserId,
        amount: refund,
        kind: "gacha_pull",
        idempotencyKey: `${chargeKey}:refund`,
        refType: "gacha_pool",
        refId: String(pool.id),
        note: `奖池库存不足，退还 ${count - appliedPulls} 次抽取费用`,
      });
      balance = (await getCoinAccount(db, participant.participantHash))?.balance ?? balance;
    }
  }

  return {
    ok: true,
    duplicate: false,
    insufficient: false,
    poolEmpty: false,
    results: pulls.slice(0, appliedPulls).map((pull) => ({
      itemId: pull.item.id,
      rarity: pull.item.rarity,
      title: pull.item.title,
      contentType: pull.item.contentType,
      pity: pull.pity,
    })),
    balance,
  };
}

function cryptoRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0]! / 4294967296;
}

export class GachaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GachaError";
    this.code = code;
  }
}

export async function listPullsFor(db: D1Database, participantHash: string) {
  const result = await db
    .prepare(
      `SELECT p.id AS pullId, p.pool_id AS poolId, pool.name AS poolName, p.item_id AS itemId,
              p.rarity, p.access_type AS accessType, p.created_at AS createdAt,
              item.title, item.description, item.content_type AS contentType,
              item.preview_media_id AS previewMediaId, item.submission_id AS submissionId,
              item.owner_participant_hash = ? AS isOwn
       FROM gacha_pulls p
       JOIN gacha_pool_items item ON item.id = p.item_id
       JOIN gacha_pools pool ON pool.id = p.pool_id
       WHERE p.participant_hash = ?
       ORDER BY p.id DESC LIMIT 100`,
    )
    .bind(participantHash, participantHash)
    .all();
  return result.results ?? [];
}

/** 抽中内容的查看权限：必须存在抽取记录（access_type 决定时效策略）。 */
export async function canViewItem(db: D1Database, participantHash: string, itemId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM gacha_pulls
       WHERE participant_hash = ? AND item_id = ?
         AND (access_type = 'permanent' OR created_at >= datetime('now', '-30 days'))
       LIMIT 1`,
    )
    .bind(participantHash, itemId)
    .first();
  return Boolean(row);
}

export { CoinLedgerError };
