import type { Survey } from '../db/schema';
import { MATRIX_COLUMN_MIN, isMatrixQuestionType, minOptionCount, parseMatrixColumns } from '../survey/question-rules';
import { createSurvey, getSurveyById, listSurveysByOwner } from '../db/repositories/survey.repository';
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

  const questions = await listQuestionsBySurvey(db, surveyId);
  const options = await listOptionsForQuestions(
    db,
    questions.map((question) => question.id),
  );
  const optionsByQuestion = new Map<number, typeof options>();

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
      settingsJson: question.settingsJson,
    });

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

  return duplicate;
}
