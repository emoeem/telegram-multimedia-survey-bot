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

export async function getQuestionById(
  db: D1Database,
  id: number,
): Promise<SurveyQuestion | null> {
  const row = await db
    .prepare("SELECT * FROM survey_questions WHERE id = ? LIMIT 1")
    .bind(id)
    .first<QuestionRow>();

  return row ? mapQuestion(row) : null;
}

export async function updateQuestionTitle(
  db: D1Database,
  id: number,
  title: string,
): Promise<void> {
  await db
    .prepare("UPDATE survey_questions SET title = ?, updated_at = ? WHERE id = ?")
    .bind(title, new Date().toISOString(), id)
    .run();
}

export async function updateQuestionRequired(
  db: D1Database,
  id: number,
  required: boolean,
): Promise<void> {
  await db
    .prepare("UPDATE survey_questions SET required = ?, updated_at = ? WHERE id = ?")
    .bind(required ? 1 : 0, new Date().toISOString(), id)
    .run();
}

export async function duplicateQuestion(
  db: D1Database,
  questionId: number,
): Promise<number> {
  const question = await getQuestionById(db, questionId);
  if (!question) {
    throw new Error("Question not found");
  }

  const result = await db
    .prepare(
      `INSERT INTO survey_questions (
        survey_id, type, title, description, required,
        "order", created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      question.surveyId,
      question.type,
      `${question.title} (副本)`,
      question.description,
      question.required ? 1 : 0,
      question.order + 1,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to duplicate question");
  }

  const options = await listOptionsForQuestions(db, [questionId]);
  const statements = options.map((option, index) =>
    db
      .prepare(
        `INSERT INTO question_options (
          question_id, label, value, "order", created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, option.label, option.value, index, new Date().toISOString(), new Date().toISOString()),
  );

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return id;
}

export async function swapQuestionOrder(
  db: D1Database,
  firstId: number,
  secondId: number,
): Promise<void> {
  const first = await getQuestionById(db, firstId);
  const second = await getQuestionById(db, secondId);
  if (!first || !second) return;

  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE survey_questions SET "order" = ?, updated_at = ? WHERE id = ?')
      .bind(second.order, timestamp, firstId),
    db.prepare('UPDATE survey_questions SET "order" = ?, updated_at = ? WHERE id = ?')
      .bind(first.order, timestamp, secondId),
  ]);
}
