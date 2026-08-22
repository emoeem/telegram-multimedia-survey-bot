import type { Survey } from '../db/schema';
import { MATRIX_COLUMN_MIN, isMatrixQuestionType, minOptionCount, parseMatrixColumns } from '../survey/question-rules';
import {
  createSurvey,
  getSurveyById,
  listSurveysByOwner,
  updateSurveyStatus,
} from '../db/repositories/survey.repository';
import { createSurveyVersionSnapshot } from './survey-version.service';
import {
  createQuestion,
  createQuestionOption,
  listOptionsForQuestions,
  listQuestionsBySurvey,
} from '../db/repositories/question.repository';

export async function getPublishedSurveys(db: D1Database): Promise<Survey[]> {
  const result = await db.prepare("SELECT * FROM surveys WHERE status = 'published' ORDER BY id DESC").all();

  return (result.results ?? []).map((row) => {
    const surveyRow = row as Record<string, unknown>;
    return {
      id: Number(surveyRow['id']),
      ownerId: Number(surveyRow['owner_id']),
      title: String(surveyRow['title']),
      description: surveyRow['description'] === null ? null : String(surveyRow['description']),
      coverMediaId: surveyRow['cover_media_id'] === null ? null : Number(surveyRow['cover_media_id']),
      status: String(surveyRow['status']) as Survey['status'],
      anonymous: Number(surveyRow['anonymous']) === 1,
      allowMultipleResponses: Number(surveyRow['allow_multiple_responses']) === 1,
      maxResponsesPerUser: Number(surveyRow['max_responses_per_user']),
      version: Number(surveyRow['version']),
      createdAt: String(surveyRow['created_at']),
      updatedAt: String(surveyRow['updated_at']),
      publishedAt: surveyRow['published_at'] === null ? null : String(surveyRow['published_at']),
      closedAt: surveyRow['closed_at'] === null ? null : String(surveyRow['closed_at']),
      archivedAt: surveyRow['archived_at'] === null ? null : String(surveyRow['archived_at']),
      accessCode: surveyRow['access_code'] === null ? null : String(surveyRow['access_code']),
      accessCodeEncrypted:
        surveyRow['access_code_encrypted'] === null || surveyRow['access_code_encrypted'] === undefined
          ? null
          : String(surveyRow['access_code_encrypted']),
      reportTemplateId:
        surveyRow['report_template_id'] === null || surveyRow['report_template_id'] === undefined
          ? null
          : String(surveyRow['report_template_id']),
    };
  });
}

export async function getSurveyDetail(db: D1Database, surveyId: number): Promise<Survey | null> {
  return getSurveyById(db, surveyId);
}

export async function listMySurveys(db: D1Database, ownerId: number): Promise<Survey[]> {
  return listSurveysByOwner(db, ownerId);
}

export async function assertSurveyCanPublish(db: D1Database, surveyId: number): Promise<void> {
  const survey = await getSurveyById(db, surveyId);
  if (!survey) {
    throw new Error('问卷不存在');
  }
  if (!survey.title.trim()) {
    throw new Error('问卷标题不能为空');
  }

  const questions = await listQuestionsBySurvey(db, surveyId);
  if (questions.length === 0) {
    throw new Error('问卷至少需要一道题');
  }

  const options = await listOptionsForQuestions(
    db,
    questions.map((question) => question.id),
  );
  for (const question of questions) {
    if (!question.title.trim()) {
      throw new Error(`第 ${question.order + 1} 题的标题不能为空`);
    }
    const minOptions = minOptionCount(question.type);
    if (minOptions !== null) {
      const optionCount = options.filter((option) => option.questionId === question.id).length;
      if (optionCount < minOptions) {
        throw new Error(
          isMatrixQuestionType(question.type)
            ? `第 ${question.order + 1} 题至少需要 ${minOptions} 个行选项`
            : `第 ${question.order + 1} 题至少需要两个选项`,
        );
      }
    }
    if (isMatrixQuestionType(question.type)) {
      const columns = parseMatrixColumns(question.settingsJson);
      if (columns.length < MATRIX_COLUMN_MIN) {
        throw new Error(`第 ${question.order + 1} 题的矩阵列至少需要 ${MATRIX_COLUMN_MIN} 个`);
      }
    }
  }
}

/**
 * Publishes a survey and persists a versioned snapshot of its definition.
 * Re-publishing an existing survey also bumps the version and writes a new
 * snapshot, so every response version stays resolvable.
 */
export async function publishSurvey(
  db: D1Database,
  surveyId: number,
  publishedBy: number | null = null,
): Promise<Survey> {
  await assertSurveyCanPublish(db, surveyId);
  const published = await updateSurveyStatus(db, surveyId, 'published');
  if (!published) {
    throw new Error('问卷不存在');
  }
  await createSurveyVersionSnapshot(db, surveyId, publishedBy);
  return published;
}

export async function assertSurveyQuestionsEditable(db: D1Database, surveyId: number): Promise<void> {
  const survey = await getSurveyById(db, surveyId);
  if (!survey) {
    throw new Error('问卷不存在');
  }

  const responseCount = await db
    .prepare('SELECT COUNT(*) AS count FROM survey_responses WHERE survey_id = ?')
    .bind(surveyId)
    .first<{ count: number }>();

  if ((responseCount?.count ?? 0) > 0) {
    throw new Error('该问卷已有答卷，题目和附件已锁定。请复制问卷后再修改。');
  }
}

export async function duplicateSurvey(db: D1Database, surveyId: number, ownerId: number): Promise<Survey> {
  const original = await getSurveyById(db, surveyId);
  if (!original) {
    throw new Error('Survey not found');
  }

  const duplicate = await createSurvey(db, {
    ownerId,
    title: `${original.title} (副本)`,
    description: original.description,
    anonymous: original.anonymous,
    allowMultipleResponses: original.allowMultipleResponses,
    maxResponsesPerUser: original.maxResponsesPerUser,
  });

  const pageRows = await db
    .prepare(
      `SELECT id, title, description, "order"
       FROM survey_pages
       WHERE survey_id = ?
       ORDER BY "order" ASC, id ASC`,
    )
    .bind(surveyId)
    .all<{ id: number; title: string | null; description: string | null; order: number }>();
  const pageIdMap = new Map<number, number>();
  const timestamp = new Date().toISOString();
  for (const page of pageRows.results ?? []) {
    const result = await db
      .prepare(
        `INSERT INTO survey_pages (
          survey_id, title, description, "order", created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(duplicate.id, page.title, page.description, page.order, timestamp, timestamp)
      .run();
    const newPageId = result.meta?.last_row_id;
    if (typeof newPageId !== "number") {
      throw new Error("Failed to duplicate survey page");
    }
    pageIdMap.set(page.id, newPageId);
  }

  const questions = await listQuestionsBySurvey(db, surveyId);
  const options = await listOptionsForQuestions(
    db,
    questions.map((question) => question.id),
  );
  const optionsByQuestion = new Map<number, typeof options>();
  const questionIdMap = new Map<number, number>();
  const optionIdMap = new Map<number, number>();

  for (const option of options) {
    const list = optionsByQuestion.get(option.questionId) ?? [];
    list.push(option);
    optionsByQuestion.set(option.questionId, list);
  }

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    if (!question) continue;

    const questionId = await createQuestion(db, {
      surveyId: duplicate.id,
      type: question.type,
      title: question.title,
      description: question.description,
      required: question.required,
      order: index,
      pageId: question.pageId !== null ? (pageIdMap.get(question.pageId) ?? null) : null,
      settingsJson: question.settingsJson,
      validationJson: question.validationJson,
    });
    questionIdMap.set(question.id, questionId);

    await db
      .prepare(
        `INSERT INTO question_media (
          question_id, media_asset_id, sort_order, created_at
        )
        SELECT ?, media_asset_id, sort_order, ?
        FROM question_media
        WHERE question_id = ?`,
      )
      .bind(questionId, new Date().toISOString(), question.id)
      .run();

    const questionOptions = optionsByQuestion.get(question.id) ?? [];
    for (let optionIndex = 0; optionIndex < questionOptions.length; optionIndex += 1) {
      const option = questionOptions[optionIndex];
      if (!option) continue;
      const optionId = await createQuestionOption(db, {
        questionId,
        label: option.label,
        value: option.value,
        order: optionIndex,
      });
      optionIdMap.set(option.id, optionId);
      await db
        .prepare(
          `INSERT INTO option_media (
            question_option_id, media_asset_id, sort_order, created_at
          )
          SELECT ?, media_asset_id, sort_order, ?
          FROM option_media
          WHERE question_option_id = ?`,
        )
        .bind(optionId, new Date().toISOString(), option.id)
        .run();
    }
  }

  for (const question of questions) {
    const questionId = questionIdMap.get(question.id);
    if (!questionId) continue;
    let conditionJson = question.conditionJson;
    if (conditionJson) {
      try {
        const remapReferences = (value: unknown, key?: string): unknown => {
          if (Array.isArray(value)) return value.map((item) => remapReferences(item));
          if (value && typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value).map(([childKey, childValue]) => [
                childKey,
                remapReferences(childValue, childKey),
              ]),
            );
          }
          if (key === 'optionId' && typeof value === 'number') return optionIdMap.get(value) ?? value;
          if (key === 'targetQuestionId' && typeof value === 'number') return questionIdMap.get(value) ?? value;
          return value;
        };
        conditionJson = JSON.stringify(remapReferences(JSON.parse(conditionJson)));
      } catch {
        // Preserve malformed legacy data rather than silently dropping it.
      }
    }
    const mappedSkipToQuestionId = question.skipToQuestionId
      ? (questionIdMap.get(question.skipToQuestionId) ?? null)
      : null;
    const mappedParentQuestionId = question.parentQuestionId
      ? (questionIdMap.get(question.parentQuestionId) ?? null)
      : null;
    if (conditionJson || mappedSkipToQuestionId || mappedParentQuestionId) {
      await db
        .prepare(
          `UPDATE survey_questions
           SET condition_json = ?, skip_to_question_id = ?, parent_question_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(conditionJson, mappedSkipToQuestionId, mappedParentQuestionId, new Date().toISOString(), questionId)
        .run();
    }
  }

  return duplicate;
}
