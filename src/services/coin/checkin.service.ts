import type { Env } from "../../index";
import {
  coinDayKey,
  loadCoinConfig,
  type CoinEconomyConfig,
} from "./config.service";
import {
  CoinLedgerError,
  describeEarnStatements,
  earnCoins,
  findTransactionByIdempotencyKey,
  isDuplicateTransactionError,
  getCoinAccount,
  runSpendBatch,
  type LedgerEntryInput,
} from "./ledger.service";
import { HASH_SET_SQL } from "../identity-link.service";

/**
 * 每日签到：阶梯奖励 + 连续签到。
 *
 * 防刷设计（需求 4.1 / 4.3）：
 * - day 由服务端时区偏移计算，绝不信任客户端日期；
 * - UNIQUE(participant_hash, day) 直接挡同日重复签到；
 * - 账本幂等键 `checkin:{hash}:{day}` 再挡一层（迁移/重放等极端情况）；
 * - streak 以"昨天是否有签到"递推，断签自动归 1。
 */

export interface CheckinStatus {
  checkedInToday: boolean;
  streak: number;
  todayAmount: number | null;
  nextAmount: number;
  today: string;
  ladder: Array<{ minStreak: number; amount: number }>;
}

function ladderAmount(ladder: Array<{ minStreak: number; amount: number }>, streak: number): number {
  let amount = ladder[0]?.amount ?? 5;
  for (const step of ladder) {
    if (streak >= step.minStreak) amount = step.amount;
  }
  return amount;
}

function shiftDay(day: string, deltaDays: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

async function currentStreak(db: D1Database, participantHash: string, today: string): Promise<number> {
  // 0082：并集读取——身份合并前的签到历史（source hash）继续计入连续天数。
  const rows = await db
    .prepare(
      `SELECT day FROM coin_checkins
       WHERE participant_hash ${HASH_SET_SQL} AND day <= ? ORDER BY day DESC LIMIT 60`,
    )
    .bind(participantHash, participantHash, today)
    .all<{ day: string }>();
  const days = new Set((rows.results ?? []).map((row) => row.day));
  // 从今天（或昨天，若今天未签）往前数连续签到天数。
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

export async function getCheckinStatus(
  db: D1Database,
  participantHash: string,
  config?: CoinEconomyConfig,
): Promise<CheckinStatus> {
  const cfg = config ?? (await loadCoinConfig(db));
  const today = coinDayKey(Date.now(), cfg.timezoneOffsetMinutes);
  const checkedToday = await db
    .prepare(`SELECT streak, amount FROM coin_checkins WHERE participant_hash ${HASH_SET_SQL} AND day = ?`)
    .bind(participantHash, participantHash, today)
    .first<{ streak: number; amount: number }>();
  const streak = checkedToday
    ? Number(checkedToday.streak)
    : await currentStreak(db, participantHash, today);
  const nextStreak = checkedToday ? Number(checkedToday.streak) + 1 : streak + 1;
  return {
    checkedInToday: Boolean(checkedToday),
    streak,
    todayAmount: checkedToday ? Number(checkedToday.amount) : null,
    nextAmount: ladderAmount(cfg.checkin.ladder, nextStreak),
    today,
    ladder: cfg.checkin.ladder,
  };
}

export interface CheckinResult {
  ok: boolean;
  duplicate: boolean;
  amount: number;
  streak: number;
  balance: number;
  day: string;
}

export async function performCheckin(
  db: D1Database,
  participantHash: string,
  userId: number | null,
): Promise<CheckinResult> {
  const cfg = await loadCoinConfig(db);
  if (!cfg.checkin.enabled) {
    throw new CoinLedgerError("invalid_amount", "签到活动未开启");
  }
  const now = Date.now();
  const day = coinDayKey(now, cfg.timezoneOffsetMinutes);
  const status = await getCheckinStatus(db, participantHash, cfg);
  if (status.checkedInToday) {
    const account = await getCoinAccount(db, participantHash);
    return {
      ok: true,
      duplicate: true,
      amount: status.todayAmount ?? 0,
      streak: status.streak,
      balance: account?.balance ?? 0,
      day,
    };
  }

  const streak = status.streak + 1;
  const amount = ladderAmount(cfg.checkin.ladder, streak);
  const idempotencyKey = `checkin:${participantHash}:${day}`;
  const entry: LedgerEntryInput = {
    participantHash,
    userId,
    amount,
    kind: "checkin",
    idempotencyKey,
    refType: "checkin",
    refId: day,
    note: `连续签到 ${streak} 天`,
  };

  // 业务行（签到日历）与账本同一 batch：并发重复请求要么撞 UNIQUE(day)
  // 要么撞幂等键，都只会成功一次。
  const nowIso = new Date(now).toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO coin_checkins (participant_hash, day, streak, amount, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(participantHash, day, streak, amount, nowIso),
    ...describeEarnStatements(entry, nowIso).map((prepared) =>
      db.prepare(prepared.sql).bind(...prepared.params),
    ),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (
      isDuplicateTransactionError(error) ||
      /UNIQUE constraint failed.*coin_checkins/i.test(String((error as Error)?.message ?? ""))
    ) {
      const existingTxn = await findTransactionByIdempotencyKey(db, idempotencyKey);
      const checkinRow = await db
        .prepare(`SELECT streak, amount FROM coin_checkins WHERE participant_hash ${HASH_SET_SQL} AND day = ?`)
        .bind(participantHash, participantHash, day)
        .first<{ streak: number; amount: number }>();
      const account = await getCoinAccount(db, participantHash);
      return {
        ok: true,
        duplicate: true,
        amount: Number(checkinRow?.amount ?? existingTxn?.amount ?? 0),
        streak: Number(checkinRow?.streak ?? 0),
        balance: account?.balance ?? 0,
        day,
      };
    }
    throw error;
  }
  const account = await getCoinAccount(db, participantHash);
  return { ok: true, duplicate: false, amount, streak, balance: account?.balance ?? 0, day };
}

/** 签到日历（近 30 天已签日期）。 */
export async function listCheckinDays(
  db: D1Database,
  participantHash: string,
  timezoneOffsetMinutes: number,
  days = 30,
): Promise<string[]> {
  const today = coinDayKey(Date.now(), timezoneOffsetMinutes);
  const since = new Date(Date.parse(today + "T00:00:00Z") - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const result = await db
    .prepare(`SELECT day FROM coin_checkins WHERE participant_hash ${HASH_SET_SQL} AND day >= ? ORDER BY day`)
    .bind(participantHash, participantHash, since)
    .all<{ day: string }>();
  return (result.results ?? []).map((row) => row.day);
}


/**
 * 补签（可选项，默认关闭，由 coin_config.checkin.backfill 控制）。
 *
 * 规则：
 * - 只能补「过去 maxBackfillDays 天内、且确实没签」的日期，不能补未来；
 * - 花 `cost` 金币，扣款与签到行在同一事务（守卫失败即不扣款）；
 * - 补齐的签到按奖励 0 记录（奖励已错过，补签买的是连续天数）；
 * - 幂等键 `backfill:{hash}:{day}`，重复请求不重复扣款。
 */
export async function backfillCheckin(
  db: D1Database,
  participantHash: string,
  userId: number | null,
  day: string,
): Promise<{ ok: boolean; duplicate: boolean; day: string; cost: number; balance: number; streak: number }> {
  const cfg = await loadCoinConfig(db);
  if (!cfg.checkin.enabled) throw new CoinLedgerError("invalid_amount", "签到活动未开启");
  const backfill = cfg.checkin.backfill;
  if (!backfill.enabled) throw new CoinLedgerError("invalid_amount", "补签未开放");

  const today = coinDayKey(Date.now(), cfg.timezoneOffsetMinutes);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new CoinLedgerError("invalid_amount", "日期格式不正确");
  if (day >= today) throw new CoinLedgerError("invalid_amount", "只能补签过去的日期");
  const earliest = new Date(Date.parse(today + "T00:00:00Z") - backfill.maxBackfillDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (day < earliest) {
    throw new CoinLedgerError("invalid_amount", `只能补签最近 ${backfill.maxBackfillDays} 天内的漏签`);
  }
  const existing = await db
    .prepare(`SELECT 1 FROM coin_checkins WHERE participant_hash ${HASH_SET_SQL} AND day = ?`)
    .bind(participantHash, participantHash, day)
    .first();
  if (existing) {
    const account = await getCoinAccount(db, participantHash);
    return { ok: true, duplicate: true, day, cost: 0, balance: account?.balance ?? 0, streak: 0 };
  }

  if (backfill.cost > 0) {
    const idempotencyKey = `backfill:${participantHash}:${day}`;
    const outcome = await runSpendBatch(
      db,
      {
        participantHash,
        userId,
        amount: backfill.cost,
        kind: "checkin",
        idempotencyKey,
        refType: "checkin_backfill",
        refId: day,
        note: `补签 ${day}`,
      },
      (charged) => [
        {
          sql: `INSERT INTO coin_checkins (participant_hash, day, streak, amount, created_at)
                SELECT ?, ?, 0, 0, ? WHERE ${charged.sql}`,
          params: [participantHash, day, new Date().toISOString(), ...charged.params],
        },
      ],
    );
    if (outcome.duplicate) {
      const account = await getCoinAccount(db, participantHash);
      return { ok: true, duplicate: true, day, cost: 0, balance: account?.balance ?? 0, streak: 0 };
    }
    if (!outcome.applied) throw new CoinLedgerError("insufficient_funds", `补签需要 ${backfill.cost} 金币`);
  } else {
    await db
      .prepare(
        `INSERT INTO coin_checkins (participant_hash, day, streak, amount, created_at)
         VALUES (?, ?, 0, 0, ?) ON CONFLICT(participant_hash, day) DO NOTHING`,
      )
      .bind(participantHash, day, new Date().toISOString())
      .run();
  }

  const status = await getCheckinStatus(db, participantHash, cfg);
  const account = await getCoinAccount(db, participantHash);
  return { ok: true, duplicate: false, day, cost: backfill.cost, balance: account?.balance ?? 0, streak: status.streak };
}

export { earnCoins };
