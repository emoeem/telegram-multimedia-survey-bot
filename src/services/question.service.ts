import {
  listOptionsForSurveyStatement,
  listQuestionsBySurveyStatement,
  mapOptionRows,
  mapQuestionRows,
} from "../db/repositories/question.repository";
import { buildSurveyFlow, type SurveyFlow } from "../survey/engine";

/**
 * Reads a survey's flow (questions plus their options).
 *
 * Both reads go out as one `db.batch()`: they are independent, so sending them
 * separately only buys a second round trip to the database's region (~90ms from
 * the Hong Kong edge to D1's region on every survey request).
 */
export async function getSurveyFlow(db: D1Database, surveyId: number): Promise<SurveyFlow> {
  const [questions, options] = await db.batch([
    listQuestionsBySurveyStatement(db, surveyId),
    listOptionsForSurveyStatement(db, surveyId),
  ]);

  return buildSurveyFlow(mapQuestionRows(questions), mapOptionRows(options));
}
