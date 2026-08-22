import type { QuestionOption, SurveyQuestion } from '../schema';

interface QuestionRow {
  id: number;
  survey_id: number;
  type: SurveyQuestion['type'];
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

// D1 limits the number of bound SQL parameters. Keep room below its limit so
// large surveys can be published and opened without a single oversized IN.
const QUESTION_ID_BATCH_SIZE = 90;

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

export async function listQuestionsBySurvey(db: D1Database, surveyId: number): Promise<SurveyQuestion[]> {
  const result = await db
    .prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY "order" ASC, id ASC')
    .bind(surveyId)
    .all<QuestionRow>();

  return (result.results ?? []).map(mapQuestion);
}

export async function listOptionsForQuestions(db: D1Database, questionIds: number[]): Promise<QuestionOption[]> {
  const uniqueQuestionIds = [...new Set(questionIds)];
  if (uniqueQuestionIds.length === 0) {
    return [];
  }

  const options: QuestionOption[] = [];
  for (let start = 0; start < uniqueQuestionIds.length; start += QUESTION_ID_BATCH_SIZE) {
    const questionIdBatch = uniqueQuestionIds.slice(start, start + QUESTION_ID_BATCH_SIZE);
    const placeholders = questionIdBatch.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT * FROM question_options
         WHERE question_id IN (${placeholders})
         ORDER BY question_id ASC, "order" ASC, id ASC`,
      )
      .bind(...questionIdBatch)
      .all<QuestionOptionRow>();
    options.push(...(result.results ?? []).map(mapOption));
  }

  return options;
}

export async function createQuestion(
  db: D1Database,
  input: {
    surveyId: number;
    type: SurveyQuestion['type'];
    title: string;
    description?: string | null;
    required?: boolean;
    order: number;
    settingsJson?: string | null;
    validationJson?: string | null;
    conditionJson?: string | null;
    skipToQuestionId?: number | null;
  },
): Promise<number> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO survey_questions (
        survey_id, type, title, description, required,
        "order", settings_json, validation_json, condition_json, skip_to_question_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.surveyId,
      input.type,
      input.title,
      input.description ?? null,
      input.required ? 1 : 0,
      input.order,
      input.settingsJson ?? null,
      input.validationJson ?? null,
      input.conditionJson ?? null,
      input.skipToQuestionId ?? null,
      timestamp,
      timestamp,
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== 'number') {
    throw new Error('Failed to create question');
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
): Promise<number> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO question_options (
        question_id, label, value, "order", created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.questionId, input.label, input.value, input.order, timestamp, timestamp)
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== 'number') {
    throw new Error('Failed to create question option');
  }

  return id;
}

export async function getQuestionById(db: D1Database, id: number): Promise<SurveyQuestion | null> {
  const row = await db.prepare('SELECT * FROM survey_questions WHERE id = ? LIMIT 1').bind(id).first<QuestionRow>();

  return row ? mapQuestion(row) : null;
}

export async function getQuestionOptionById(db: D1Database, id: number): Promise<QuestionOption | null> {
  const row = await db
    .prepare('SELECT * FROM question_options WHERE id = ? LIMIT 1')
    .bind(id)
    .first<QuestionOptionRow>();

  return row ? mapOption(row) : null;
}

export async function updateQuestionTitle(db: D1Database, id: number, title: string): Promise<void> {
  await db
    .prepare('UPDATE survey_questions SET title = ?, updated_at = ? WHERE id = ?')
    .bind(title, new Date().toISOString(), id)
    .run();
}

export async function updateQuestionDescription(db: D1Database, id: number, description: string | null): Promise<void> {
  await db
    .prepare('UPDATE survey_questions SET description = ?, updated_at = ? WHERE id = ?')
    .bind(description, new Date().toISOString(), id)
    .run();
}

export async function updateQuestionSettings(db: D1Database, id: number, settingsJson: string | null): Promise<void> {
  await db
    .prepare('UPDATE survey_questions SET settings_json = ?, updated_at = ? WHERE id = ?')
    .bind(settingsJson, new Date().toISOString(), id)
    .run();
}

export async function updateQuestionValidation(
  db: D1Database,
  id: number,
  validationJson: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE survey_questions SET validation_json = ?, updated_at = ? WHERE id = ?')
    .bind(validationJson, new Date().toISOString(), id)
    .run();
}

// Reorders all questions of a survey to match the given ID sequence,
// preserving the contiguous 0..n-1 "order" invariant in one batch.
export async function normalizeQuestionOrder(db: D1Database, surveyId: number, orderedIds: number[]): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.batch(
    orderedIds.map((id, index) =>
      db
        .prepare('UPDATE survey_questions SET "order" = ?, updated_at = ? WHERE id = ? AND survey_id = ?')
        .bind(index, timestamp, id, surveyId),
    ),
  );
}

export async function updateQuestionOptionLabel(db: D1Database, id: number, label: string): Promise<void> {
  await db
    .prepare(
      `UPDATE question_options
       SET label = ?, value = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(label, label, new Date().toISOString(), id)
    .run();
}

export async function deleteQuestionOption(db: D1Database, id: number): Promise<void> {
  const option = await getQuestionOptionById(db, id);
  if (!option) {
    return;
  }

  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM question_options WHERE id = ?').bind(id),
    db
      .prepare(
        `UPDATE question_options
         SET "order" = "order" - 1, updated_at = ?
         WHERE question_id = ? AND "order" > ?`,
      )
      .bind(timestamp, option.questionId, option.order),
  ]);
}

export async function updateQuestionRequired(db: D1Database, id: number, required: boolean): Promise<void> {
  await db
    .prepare('UPDATE survey_questions SET required = ?, updated_at = ? WHERE id = ?')
    .bind(required ? 1 : 0, new Date().toISOString(), id)
    .run();
}

export async function setQuestionSkipRule(
  db: D1Database,
  questionId: number,
  rule: { optionId: number; targetQuestionId: number } | null,
): Promise<void> {
  const current = await getQuestionById(db, questionId);
  const legacyRules: Array<{ optionId: number; targetQuestionId: number }> = [];
  if (current?.conditionJson) {
    try {
      const parsed = JSON.parse(current.conditionJson) as { optionId?: unknown; rules?: unknown };
      if (Array.isArray(parsed.rules)) {
        for (const item of parsed.rules) {
          if (item && typeof item === 'object') {
            const row = item as { optionId?: unknown; targetQuestionId?: unknown };
            const optionId = Number(row.optionId);
            const targetQuestionId = Number(row.targetQuestionId);
            if (Number.isInteger(optionId) && Number.isInteger(targetQuestionId))
              legacyRules.push({ optionId, targetQuestionId });
          }
        }
      } else {
        const optionId = Number(parsed.optionId);
        if (Number.isInteger(optionId) && current.skipToQuestionId)
          legacyRules.push({ optionId, targetQuestionId: current.skipToQuestionId });
      }
    } catch {
      // Invalid historical data is replaced by the newly saved rule.
    }
  }
  const rules = rule ? [...legacyRules.filter((item) => item.optionId !== rule.optionId), rule] : [];
  await db
    .prepare('UPDATE survey_questions SET condition_json = ?, skip_to_question_id = ?, updated_at = ? WHERE id = ?')
    .bind(
      rules.length > 0 ? JSON.stringify({ kind: 'option_equals', rules }) : null,
      rules[0]?.targetQuestionId ?? null,
      new Date().toISOString(),
      questionId,
    )
    .run();
}

export async function deleteQuestion(db: D1Database, id: number): Promise<void> {
  const question = await getQuestionById(db, id);
  if (!question) {
    return;
  }

  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM survey_questions WHERE id = ?').bind(id),
    db
      .prepare(
        `UPDATE survey_questions
         SET "order" = "order" - 1, updated_at = ?
         WHERE survey_id = ? AND "order" > ?`,
      )
      .bind(timestamp, question.surveyId, question.order),
  ]);
}

export async function swapQuestionOptionOrder(db: D1Database, firstId: number, secondId: number): Promise<void> {
  const first = await getQuestionOptionById(db, firstId);
  const second = await getQuestionOptionById(db, secondId);
  if (!first || !second || first.questionId !== second.questionId) {
    return;
  }

  const timestamp = new Date().toISOString();
  await db.batch([
    db
      .prepare('UPDATE question_options SET "order" = ?, updated_at = ? WHERE id = ?')
      .bind(second.order, timestamp, firstId),
    db
      .prepare('UPDATE question_options SET "order" = ?, updated_at = ? WHERE id = ?')
      .bind(first.order, timestamp, secondId),
  ]);
}

export async function duplicateQuestion(db: D1Database, questionId: number): Promise<number> {
  const question = await getQuestionById(db, questionId);
  if (!question) {
    throw new Error('Question not found');
  }

  await db
    .prepare(
      `UPDATE survey_questions
       SET "order" = "order" + 1, updated_at = ?
       WHERE survey_id = ? AND "order" > ?`,
    )
    .bind(new Date().toISOString(), question.surveyId, question.order)
    .run();

  const result = await db
    .prepare(
      `INSERT INTO survey_questions (
        survey_id, type, title, description, required,
        "order", settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      question.surveyId,
      question.type,
      `${question.title} (副本)`,
      question.description,
      question.required ? 1 : 0,
      question.order + 1,
      question.settingsJson,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== 'number') {
    throw new Error('Failed to duplicate question');
  }

  await db
    .prepare(
      `INSERT INTO question_media (
        question_id, media_asset_id, sort_order, created_at
      )
      SELECT ?, media_asset_id, sort_order, ?
      FROM question_media
      WHERE question_id = ?`,
    )
    .bind(id, new Date().toISOString(), questionId)
    .run();

  const options = await listOptionsForQuestions(db, [questionId]);
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (!option) continue;
    const newOptionId = await createQuestionOption(db, {
      questionId: id,
      label: option.label,
      value: option.value,
      order: index,
    });
    await db
      .prepare(
        `INSERT INTO option_media (
          question_option_id, media_asset_id, sort_order, created_at
        )
        SELECT ?, media_asset_id, sort_order, ?
        FROM option_media
        WHERE question_option_id = ?`,
      )
      .bind(newOptionId, new Date().toISOString(), option.id)
      .run();
  }

  return id;
}

export async function swapQuestionOrder(db: D1Database, firstId: number, secondId: number): Promise<void> {
  const first = await getQuestionById(db, firstId);
  const second = await getQuestionById(db, secondId);
  if (!first || !second) return;

  const timestamp = new Date().toISOString();
  await db.batch([
    db
      .prepare('UPDATE survey_questions SET "order" = ?, updated_at = ? WHERE id = ?')
      .bind(second.order, timestamp, firstId),
    db
      .prepare('UPDATE survey_questions SET "order" = ?, updated_at = ? WHERE id = ?')
      .bind(first.order, timestamp, secondId),
  ]);
}
