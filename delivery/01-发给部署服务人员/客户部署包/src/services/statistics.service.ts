import type { QuestionType, SurveyQuestion } from "../db/schema";

export interface SurveyStatistics {
  totalStarted: number;
  totalCompleted: number;
  completionRate: number;
}

export interface SurveyPerformance {
  id: number;
  title: string;
  status: "draft" | "published" | "closed" | "archived";
  ownerName: string;
  totalStarted: number;
  totalCompleted: number;
  inProgress: number;
  completionRate: number;
  lastCompletedAt: string | null;
}

export interface SurveyPortfolioStatistics {
  totalSurveys: number;
  publishedSurveys: number;
  totalStarted: number;
  totalCompleted: number;
}

function escapeLikeQuery(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function getSurveyPortfolioStatistics(
  db: D1Database,
): Promise<SurveyPortfolioStatistics> {
  const row = await db.prepare(
    `SELECT
       COUNT(s.id) AS total_surveys,
       SUM(CASE WHEN s.status = 'published' THEN 1 ELSE 0 END) AS published_surveys,
       COALESCE(SUM(r.total_started), 0) AS total_started,
       COALESCE(SUM(r.total_completed), 0) AS total_completed
     FROM surveys s
     LEFT JOIN (
       SELECT survey_id,
              COUNT(*) AS total_started,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS total_completed
       FROM survey_responses
       GROUP BY survey_id
     ) r ON r.survey_id = s.id`,
  ).first<{
    total_surveys: number;
    published_surveys: number | null;
    total_started: number;
    total_completed: number;
  }>();

  return {
    totalSurveys: row?.total_surveys ?? 0,
    publishedSurveys: row?.published_surveys ?? 0,
    totalStarted: row?.total_started ?? 0,
    totalCompleted: row?.total_completed ?? 0,
  };
}

export async function listSurveyPerformance(
  db: D1Database,
  limit: number,
  offset: number,
  search = "",
): Promise<{ items: SurveyPerformance[]; total: number }> {
  const normalizedSearch = search.trim().slice(0, 80);
  const searchPattern = `%${escapeLikeQuery(normalizedSearch)}%`;
  const where = normalizedSearch
    ? "WHERE s.title LIKE ? ESCAPE '\\' OR CAST(s.id AS TEXT) = ?"
    : "";
  const bindings = normalizedSearch
    ? [searchPattern, normalizedSearch, limit, offset]
    : [limit, offset];
  const result = await db.prepare(
    `SELECT
       s.id, s.title, s.status,
       COALESCE(NULLIF(TRIM(u.first_name), ''), NULLIF(TRIM(u.username), ''), '未命名创建者') AS owner_name,
       COALESCE(r.total_started, 0) AS total_started,
       COALESCE(r.total_completed, 0) AS total_completed,
       COALESCE(r.in_progress, 0) AS in_progress,
       r.last_completed_at
     FROM surveys s
     LEFT JOIN users u ON u.id = s.owner_id
     LEFT JOIN (
       SELECT survey_id,
              COUNT(*) AS total_started,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS total_completed,
              SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
              MAX(CASE WHEN status = 'completed' THEN completed_at END) AS last_completed_at
       FROM survey_responses
       GROUP BY survey_id
     ) r ON r.survey_id = s.id
     ${where}
     ORDER BY total_completed DESC, s.updated_at DESC, s.id DESC
     LIMIT ? OFFSET ?`,
  ).bind(...bindings).all<{
    id: number;
    title: string;
    status: SurveyPerformance["status"];
    owner_name: string;
    total_started: number;
    total_completed: number;
    in_progress: number;
    last_completed_at: string | null;
  }>();
  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS count FROM surveys s ${where}`,
  ).bind(...(normalizedSearch ? [searchPattern, normalizedSearch] : [])).first<{ count: number }>();

  return {
    items: (result.results ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      ownerName: row.owner_name,
      totalStarted: row.total_started,
      totalCompleted: row.total_completed,
      inProgress: row.in_progress,
      completionRate: row.total_started === 0 ? 0 : (row.total_completed / row.total_started) * 100,
      lastCompletedAt: row.last_completed_at,
    })),
    total: totalRow?.count ?? 0,
  };
}

export interface OptionStat {
  questionId: number;
  questionTitle: string;
  questionType: QuestionType;
  optionId: number;
  optionLabel: string;
  count: number;
  percentage: number;
}

export interface NumericStat {
  questionId: number;
  questionTitle: string;
  average: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export async function getSurveyStatistics(
  db: D1Database,
  surveyId: number,
): Promise<SurveyStatistics> {
  const row = await db
    .prepare(
      `SELECT
        COUNT(*) AS total_started,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS total_completed
       FROM survey_responses
       WHERE survey_id = ?`,
    )
    .bind(surveyId)
    .first<{ total_started: number; total_completed: number | null }>();

  const totalStarted = row?.total_started ?? 0;
  const totalCompleted = row?.total_completed ?? 0;

  return {
    totalStarted,
    totalCompleted,
    completionRate: totalStarted === 0 ? 0 : (totalCompleted / totalStarted) * 100,
  };
}

export async function getOptionStatistics(
  db: D1Database,
  surveyId: number,
): Promise<OptionStat[]> {
  const optionsResult = await db
    .prepare(
      `SELECT
        q.id AS question_id,
        q.title AS question_title,
        q.type AS question_type,
        qo.id AS option_id,
        qo.label AS option_label
       FROM survey_questions q
       JOIN question_options qo ON qo.question_id = q.id
       WHERE q.survey_id = ?
         AND q.type IN ('single', 'multiple', 'yes_no', 'rating')
       ORDER BY q."order" ASC, qo."order" ASC`,
    )
    .bind(surveyId)
    .all<{
      question_id: number;
      question_title: string;
      question_type: string;
      option_id: number;
      option_label: string;
    }>();

  const answersResult = await db
    .prepare(
      `SELECT a.question_id, a.json_value
       FROM answers a
       JOIN survey_responses r ON r.id = a.response_id
       JOIN survey_questions q ON q.id = a.question_id
       WHERE q.survey_id = ?
         AND r.status = 'completed'
         AND q.type IN ('single', 'multiple', 'yes_no', 'rating')`,
    )
    .bind(surveyId)
    .all<{ question_id: number; json_value: string | null }>();

  const counts = new Map<number, number>();
  for (const answer of answersResult.results ?? []) {
    if (!answer.json_value) continue;
    try {
      const selected = JSON.parse(answer.json_value) as unknown;
      if (!Array.isArray(selected)) continue;
      for (const optionId of selected) {
        const numericOptionId = Number(optionId);
        if (Number.isInteger(numericOptionId)) {
          counts.set(
            numericOptionId,
            (counts.get(numericOptionId) ?? 0) + 1,
          );
        }
      }
    } catch {
      // Ignore malformed historical answers instead of breaking the report.
    }
  }

  const stats: OptionStat[] = [];
  const totals = new Map<number, number>();

  for (const row of optionsResult.results ?? []) {
    const current = totals.get(row.question_id) ?? 0;
    totals.set(row.question_id, current + (counts.get(row.option_id) ?? 0));
  }

  for (const row of optionsResult.results ?? []) {
    const total = totals.get(row.question_id) ?? 0;
    const count = counts.get(row.option_id) ?? 0;
    stats.push({
      questionId: row.question_id,
      questionTitle: row.question_title,
      questionType: row.question_type as QuestionType,
      optionId: row.option_id,
      optionLabel: row.option_label,
      count,
      percentage: total === 0 ? 0 : (count / total) * 100,
    });
  }

  return stats;
}

export async function getNumericStatistics(
  db: D1Database,
  surveyId: number,
): Promise<NumericStat[]> {
  const result = await db
    .prepare(
      `SELECT
        q.id AS question_id,
        q.title AS question_title,
        AVG(a.rating_value) AS avg_rating,
        MIN(a.rating_value) AS min_rating,
        MAX(a.rating_value) AS max_rating,
        AVG(a.number_value) AS avg_number,
        MIN(a.number_value) AS min_number,
        MAX(a.number_value) AS max_number,
        COUNT(a.id) AS count
       FROM survey_questions q
       LEFT JOIN answers a
         ON a.question_id = q.id
        AND a.response_id IN (
          SELECT id FROM survey_responses WHERE status = 'completed'
        )
       WHERE q.survey_id = ? AND q.type IN ('rating', 'number')
       GROUP BY q.id
       ORDER BY q."order" ASC`,
    )
    .bind(surveyId)
    .all<{
      question_id: number;
      question_title: string;
      avg_rating: number | null;
      min_rating: number | null;
      max_rating: number | null;
      avg_number: number | null;
      min_number: number | null;
      max_number: number | null;
      count: number;
    }>();

  return (result.results ?? []).map((row) => ({
    questionId: row.question_id,
    questionTitle: row.question_title,
    average: row.avg_rating ?? row.avg_number ?? null,
    min: row.min_rating ?? row.min_number ?? null,
    max: row.max_rating ?? row.max_number ?? null,
    count: row.count,
  }));
}

export async function getResponseCount(
  db: D1Database,
  surveyId: number,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM survey_responses WHERE survey_id = ?")
    .bind(surveyId)
    .first<{ count: number }>();

  return row?.count ?? 0;
}
