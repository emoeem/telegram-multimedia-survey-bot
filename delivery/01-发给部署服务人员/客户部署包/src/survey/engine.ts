import type { QuestionOption, SurveyQuestion } from "../db/schema";

export interface SurveyQuestionView extends SurveyQuestion {
  options: QuestionOption[];
}

export interface SurveyFlow {
  questions: SurveyQuestionView[];
}

export function buildSurveyFlow(
  questions: SurveyQuestion[],
  options: QuestionOption[],
): SurveyFlow {
  const optionsByQuestion = new Map<number, QuestionOption[]>();

  for (const option of options) {
    const list = optionsByQuestion.get(option.questionId) ?? [];
    list.push(option);
    optionsByQuestion.set(option.questionId, list);
  }

  return {
    questions: questions.map((question) => ({
      ...question,
      options: optionsByQuestion.get(question.id) ?? [],
    })),
  };
}

export function getFirstQuestion(
  flow: SurveyFlow,
): SurveyQuestionView | null {
  return flow.questions[0] ?? null;
}

export function getQuestionById(
  flow: SurveyFlow,
  questionId: number,
): SurveyQuestionView | null {
  return flow.questions.find((question) => question.id === questionId) ?? null;
}

export function getNextQuestion(
  flow: SurveyFlow,
  currentQuestionId: number,
): SurveyQuestionView | null {
  const index = flow.questions.findIndex(
    (question) => question.id === currentQuestionId,
  );

  if (index < 0 || index >= flow.questions.length - 1) {
    return null;
  }

  return flow.questions[index + 1] ?? null;
}

export function getNextQuestionAfterOption(
  flow: SurveyFlow,
  currentQuestionId: number,
  optionId: number | null,
): SurveyQuestionView | null {
  const current = getQuestionById(flow, currentQuestionId);
  if (current?.conditionJson && current.skipToQuestionId && optionId !== null) {
    try {
      const condition = JSON.parse(current.conditionJson) as { kind?: string; optionId?: unknown; rules?: Array<{ optionId?: unknown; targetQuestionId?: unknown }> };
      const rule = Array.isArray(condition.rules)
        ? condition.rules.find((item) => Number(item.optionId) === optionId)
        : condition.kind === "option_equals" && Number(condition.optionId) === optionId
          ? { targetQuestionId: current.skipToQuestionId }
          : null;
      const targetId = Number(rule?.targetQuestionId);
      const target = getQuestionById(flow, targetId);
      const currentIndex = flow.questions.findIndex((question) => question.id === currentQuestionId);
      const targetIndex = flow.questions.findIndex((question) => question.id === targetId);
      if (condition.kind === "option_equals" && rule && target && targetIndex > currentIndex) {
        return target;
      }
    } catch {
      // Malformed legacy condition data falls back to normal ordering.
    }
  }
  return getNextQuestion(flow, currentQuestionId);
}

export function getPreviousQuestion(
  flow: SurveyFlow,
  currentQuestionId: number,
): SurveyQuestionView | null {
  const index = flow.questions.findIndex(
    (question) => question.id === currentQuestionId,
  );

  if (index <= 0) {
    return null;
  }

  return flow.questions[index - 1] ?? null;
}

export function isLastQuestion(
  flow: SurveyFlow,
  currentQuestionId: number,
): boolean {
  const index = flow.questions.findIndex(
    (question) => question.id === currentQuestionId,
  );

  return index >= 0 && index === flow.questions.length - 1;
}
