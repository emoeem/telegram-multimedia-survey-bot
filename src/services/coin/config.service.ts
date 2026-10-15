import type { Env } from "../../index";

/**
 * 金币经济运营配置。
 *
 * 所有数值都存 coin_config 表（key → JSON），管理端可改；这里只负责
 * 默认值兜底、深合并与类型。任务要求的"系数、区间、上限不得写死在业务
 * 代码里"由这张表保证——业务代码只读本模块。
 *
 * 时区：签到日界用固定 UTC 偏移（默认 +8，即平台统一时区），不信任客户端
 * 时间；换算 dayKey = (now + offset) 的 UTC 日期。
 */

export interface CheckinLadderStep {
  minStreak: number;
  amount: number;
}

export interface CoinEconomyConfig {
  /** 签到/周期的日界时区偏移（分钟），默认 +480（UTC+8）。 */
  timezoneOffsetMinutes: number;
  checkin: {
    enabled: boolean;
    /** 连续签到阶梯：取满足的最后一个 minStreak 档。 */
    ladder: CheckinLadderStep[];
    /**
     * 补签（默认关闭）。开启后用户可花费金币补齐最近 maxBackfillDays 天内的
     * 漏签：补签会写入真实签到行并消耗金币，两条记录都在同一事务里。
     */
    backfill: { enabled: boolean; cost: number; maxBackfillDays: number };
  };
  challenges: { enabled: boolean };
  pricing: {
    /** 问卷解锁定价：price = clamp(round(base * (1 + hotWeight*ln1p(recent30d)) * qualityFactor)) */
    minPrice: number;
    maxPrice: number;
    hotWeight: number;
    qualityFactor: number;
    /** 价格缓存刷新间隔（秒）。 */
    refreshSeconds: number;
  };
  submissions: {
    enabled: boolean;
    /** 低风险文本投稿是否免人工直接通过（默认关闭：宁可慢一点）。 */
    autoApproveText: boolean;
    /** 各类型基础奖励；审核通过时按质量档 1..3 乘 tierMultiplier 发放。 */
    baseRewards: Record<string, number>;
    tierMultipliers: [number, number, number];
    /** 每人每自然日（平台时区）投稿奖励上限。 */
    dailyRewardCap: number;
    /** 每人每自然日投稿次数上限。 */
    maxPerDay: number;
    maxTitleLength: number;
    maxTextLength: number;
    maxImageBytes: number;
    maxAudioBytes: number;
  };
  gacha: { enabled: boolean; maxMulti: number };
  /**
   * 外部内容安全审核（需求 7.3 第三层）。默认关闭：关闭/未配置密钥时
   * 投稿一律人工审核。详见 moderation.service.ts（含降级策略）。
   */
  moderation: {
    enabled: boolean;
    endpoint: string;
    /** score ≥ rejectBelow 判拒绝；≤ approveAbove 判通过；其余人工。 */
    rejectBelow: number;
    approveAbove: number;
    timeoutMs: number;
  };
}

export const COIN_CONFIG_DEFAULTS: CoinEconomyConfig = {
  timezoneOffsetMinutes: 480,
  checkin: {
    enabled: true,
    ladder: [
      { minStreak: 1, amount: 5 },
      { minStreak: 3, amount: 8 },
      { minStreak: 7, amount: 15 },
    ],
    backfill: { enabled: false, cost: 10, maxBackfillDays: 7 },
  },
  challenges: { enabled: true },
  pricing: {
    minPrice: 10,
    maxPrice: 500,
    hotWeight: 0.5,
    qualityFactor: 1,
    refreshSeconds: 3600,
  },
  submissions: {
    enabled: true,
    autoApproveText: false,
    baseRewards: {
      text: 20,
      image: 30,
      audio: 40,
      survey_report: 50,
      profile_card: 30,
    },
    tierMultipliers: [1, 1.5, 2],
    dailyRewardCap: 200,
    maxPerDay: 3,
    maxTitleLength: 80,
    maxTextLength: 5000,
    maxImageBytes: 5 * 1024 * 1024,
    maxAudioBytes: 8 * 1024 * 1024,
  },
  gacha: { enabled: true, maxMulti: 10 },
  moderation: { enabled: false, endpoint: "", rejectBelow: 0.85, approveAbove: 0.2, timeoutMs: 4000 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 深合并覆盖项到默认值（只合并普通对象，数组整体替换）。 */
function mergeOver<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? mergeOver(base[key], value) : value;
  }
  return result as T;
}

export async function loadCoinConfig(db: D1Database): Promise<CoinEconomyConfig> {
  let rows: Array<{ key: string; value: string }> = [];
  try {
    const result = await db.prepare("SELECT key, value FROM coin_config").all<{ key: string; value: string }>();
    rows = result.results ?? [];
  } catch (error) {
    // 表还不存在（迁移未跑）时按默认值工作，避免整个经济面 500。
    console.warn("coin_config unavailable; using defaults", { error });
    return COIN_CONFIG_DEFAULTS;
  }
  let merged = COIN_CONFIG_DEFAULTS;
  for (const row of rows) {
    try {
      // 每行的 value 是「该分区的配置对象」——必须包一层分区键再合并，
      // 否则分区内容会直接盖到顶层（例如 checkin.ladder 变成顶层字段），
      // 分区的其余默认值也就跟着丢失。
      merged = mergeOver(merged, { [row.key]: JSON.parse(row.value) });
    } catch {
      console.warn("coin_config row is not valid JSON; skipped", { key: row.key });
    }
  }
  return merged;
}

/** 管理端保存：按顶层键整体覆盖（值需先通过各管理端点的校验）。 */
export async function saveCoinConfigSection(
  db: D1Database,
  section: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO coin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(section, JSON.stringify(value), updatedBy, now)
    .run();
}

/** 平台日界：返回 (now + offset) 的 UTC 日期字符串 YYYY-MM-DD。 */
export function coinDayKey(nowMs: number, timezoneOffsetMinutes: number): string {
  return new Date(nowMs + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** 平台周键：以日界日期所在的 ISO 周（周一起始）表示。 */
export function coinWeekKey(nowMs: number, timezoneOffsetMinutes: number): string {
  const date = new Date(coinDayKey(nowMs, timezoneOffsetMinutes) + "T00:00:00Z");
  // ISO-8601 周号：周四所在的周决定归属。
  const dayNumber = (date.getUTCDay() + 6) % 7; // 周一=0
  const thursday = new Date(date.getTime() + (3 - dayNumber) * 86_400_000);
  const firstThursdayOfYear = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursdayOfYear.getUTCDay() + 6) % 7;
  const firstWeekMonday = new Date(firstThursdayOfYear.getTime() - firstDayNumber * 86_400_000);
  const week = Math.floor((thursday.getTime() - firstWeekMonday.getTime()) / (7 * 86_400_000)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
