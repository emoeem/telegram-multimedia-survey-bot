import type { QuestionType, SurveyQuestion } from "../db/schema";

export interface SurveyStatistics {
  totalStarted: number;
  totalCompleted: number;
  completionRate: number;
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
