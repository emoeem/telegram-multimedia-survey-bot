import type { QuestionOption, SurveyQuestion } from "../db/schema";

export interface SurveyQuestionView extends SurveyQuestion {
  options: QuestionOption[];
}

export interface SurveyFlow {
  questions: SurveyQuestionView[];
}

export function buildSurveyFlow(questions: SurveyQuestion[], options: QuestionOption[]): SurveyFlow {
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

export function getFirstQuestion(flow: SurveyFlow): SurveyQuestionView | null {
  return flow.questions[0] ?? null;
}

export function getQuestionById(flow: SurveyFlow, questionId: number): SurveyQuestionView | null {
  return flow.questions.find((question) => question.id === questionId) ?? null;
}

export function getNextQuestion(flow: SurveyFlow, currentQuestionId: number): SurveyQuestionView | null {
  const index = flow.questions.findIndex((question) => question.id === currentQuestionId);

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
  return getNextQuestionAfterAnswers(flow, currentQuestionId, optionId, new Map());
}

/**
 * Resolves the next question honouring both jump mechanisms stored in
 * condition_json:
 *
 *  - option rules (`kind: "option_equals"` + rules/optionId + skipToQuestionId):
 *    fire when the participant just selected a matching option. Legacy shape
 *    keeps requiring a truthy skipToQuestionId, exactly as before.
 *  - answer rules (`answerRules: [{questionId, equals, targetQuestionId}]`):
 *    state-driven jumps evaluated against answers accumulated so far. They
 *    also fire on `note` questions (no selection), which is how narrative
 *    cards branch on prior choices. Targets are forward-only.
 */
export function getNextQuestionAfterAnswers(
  flow: SurveyFlow,
  currentQuestionId: number,
  optionId: number | null,
  answers: Map<number, unknown>,
): SurveyQuestionView | null {
  const current = getQuestionById(flow, currentQuestionId);
  if (current?.conditionJson) {
    try {
      const condition = JSON.parse(current.conditionJson) as {
        kind?: string;
        optionId?: unknown;
        rules?: Array<{ optionId?: unknown; targetQuestionId?: unknown }>;
        answerRules?: Array<{ questionId?: unknown; equals?: unknown; targetQuestionId?: unknown }>;
      };
      const currentIndex = flow.questions.findIndex((question) => question.id === currentQuestionId);

      if (selectedOptionMatches(condition, current, optionId)) {
        const rule = Array.isArray(condition.rules)
          ? condition.rules.find((item) => Number(item.optionId) === optionId)
          : Number(condition.optionId) === optionId
            ? { targetQuestionId: current.skipToQuestionId }
            : null;
        const target = forwardTarget(flow, currentIndex, rule?.targetQuestionId);
        if (target) {
          return target;
        }
      }

      if (Array.isArray(condition.answerRules)) {
        for (const rule of condition.answerRules) {
          const value = answers.get(Number(rule.questionId));
          if (value === undefined || value === null) continue;
          if (Number(rule.equals) !== Number(value)) continue;
          const target = forwardTarget(flow, currentIndex, rule.targetQuestionId);
          if (target) {
            return target;
          }
        }
      }
    } catch {
      // Malformed legacy condition data falls back to normal ordering.
    }
  }
  return getNextQuestion(flow, currentQuestionId);
}

function selectedOptionMatches(
  condition: { kind?: string; rules?: unknown },
  current: SurveyQuestionView,
  optionId: number | null,
): boolean {
  return (
    optionId !== null &&
    condition.kind === "option_equals" &&
    // Legacy single-option form always carries skipToQuestionId; rules arrays
    // are self-contained (the admin editor derives skipTo from rules[0], but
    // hand-authored content may omit it).
    (Boolean(current.skipToQuestionId) || Array.isArray(condition.rules))
  );
}

function forwardTarget(
  flow: SurveyFlow,
  currentIndex: number,
  targetQuestionId: unknown,
): SurveyQuestionView | null {
  const targetId = Number(targetQuestionId);
  if (!Number.isInteger(targetId) || targetId <= 0) return null;
  const targetIndex = flow.questions.findIndex((question) => question.id === targetId);
  if (targetIndex < 0 || targetIndex <= currentIndex) return null;
  return flow.questions[targetIndex] ?? null;
}

export function getPreviousQuestion(flow: SurveyFlow, currentQuestionId: number): SurveyQuestionView | null {
  const index = flow.questions.findIndex((question) => question.id === currentQuestionId);

  if (index <= 0) {
    return null;
  }

  return flow.questions[index - 1] ?? null;
}

export function isLastQuestion(flow: SurveyFlow, currentQuestionId: number): boolean {
  const index = flow.questions.findIndex((question) => question.id === currentQuestionId);

  return index >= 0 && index === flow.questions.length - 1;
}
