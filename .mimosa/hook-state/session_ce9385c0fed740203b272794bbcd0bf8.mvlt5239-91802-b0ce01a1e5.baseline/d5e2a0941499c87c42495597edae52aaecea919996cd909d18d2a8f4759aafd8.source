import { describe, expect, it } from "vitest";

import { buildSurveyFlow, computeFlags, getNextQuestionAfterAnswers } from "../../../src/survey/engine";
import type { QuestionOption, SurveyQuestion } from "../../../src/db/schema";

/**
 * 剧情 flags（P2）：flagRules 累计 → flagJumps 门槛跳转。确定性重放——
 * flags 永远由已保存答案推导，续答不丢路线。
 */

function question(id: number, order: number, conditionJson: string | null, type = "single"): SurveyQuestion {
  return {
    id,
    surveyId: 1,
    type: type as SurveyQuestion["type"],
    title: `Q${id}`,
    description: null,
    required: false,
    order,
    pageId: null,
    settingsJson: null,
    validationJson: null,
    conditionJson,
    skipToQuestionId: null,
  } as SurveyQuestion;
}

function option(id: number, questionId: number): QuestionOption {
  return { id, questionId, label: `O${id}`, order: 0 } as QuestionOption;
}

const QUESTIONS = [
  question(1, 0, JSON.stringify({ flagRules: [{ questionId: 1, equals: 11, flag: "affection", score: 2 }] })),
  question(2, 1, JSON.stringify({ flagRules: [{ questionId: 2, equals: 22, flag: "affection", score: 1 }] })),
  question(3, 2, JSON.stringify({ flagJumps: [{ flag: "affection", gte: 3, targetQuestionId: 5 }] })),
  question(4, 3, null),
  question(5, 4, null),
];

const FLOW = buildSurveyFlow(QUESTIONS, [option(11, 1), option(12, 1), option(22, 2), option(23, 2)]);

describe("flags engine", () => {
  it("accumulates flag scores from matching answers", () => {
    const flags = computeFlags(
      FLOW,
      new Map<number, unknown>([
        [1, 11],
        [2, 22],
      ]),
    );
    expect(flags.get("affection")).toBe(3);
  });

  it("ignores non-matching answers", () => {
    const flags = computeFlags(FLOW, new Map<number, unknown>([[1, 12]]));
    expect(flags.get("affection") ?? 0).toBe(0);
  });

  it("jumps forward when the flag threshold is met", () => {
    const next = getNextQuestionAfterAnswers(FLOW, 3, null, new Map<number, unknown>([[1, 11]]));
    // affection = 2 < 3 → 线性进入 Q4
    expect(next?.id).toBe(4);

    const jumped = getNextQuestionAfterAnswers(
      FLOW,
      3,
      null,
      new Map<number, unknown>([
        [1, 11],
        [2, 22],
      ]),
    );
    // affection = 3 ≥ 3 → 直达 Q5
    expect(jumped?.id).toBe(5);
  });

  it("never jumps backward (forward-only targets)", () => {
    const backwards = buildSurveyFlow(
      [
        question(9, 0, null),
        question(10, 1, JSON.stringify({ flagJumps: [{ flag: "x", gte: 0, targetQuestionId: 9 }] })),
      ],
      [],
    );
    const next = getNextQuestionAfterAnswers(backwards, 10, null, new Map<number, unknown>());
    expect(next).toBeNull();
  });
});
