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

/**
 * 剧情 flags（P2）：由答案推导的中间态，用于路线锁定与条件跳转。
 *
 * 数据都在 condition_json 里，无需迁移：
 *  - `flagRules: [{questionId, equals, flag, score?}]`——任意题目的答案命中
 *    即给 flag 累计分（确定性：flags 永远可从已保存答案重放，续答不丢）；
 *  - `flagJumps: [{flag, gte, targetQuestionId}]`——当前题的 flagJumps 在
 *    跳题时对累计 flags 求值，达成门槛即向前跳（目标必须向前，与其它跳转
 *    同一约束）。
 */
export interface SurveyFlagRule {
  questionId?: unknown;
  equals?: unknown;
  flag?: unknown;
  score?: unknown;
}

export type SurveyFlags = Map<string, number>;

export function computeFlags(flow: SurveyFlow, answers: Map<number, unknown>): SurveyFlags {
  const flags: SurveyFlags = new Map();
  for (const question of flow.questions) {
    if (!question.conditionJson) continue;
    try {
      const condition = JSON.parse(question.conditionJson) as { flagRules?: unknown };
      if (!Array.isArray(condition.flagRules)) continue;
      for (const rule of condition.flagRules as SurveyFlagRule[]) {
        const flag = typeof rule.flag === "string" ? rule.flag : null;
        if (!flag) continue;
        const value = answers.get(Number(rule.questionId));
        if (value === undefined || value === null) continue;
        if (Number(rule.equals) !== Number(value)) continue;
        const score = Number(rule.score);
        flags.set(flag, (flags.get(flag) ?? 0) + (Number.isFinite(score) ? score : 1));
      }
    } catch {
      // 脏数据按没有 flagRules 处理。
    }
  }
  return flags;
}

function flagJumpTarget(
  flow: SurveyFlow,
  currentIndex: number,
  condition: { flagJumps?: unknown },
  flags: SurveyFlags,
): SurveyQuestionView | null {
  if (!Array.isArray(condition.flagJumps)) return null;
  for (const jump of condition.flagJumps as Array<{ flag?: unknown; gte?: unknown; targetQuestionId?: unknown }>) {
    const flag = typeof jump.flag === "string" ? jump.flag : null;
    if (!flag) continue;
    const threshold = Number(jump.gte);
    if (!Number.isFinite(threshold)) continue;
    if ((flags.get(flag) ?? 0) < threshold) continue;
    const target = forwardTarget(flow, currentIndex, jump.targetQuestionId);
    if (target) return target;
  }
  return null;
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
  const flags = computeFlags(flow, answers);
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

      // flags 路线锁定（P2）：门槛达成即跳，优先级在 answerRules 之后。
      const flagTarget = flagJumpTarget(flow, currentIndex, condition as { flagJumps?: unknown }, flags);
      if (flagTarget) {
        return flagTarget;
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

function forwardTarget(flow: SurveyFlow, currentIndex: number, targetQuestionId: unknown): SurveyQuestionView | null {
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
