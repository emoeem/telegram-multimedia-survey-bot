import type { QuestionOption, SurveyQuestion } from "../schema";

interface QuestionRow {
  id: number;
  survey_id: number;
  type: SurveyQuestion["type"];
  title: string;
  description: string | null;
  required: number;
  order: number;
  validation_json: string | null;
  settings_json: string | null;
  parent_question_id: number | null;
  condition_json: string | null;
  skip_to_question_id: number | null;
  created_at: string;
  updated_at: string;
}

interface QuestionOptionRow {
  id: number;
  question_id: number;
  label: string;
  value: string;
  order: number;
  is_other: number;
  created_at: string;
  updated_at: string;
}

function mapQuestion(row: QuestionRow): SurveyQuestion {
  return {
    id: row.id,
    surveyId: row.survey_id,
    type: row.type,
    title: row.title,
    description: row.description,
    required: row.required === 1,
    order: row.order,
    validationJson: row.validation_json,
    settingsJson: row.settings_json,
    parentQuestionId: row.parent_question_id,
    conditionJson: row.condition_json,
    skipToQuestionId: row.skip_to_question_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOption(row: QuestionOptionRow): QuestionOption {
  return {
    id: row.id,
    questionId: row.question_id,
    label: row.label,
    value: row.value,
    order: row.order,
    isOther: row.is_other === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listQuestionsBySurvey(
  db: D1Database,
  surveyId: number,
): Promise<SurveyQuestion[]> {
  const result = await db
    .prepare(
      'SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY "order" ASC, id ASC',
    )
    .bind(surveyId)
    .all<QuestionRow>();

  return (result.results ?? []).map(mapQuestion);
}

export async function listOptionsForQuestions(
  db: D1Database,
  questionIds: number[],
): Promise<QuestionOption[]> {
  if (questionIds.length === 0) {
    return [];
  }

  const placeholders = questionIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT * FROM question_options
       WHERE question_id IN (${placeholders})
       ORDER BY question_id ASC, "order" ASC, id ASC`,
    )
    .bind(...questionIds)
    .all<QuestionOptionRow>();

  return (result.results ?? []).map(mapOption);
}

export async function createQuestion(
  db: D1Database,
  input: {
    surveyId: number;
    type: SurveyQuestion["type"];
    title: string;
    description?: string | null;
    required?: boolean;
    order: number;
  },
): Promise<number> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO survey_questions (
        survey_id, type, title, description, required,
        "order", created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.surveyId,
      input.type,
      input.title,
      input.description ?? null,
      input.required ? 1 : 0,
      input.order,
      timestamp,
      timestamp,
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to create question");
  }

  return id;
}

export async function createQuestionOption(
  db: D1Database,
  input: {
    questionId: number;
    label: string;
    value: string;
    order: number;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO question_options (
        question_id, label, value, "order", created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.questionId,
      input.label,
      input.value,
      input.order,
      timestamp,
      timestamp,
    )
    .run();
}
