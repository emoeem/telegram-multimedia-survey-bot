import { listOptionsForQuestions, listQuestionsBySurvey } from "../db/repositories/question.repository";
import { buildSurveyFlow, type SurveyFlow } from "../survey/engine";

export async function getSurveyFlow(
  db: D1Database,
  surveyId: number,
): Promise<SurveyFlow> {
  const questions = await listQuestionsBySurvey(db, surveyId);
  const questionIds = questions.map((question) => question.id);
  const options = await listOptionsForQuestions(db, questionIds);

  return buildSurveyFlow(questions, options);
}
