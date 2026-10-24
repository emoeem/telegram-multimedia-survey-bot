import { nowIso } from "../db/client";

/**
 * 追更与站内通知（0084）。归属按 participant_hash（0082 canonical）；
 * 读侧不并集——关注与通知都是 canonical 身份下的新数据，写侧已归一。
 */

export interface NotificationRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  readAt: string | null;
  createdAt: string;
}

export async function toggleSeriesFollow(
  db: D1Database,
  participantHash: string,
  seriesId: number,
): Promise<{ following: boolean }> {
  const existing = await db
    .prepare("SELECT 1 AS found FROM series_follows WHERE participant_hash = ? AND series_id = ? LIMIT 1")
    .bind(participantHash, seriesId)
    .first();
  if (existing) {
    await db
      .prepare("DELETE FROM series_follows WHERE participant_hash = ? AND series_id = ?")
      .bind(participantHash, seriesId)
      .run();
    return { following: false };
  }
  await db
    .prepare("INSERT INTO series_follows (participant_hash, series_id, created_at) VALUES (?, ?, ?)")
    .bind(participantHash, seriesId, nowIso())
    .run();
  return { following: true };
}

export async function listNotifications(db: D1Database, participantHash: string, limit = 30) {
  const rows = await db
    .prepare(
      `SELECT id, kind, title, body, link, read_at readAt, created_at createdAt
       FROM notifications WHERE participant_hash = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(participantHash, limit)
    .all<NotificationRow>();
  const unread = await db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE participant_hash = ? AND read_at IS NULL")
    .bind(participantHash)
    .first<{ n: number }>();
  return { items: rows.results ?? [], unread: Number(unread?.n ?? 0) };
}

export async function markNotificationsSeen(db: D1Database, participantHash: string): Promise<number> {
  const result = await db
    .prepare("UPDATE notifications SET read_at = ? WHERE participant_hash = ? AND read_at IS NULL")
    .bind(nowIso(), participantHash)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * 发布新章节 → 给全部关注者插通知（单条 INSERT..SELECT，不逐行）。
 * 返回通知行数（TG push 的候选量）。
 */
export async function notifySeriesPublish(
  db: D1Database,
  input: { seriesId: number; seriesTitle: string; surveyId: number; chapterTitle: string },
): Promise<number> {
  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO notifications (participant_hash, kind, title, body, link, created_at)
       SELECT participant_hash, 'series_update', ?, ?, ?, ?
       FROM series_follows WHERE series_id = ?`,
    )
    .bind(
      `《${input.seriesTitle}》更新了`,
      `新章节：${input.chapterTitle}`,
      `/s/${input.surveyId}`,
      timestamp,
      input.seriesId,
    )
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * 连载更新召回的执行端（发布路由经 SELF fire-and-forget 调用）：
 * 1) 站内通知：给全部关注者插一行（单条 INSERT..SELECT）；
 * 2) TG push 兜底：绑定身份的关注者逐个私聊，上限 50 人、单条 3 秒超时、
 *    失败静默——push 是增强，任何失败都不能反过来影响发布。
 */
export async function runSeriesUpdateNotification(
  env: { DB: D1Database; BOT_TOKEN?: string },
  input: { seriesId: number; seriesTitle: string; surveyId: number; chapterTitle: string },
): Promise<{ notified: number; pushed: number }> {
  const notified = await notifySeriesPublish(env.DB, input);
  if (!env.BOT_TOKEN) return { notified, pushed: 0 };
  const telegramIds = await listFollowerTelegramIds(env.DB, input.seriesId);
  let pushed = 0;
  const text =
    `📖 你追的《${input.seriesTitle}》更新了\n\n` +
    `新章节：${input.chapterTitle}\n` +
    `${publicOriginPrefix(env)}/s/${input.surveyId}`;
  for (const chatId of telegramIds.slice(0, 50)) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) pushed += 1;
    } catch {
      // 单个失败不影响其余推送。
    }
  }
  return { notified, pushed };
}

function publicOriginPrefix(env: { PUBLIC_ORIGIN?: string } | { DB: D1Database }): string {
  const origin = (env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN ?? "";
  return origin.replace(/\/+$/, "");
}

/** TG push 兜底的候选：关注者里绑定了 Telegram 的 user id。 */
export async function listFollowerTelegramIds(db: D1Database, seriesId: number, limit = 200): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT u.telegram_user_id AS tid
       FROM series_follows f
       JOIN users u ON u.id = CAST(substr(f.participant_hash, 6) AS INTEGER)
       WHERE f.series_id = ? AND f.participant_hash LIKE 'user_%' AND u.telegram_user_id IS NOT NULL
       LIMIT ?`,
    )
    .bind(seriesId, limit)
    .all<{ tid: number }>();
  return (rows.results ?? []).map((row) => Number(row.tid)).filter((tid) => Number.isInteger(tid) && tid > 0);
}
