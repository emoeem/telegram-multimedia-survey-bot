import type { Env } from "../../index";
import { coinDayKey, coinWeekKey, loadCoinConfig } from "./config.service";
import { earnCoins } from "./ledger.service";

/**
 * 挑战中心：进度由服务端按真实业务记录计算（完成问卷数、连续签到、
 * 已通过投稿、抽卡次数），客户端只读不允许上报。领取奖励靠
 * UNIQUE(challenge_id, participant_hash, period_key) + 账本幂等键双保险，
 * 重复领取绝不重复发币。
 */

export type ChallengeGoalType =
  "completed_surveys" | "checkin_streak" | "submissions_approved" | "gacha_pulls" | "plaza_posts";

export interface CoinChallengeRow {
  id: number;
  code: string;
  title: string;
  description: string;
  icon: string;
  goalType: ChallengeGoalType;
  goalTarget: number;
  reward: number;
  period: "once" | "daily" | "weekly";
  startAt: string | null;
  endAt: string | null;
  active: number;
  sort: number;
}

interface RawChallengeRow {
  id: number;
  code: string;
  title: string;
  description: string;
  icon: string;
  goal_type: string;
  goal_target: number;
  reward: number;
  period: string;
  start_at: string | null;
  end_at: string | null;
  active: number;
  sort: number;
}

function rowToChallenge(row: RawChallengeRow): CoinChallengeRow {
  return {
    id: Number(row.id),
    code: row.code,
    title: row.title,
    description: row.description,
    icon: row.icon,
    goalType: row.goal_type as ChallengeGoalType,
    goalTarget: Number(row.goal_target),
    reward: Number(row.reward),
    period: row.period as CoinChallengeRow["period"],
    startAt: row.start_at,
    endAt: row.end_at,
    active: Number(row.active),
    sort: Number(row.sort),
  };
}

function periodKeyOf(challenge: CoinChallengeRow, nowMs: number, timezoneOffsetMinutes: number): string {
  if (challenge.period === "daily") return coinDayKey(nowMs, timezoneOffsetMinutes);
  if (challenge.period === "weekly") return coinWeekKey(nowMs, timezoneOffsetMinutes);
  return "all";
}

async function countQuery(db: D1Database, participantHash: string, goalType: ChallengeGoalType): Promise<number> {
  switch (goalType) {
    case "completed_surveys": {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM survey_responses WHERE participant_hash = ? AND status = 'completed'`)
        .bind(participantHash)
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    }
    case "submissions_approved": {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM submissions
           WHERE participant_hash = ? AND status IN ('approved', 'in_pool')`,
        )
        .bind(participantHash)
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    }
    case "gacha_pulls": {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM gacha_pulls WHERE participant_hash = ?`)
        .bind(participantHash)
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    }
    case "plaza_posts": {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM plaza_posts WHERE participant_hash = ? AND deleted_at IS NULL`)
        .bind(participantHash)
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    }
    case "checkin_streak": {
      // 由 getCheckinStatus 注入（需要日界计算），这里走不到。
      return 0;
    }
    default:
      return 0;
  }
}

async function progressOf(
  db: D1Database,
  challenge: CoinChallengeRow,
  participantHash: string,
  nowMs: number,
  timezoneOffsetMinutes: number,
): Promise<number> {
  if (challenge.goalType === "checkin_streak") {
    const today = coinDayKey(nowMs, timezoneOffsetMinutes);
    const rows = await db
      .prepare(`SELECT day FROM coin_checkins WHERE participant_hash = ? AND day <= ? ORDER BY day DESC LIMIT 60`)
      .bind(participantHash, today)
      .all<{ day: string }>();
    const days = new Set((rows.results ?? []).map((row) => row.day));
    const shift = (day: string, delta: number) =>
      new Date(Date.parse(day + "T00:00:00Z") + delta * 86_400_000).toISOString().slice(0, 10);
    let cursor = days.has(today) ? today : shift(today, -1);
    let streak = 0;
    while (days.has(cursor)) {
      streak += 1;
      cursor = shift(cursor, -1);
    }
    return streak;
  }
  return countQuery(db, participantHash, challenge.goalType);
}

export interface ChallengeView extends CoinChallengeRow {
  periodKey: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  withinWindow: boolean;
}

export async function listChallengesFor(db: D1Database, participantHash: string): Promise<ChallengeView[]> {
  const cfg = await loadCoinConfig(db);
  const nowMs = Date.now();
  const result = await db
    .prepare(
      `SELECT id, code, title, description, icon, goal_type, goal_target, reward, period,
              start_at, end_at, active, sort
       FROM coin_challenges WHERE active = 1 ORDER BY sort, id`,
    )
    .all<RawChallengeRow>();
  const challenges = (result.results ?? []).map(rowToChallenge);
  const views: ChallengeView[] = [];
  for (const challenge of challenges) {
    const periodKey = periodKeyOf(challenge, nowMs, cfg.timezoneOffsetMinutes);
    const withinWindow =
      (challenge.startAt === null || nowMs >= Date.parse(challenge.startAt)) &&
      (challenge.endAt === null || nowMs <= Date.parse(challenge.endAt));
    const [progress, claim] = await Promise.all([
      progressOf(db, challenge, participantHash, nowMs, cfg.timezoneOffsetMinutes),
      db
        .prepare(
          `SELECT id FROM coin_challenge_claims
           WHERE challenge_id = ? AND participant_hash = ? AND period_key = ?`,
        )
        .bind(challenge.id, participantHash, periodKey)
        .first<{ id: number }>(),
    ]);
    views.push({
      ...challenge,
      periodKey,
      progress,
      completed: withinWindow && progress >= challenge.goalTarget,
      claimed: Boolean(claim),
      withinWindow,
    });
  }
  return views;
}

export interface ClaimResult {
  ok: boolean;
  duplicate: boolean;
  reward: number;
  progress: number;
  balance: number;
}

export async function claimChallenge(
  db: D1Database,
  participantHash: string,
  userId: number | null,
  challengeId: number,
): Promise<ClaimResult> {
  const cfg = await loadCoinConfig(db);
  if (!cfg.challenges.enabled) throw new Error("挑战活动未开启");
  const nowMs = Date.now();
  const row = await db
    .prepare(
      `SELECT id, code, title, description, icon, goal_type, goal_target, reward, period,
              start_at, end_at, active, sort
       FROM coin_challenges WHERE id = ? AND active = 1`,
    )
    .bind(challengeId)
    .first<RawChallengeRow>();
  if (!row) throw new ChallengeError("challenge_not_found", "挑战不存在或未开启");
  const challenge = rowToChallenge(row);
  if (
    (challenge.startAt !== null && nowMs < Date.parse(challenge.startAt)) ||
    (challenge.endAt !== null && nowMs > Date.parse(challenge.endAt))
  ) {
    throw new ChallengeError("challenge_closed", "挑战不在有效期内");
  }
  const periodKey = periodKeyOf(challenge, nowMs, cfg.timezoneOffsetMinutes);

  const existing = await db
    .prepare(
      `SELECT reward FROM coin_challenge_claims
       WHERE challenge_id = ? AND participant_hash = ? AND period_key = ?`,
    )
    .bind(challenge.id, participantHash, periodKey)
    .first<{ reward: number }>();
  if (existing) {
    const account = await db
      .prepare(`SELECT balance FROM coin_accounts WHERE participant_hash = ?`)
      .bind(participantHash)
      .first<{ balance: number }>();
    return {
      ok: true,
      duplicate: true,
      reward: Number(existing.reward),
      progress: challenge.goalTarget,
      balance: Number(account?.balance ?? 0),
    };
  }

  // 服务端重算进度：完成后才能领取；不信任客户端上报。
  const progress = await progressOf(db, challenge, participantHash, nowMs, cfg.timezoneOffsetMinutes);
  if (progress < challenge.goalTarget) {
    throw new ChallengeError("challenge_incomplete", `进度未达标（${progress}/${challenge.goalTarget}）`);
  }

  const idempotencyKey = `challenge:${challenge.id}:${participantHash}:${periodKey}`;
  const reward = await earnCoins(db, {
    participantHash,
    userId,
    amount: challenge.reward,
    kind: "challenge",
    idempotencyKey,
    refType: "challenge",
    refId: String(challenge.id),
    note: challenge.title,
  });

  // 领取行单独补插（earnCoins 的 batch 已含账本行；领取行有自己的
  // UNIQUE 约束，撞键即重复领取——账本幂等已保证不重复发币）。
  try {
    await db
      .prepare(
        `INSERT INTO coin_challenge_claims
           (challenge_id, participant_hash, period_key, progress, reward, transaction_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        challenge.id,
        participantHash,
        periodKey,
        progress,
        challenge.reward,
        reward.transactionId,
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message ?? ""))) {
      const account = await db
        .prepare(`SELECT balance FROM coin_accounts WHERE participant_hash = ?`)
        .bind(participantHash)
        .first<{ balance: number }>();
      return { ok: true, duplicate: true, reward: challenge.reward, progress, balance: Number(account?.balance ?? 0) };
    }
    throw error;
  }
  return { ok: true, duplicate: reward.duplicate, reward: challenge.reward, progress, balance: reward.balance };
}

export class ChallengeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChallengeError";
    this.code = code;
  }
}
