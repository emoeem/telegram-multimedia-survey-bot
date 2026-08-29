/**
 * Weekly operations digest for the report archive channel: last-7-days
 * response volume, completion rate and the top surveys, aggregated with one
 * D1 query and delivered through the normal Telegram send path.
 */
export interface WeeklyDigestData {
  started: number;
  completed: number;
  completionRate: number;
  topSurveys: Array<{ id: number; title: string; completed: number }>;
  windowStartIso: string;
  windowEndIso: string;
}

export async function loadWeeklyDigest(db: D1Database, now = new Date()): Promise<WeeklyDigestData> {
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const totals = await db
    .prepare(
      `SELECT
         COUNT(*) AS started,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM survey_responses
       WHERE started_at >= ? AND started_at < ?`,
    )
    .bind(windowStart, windowEnd)
    .first<{ started: number; completed: number | null }>();

  const top = await db
    .prepare(
      `SELECT s.id, s.title, COUNT(r.id) AS completed
       FROM survey_responses r
       JOIN surveys s ON s.id = r.survey_id
       WHERE r.status = 'completed' AND r.started_at >= ? AND r.started_at < ?
       GROUP BY s.id, s.title
       ORDER BY completed DESC
       LIMIT 3`,
    )
    .bind(windowStart, windowEnd)
    .all<{ id: number; title: string; completed: number }>();

  const started = Number(totals?.started ?? 0);
  const completed = Number(totals?.completed ?? 0);
  return {
    started,
    completed,
    completionRate: started > 0 ? Math.round((completed / started) * 100) : 0,
    topSurveys: (top.results ?? []).map((row) => ({
      id: Number(row.id),
      title: String(row.title),
      completed: Number(row.completed),
    })),
    windowStartIso: windowStart,
    windowEndIso: windowEnd,
  };
}

export function renderWeeklyDigestMessage(data: WeeklyDigestData): string {
  const dateRange = `${data.windowStartIso.slice(0, 10)} ~ ${data.windowEndIso.slice(0, 10)}`;
  const lines = [
    "📊 问卷平台 · 每周摘要",
    "",
    `过去 7 天（${dateRange}）：`,
    `· 新开答卷 ${data.started} 份`,
    `· 完成提交 ${data.completed} 份（完成率 ${data.completionRate}%）`,
  ];
  if (data.topSurveys.length) {
    lines.push("", "🔥 最受欢迎：");
    data.topSurveys.forEach((survey, index) => {
      lines.push(`${index + 1}. 《${survey.title}》— ${survey.completed} 份`);
    });
  } else {
    lines.push("", "本周还没有已完成的答卷，下周继续加油。");
  }
  return lines.join("\n");
}
