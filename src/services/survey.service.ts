import type { Survey } from "../db/schema";
import { createSurvey, getSurveyById, listSurveysByOwner } from "../db/repositories/survey.repository";
import {
  createQuestion,
  createQuestionOption,
  listOptionsForQuestions,
  listQuestionsBySurvey,
} from "../db/repositories/question.repository";

export async function getPublishedSurveys(
  db: D1Database,
): Promise<Survey[]> {
  const result = await db
    .prepare(
      "SELECT * FROM surveys WHERE status = 'published' ORDER BY id DESC",
    )
    .all();

  return (result.results ?? []).map((row) => {
    const surveyRow = row as Record<string, unknown>;
    return {
      id: Number(surveyRow["id"]),
      ownerId: Number(surveyRow["owner_id"]),
      title: String(surveyRow["title"]),
      description: surveyRow["description"] === null ? null : String(surveyRow["description"]),
      coverMediaId: surveyRow["cover_media_id"] === null ? null : Number(surveyRow["cover_media_id"]),
      status: String(surveyRow["status"]) as Survey["status"],
      anonymous: Number(surveyRow["anonymous"]) === 1,
      allowMultipleResponses: Number(surveyRow["allow_multiple_responses"]) === 1,
      maxResponsesPerUser: Number(surveyRow["max_responses_per_user"]),
      version: Number(surveyRow["version"]),
      createdAt: String(surveyRow["created_at"]),
      updatedAt: String(surveyRow["updated_at"]),
      publishedAt: surveyRow["published_at"] === null ? null : String(surveyRow["published_at"]),
      closedAt: surveyRow["closed_at"] === null ? null : String(surveyRow["closed_at"]),
      archivedAt: surveyRow["archived_at"] === null ? null : String(surveyRow["archived_at"]),
    };
  });
}

export async function getSurveyDetail(
  db: D1Database,
  surveyId: number,
): Promise<Survey | null> {
  return getSurveyById(db, surveyId);
}

export async function listMySurveys(
  db: D1Database,
  ownerId: number,
): Promise<Survey[]> {
  return listSurveysByOwner(db, ownerId);
}

export async function duplicateSurvey(
  db: D1Database,
  surveyId: number,
  ownerId: number,
): Promise<Survey> {
  const original = await getSurveyById(db, surveyId);
  if (!original) {
    throw new Error("Survey not found");
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
    });

    const questionOptions = optionsByQuestion.get(question.id) ?? [];
    for (let optionIndex = 0; optionIndex < questionOptions.length; optionIndex += 1) {
      const option = questionOptions[optionIndex];
      if (!option) continue;
      await createQuestionOption(db, {
        questionId,
        label: option.label,
        value: option.value,
        order: optionIndex,
      });
    }
  }

  return duplicate;
}
