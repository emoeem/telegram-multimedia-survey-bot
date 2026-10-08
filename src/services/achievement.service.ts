import {
  insertParticipantAchievement,
  insertParticipantAchievements,
  markParticipantAchievementsSeen,
  listParticipantAchievements,
} from "../db/repositories/achievement.repository";

/**
 * 成就 / 徽章系统。
 *
 * 定义（catalog）只存在于代码里，数据库只记录「谁在什么时候解锁了什么」，
 * 因此新增一个徽章不需要迁移，也不会给历史用户补一条假记录。所有统计都按
 * participant_hash 归属，与问卷、挑战、排行榜完全一致。
 */

export type AchievementMetric =
  "surveys" | "profiles" | "trialRuns" | "trialCleared" | "trialBestScore" | "plazaPosts" | "plazaComments";

export interface AchievementMetrics {
  surveys: number;
  profiles: number;
  trialRuns: number;
  trialCleared: number;
  trialBestScore: number;
  plazaPosts: number;
  plazaComments: number;
}

export interface AchievementDefinition {
  code: string;
  title: string;
  description: string;
  /** Emoji shown in the badge wall (the client never hardcodes one). */
  icon: string;
  group: "问卷" | "挑战" | "广场" | "彩蛋";
  metric: AchievementMetric | null;
  target: number;
  /** Hidden until unlocked ("???" placeholder in the wall). */
  secret?: boolean;
  /** Composite / one-off conditions that need no numeric metric. */
  check?: (metrics: AchievementMetrics) => boolean;
}

export const ACHIEVEMENTS: AchievementDefinition[] = [
  {
    code: "first_survey",
    title: "初次相遇",
    description: "完成第一份问卷",
    icon: "🎈",
    group: "问卷",
    metric: "surveys",
    target: 1,
  },
  {
    code: "survey_five",
    title: "问卷爱好者",
    description: "累计完成 5 份问卷",
    icon: "📚",
    group: "问卷",
    metric: "surveys",
    target: 5,
  },
  {
    code: "survey_twenty",
    title: "问卷大师",
    description: "累计完成 20 份问卷",
    icon: "🎓",
    group: "问卷",
    metric: "surveys",
    target: 20,
  },
  {
    code: "profile_published",
    title: "出镜时刻",
    description: "发布第一张个人资料卡",
    icon: "🖼️",
    group: "问卷",
    metric: "profiles",
    target: 1,
  },
  {
    code: "trial_first_clear",
    title: "初次通关",
    description: "通关一次挑战任务",
    icon: "🏁",
    group: "挑战",
    metric: "trialCleared",
    target: 1,
  },
  {
    code: "trial_clear_ten",
    title: "十战十胜",
    description: "累计通关 10 次挑战",
    icon: "🏆",
    group: "挑战",
    metric: "trialCleared",
    target: 10,
  },
  {
    code: "trial_high_score",
    title: "高分玩家",
    description: "单局最高分达到 500",
    icon: "⭐",
    group: "挑战",
    metric: "trialBestScore",
    target: 500,
  },
  {
    code: "trial_veteran",
    title: "挑战常客",
    description: "累计开始 10 局挑战",
    icon: "🎯",
    group: "挑战",
    metric: "trialRuns",
    target: 10,
  },
  {
    code: "plaza_first_post",
    title: "树洞发声",
    description: "在广场发布第一条内容",
    icon: "🌳",
    group: "广场",
    metric: "plazaPosts",
    target: 1,
  },
  {
    code: "plaza_comment",
    title: "温暖回应",
    description: "在广场写下第一条评论",
    icon: "💬",
    group: "广场",
    metric: "plazaComments",
    target: 1,
  },
  {
    code: "all_rounder",
    title: "全能玩家",
    description: "问卷、挑战、广场都留下过记录",
    icon: "🧩",
    group: "彩蛋",
    metric: null,
    target: 0,
    check: (metrics) => metrics.surveys >= 1 && metrics.trialCleared >= 1 && metrics.plazaPosts >= 1,
  },
  {
    code: "night_owl",
    title: "深夜选手",
    description: "在凌晨 0-5 点完成一份答卷",
    icon: "🌙",
    group: "彩蛋",
    metric: null,
    target: 0,
    secret: true,
  },
  {
    code: "early_bird",
    title: "早起鸟",
    description: "在清晨 5-8 点完成一份答卷",
    icon: "🌅",
    group: "彩蛋",
    metric: null,
    target: 0,
    secret: true,
  },
];

const ACHIEVEMENT_BY_CODE = new Map(ACHIEVEMENTS.map((item) => [item.code, item]));

/** Public shape: definitions + this participant's unlock state. */
export interface AchievementStatus {
  code: string;
  title: string;
  description: string;
  icon: string;
  group: AchievementDefinition["group"];
  secret: boolean;
  unlocked: boolean;
  unlockedAt: string | null;
}

export interface AchievementOverview {
  unlocked: number;
  total: number;
  unseen: number;
  items: AchievementStatus[];
}

export interface AchievementContext {
  participantHash: string;
  /** Telegram user id when known; plaza counters are keyed by users.id. */
  userId?: number | null;
  now?: Date;
}

export async function loadAchievementMetrics(db: D1Database, ctx: AchievementContext): Promise<AchievementMetrics> {
  const [responseStats, trialStats] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS surveys,
                COALESCE(SUM(CASE WHEN gallery_published = 1 THEN 1 ELSE 0 END), 0) AS profiles
           FROM survey_responses
          WHERE participant_hash = ? AND status = 'completed'`,
      )
      .bind(ctx.participantHash)
      .first<{ surveys: number; profiles: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS cleared,
                COALESCE(MAX(CASE WHEN status = 'completed' THEN score ELSE 0 END), 0) AS bestScore
           FROM task_runs
          WHERE participant_hash = ?`,
      )
      .bind(ctx.participantHash)
      .first<{ runs: number; cleared: number; bestScore: number }>(),
  ]);

  let plazaPosts = 0;
  let plazaComments = 0;
  if (typeof ctx.userId === "number" && Number.isInteger(ctx.userId) && ctx.userId > 0) {
    const [postStats, commentStats] = await Promise.all([
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM plaza_posts WHERE user_id = ? AND status = 'published' AND deleted_at IS NULL",
        )
        .bind(ctx.userId)
        .first<{ count: number }>(),
      db
        .prepare("SELECT COUNT(*) AS count FROM plaza_post_comments WHERE user_id = ? AND status = 'published'")
        .bind(ctx.userId)
        .first<{ count: number }>(),
    ]);
    plazaPosts = Number(postStats?.count ?? 0);
    plazaComments = Number(commentStats?.count ?? 0);
  }

  return {
    surveys: Number(responseStats?.surveys ?? 0),
    profiles: Number(responseStats?.profiles ?? 0),
    trialRuns: Number(trialStats?.runs ?? 0),
    trialCleared: Number(trialStats?.cleared ?? 0),
    trialBestScore: Number(trialStats?.bestScore ?? 0),
    plazaPosts,
    plazaComments,
  };
}

/**
 * Grants a single badge (idempotent). Returns true only when this call was the
 * one that unlocked it, so callers can decide whether to celebrate.
 */
export async function grantAchievement(
  db: D1Database,
  ctx: AchievementContext,
  code: string,
  meta?: Record<string, unknown> | null,
): Promise<boolean> {
  if (!ACHIEVEMENT_BY_CODE.has(code)) return false;
  return insertParticipantAchievement(db, { participantHash: ctx.participantHash, code, meta: meta ?? null });
}

/**
 * Recomputes every badge for a participant and writes the newly earned ones.
 *
 * Called as a side effect of the actions that can unlock something (submit a
 * survey, finish a challenge, post/comment in the plaza). It never throws:
 * a badge is a decoration, and a broken counter must not fail the action the
 * user actually asked for.
 */
export async function evaluateAchievements(db: D1Database, ctx: AchievementContext): Promise<AchievementDefinition[]> {
  try {
    const metrics = await loadAchievementMetrics(db, ctx);
    // Qualify every badge in memory, read the participant's existing unlocks
    // once, then batch-insert only the missing ones. The previous per-badge
    // INSERT OR IGNORE loop cost 11-13 sequential round trips on every submit
    // even when everything was already unlocked.
    const qualifying = new Map<string, Record<string, unknown> | null>();
    for (const definition of ACHIEVEMENTS) {
      if (definition.metric === null) continue;
      const current = metrics[definition.metric];
      if (current < definition.target) continue;
      if (!qualifying.has(definition.code)) {
        qualifying.set(definition.code, { [definition.metric]: current });
      }
    }
    for (const definition of ACHIEVEMENTS) {
      if (!definition.check || !definition.check(metrics)) continue;
      if (!qualifying.has(definition.code)) {
        qualifying.set(definition.code, null);
      }
    }
    if (qualifying.size === 0) return [];

    const existingCodes = new Set((await listParticipantAchievements(db, ctx.participantHash)).map((row) => row.code));
    const missing = [...qualifying.entries()]
      .filter(([code]) => !existingCodes.has(code))
      .map(([code, meta]) => ({ code, meta }));
    if (missing.length === 0) return [];

    const unlockedCodes = new Set(
      await insertParticipantAchievements(db, { participantHash: ctx.participantHash, unlocks: missing }),
    );
    return ACHIEVEMENTS.filter((definition) => unlockedCodes.has(definition.code));
  } catch (error) {
    console.error("Achievement evaluation failed", { participantHash: ctx.participantHash, error });
    return [];
  }
}

/**
 * 彩蛋看的是「用户当地几点」，不是 Worker 的时钟（Workers 运行时是 UTC）。
 * 平台面向 UTC+8 的社区（报告/周报也用 Asia/Shanghai），所以这里显式换算，
 * 否则「深夜选手」会在北京时间早上八点解锁。
 */
export const ACHIEVEMENT_TIME_ZONE = "Asia/Shanghai";

export function participantHour(now: Date): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: ACHIEVEMENT_TIME_ZONE,
      hour: "numeric",
      hour12: false,
    }).format(now);
    const hour = Number(formatted);
    if (Number.isInteger(hour)) return hour % 24;
  } catch {
    // 环境不支持该时区时退回 UTC，彩蛋宁可偏一小时也不能抛错。
  }
  return now.getUTCHours();
}

/**
 * Time-of-day easter eggs, decided by the action itself rather than a counter:
 * "完成答卷的那一刻是几点" cannot be reconstructed later.
 */
export function timeOfDayAchievementCodes(now: Date): string[] {
  const hour = participantHour(now);
  const codes: string[] = [];
  if (hour >= 0 && hour < 5) codes.push("night_owl");
  if (hour >= 5 && hour < 8) codes.push("early_bird");
  return codes;
}

/** Grants the time-of-day badges for a completion that just happened. */
export async function evaluateTimeOfDayAchievements(
  db: D1Database,
  ctx: AchievementContext,
): Promise<AchievementDefinition[]> {
  const now = ctx.now ?? new Date();
  const unlocked: AchievementDefinition[] = [];
  try {
    for (const code of timeOfDayAchievementCodes(now)) {
      if (await grantAchievement(db, { ...ctx, now }, code, { hour: participantHour(now) })) {
        const definition = ACHIEVEMENT_BY_CODE.get(code);
        if (definition) unlocked.push(definition);
      }
    }
  } catch (error) {
    console.error("Achievement time-of-day grant failed", { participantHash: ctx.participantHash, error });
  }
  return unlocked;
}

export async function loadAchievementOverview(db: D1Database, participantHash: string): Promise<AchievementOverview> {
  const rows = await listParticipantAchievements(db, participantHash);
  const unlockedByCode = new Map(rows.map((row) => [row.code, row]));
  const items: AchievementStatus[] = ACHIEVEMENTS.map((definition) => {
    const record = unlockedByCode.get(definition.code);
    return {
      code: definition.code,
      title: definition.title,
      description: definition.description,
      icon: definition.icon,
      group: definition.group,
      secret: definition.secret === true,
      unlocked: Boolean(record),
      unlockedAt: record?.unlockedAt ?? null,
    };
  });
  return {
    unlocked: items.filter((item) => item.unlocked).length,
    total: items.length,
    unseen: rows.filter((row) => !row.seen).length,
    items,
  };
}

/** Serializes the freshly unlocked badges for an action response. */
export function serializeUnlockedAchievements(definitions: AchievementDefinition[]) {
  return definitions.map((definition) => ({
    code: definition.code,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
  }));
}

export async function markAchievementsSeen(db: D1Database, participantHash: string): Promise<number> {
  return markParticipantAchievementsSeen(db, participantHash);
}
