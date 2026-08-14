import type { UnifiedSurveyImport } from "../survey/schema";
import { getSurveyById } from "../db/repositories/survey.repository";
import {
  listOptionsForQuestions,
  listQuestionsBySurvey,
} from "../db/repositories/question.repository";

export async function exportUnifiedSurveyJson(
  db: D1Database,
  surveyId: number,
): Promise<UnifiedSurveyImport | null> {
  const survey = await getSurveyById(db, surveyId);
  if (!survey) {
    return null;
  }

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

  return {
    schema_version: 1,
    survey: {
      title: survey.title,
      ...(survey.description ? { description: survey.description } : {}),
      pages: [],
      questions: questions.map((question, index) => {
        const questionOptions = optionsByQuestion.get(question.id) ?? [];
        return {
          id: `q${index + 1}`,
          type: question.type,
          title: question.title,
          ...(question.description ? { description: question.description } : {}),
          required: question.required,
          order: index + 1,
          options: questionOptions.map((option, optionIndex) => ({
            id: `q${index + 1}_o${optionIndex + 1}`,
            label: option.label,
            value: option.value,
            order: optionIndex + 1,
          })),
          media: [],
        };
      }),
      settings: {
        anonymous: survey.anonymous,
        allow_multiple: survey.allowMultipleResponses,
        max_responses: survey.maxResponsesPerUser,
        shuffle_questions: false,
        shuffle_options: false,
        show_progress: true,
        allow_back: true,
        allow_resume: true,
      },
      metadata: {
        source: "telegram",
      },
    },
  };
}
