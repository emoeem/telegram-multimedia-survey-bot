import { describe, expect, it } from "vitest";

import {
  buildSurveyFlow,
  getFirstQuestion,
  getNextQuestion,
  getNextQuestionAfterAnswers,
  getNextQuestionAfterOption,
  getPreviousQuestion,
  isLastQuestion,
} from "../../../src/survey/engine";
import type { SurveyQuestion } from "../../../src/db/schema";

describe("survey engine", () => {
  const flow = buildSurveyFlow(
    [
      {
        id: 1,
        surveyId: 10,
        type: "text",
        title: "Q1",
        description: null,
        required: true,
        order: 0,
        pageId: null,
        validationJson: null,
        settingsJson: null,
        parentQuestionId: null,
        conditionJson: null,
        skipToQuestionId: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: 2,
        surveyId: 10,
        type: "single",
        title: "Q2",
        description: null,
        required: true,
        order: 1,
        pageId: null,
        validationJson: null,
        settingsJson: null,
        parentQuestionId: null,
        conditionJson: null,
        skipToQuestionId: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: 3,
        surveyId: 10,
        type: "text",
        title: "Q3",
        description: null,
        required: true,
        order: 2,
        pageId: null,
        validationJson: null,
        settingsJson: null,
        parentQuestionId: null,
        conditionJson: null,
        skipToQuestionId: null,
        createdAt: "",
        updatedAt: "",
      },
    ],
    [
      {
        id: 20,
        questionId: 2,
        label: "A",
        value: "a",
        order: 0,
        isOther: false,
        createdAt: "",
        updatedAt: "",
      },
    ],
  );

  it("gets first and next question", () => {
    expect(getFirstQuestion(flow)?.id).toBe(1);
    expect(getNextQuestion(flow, 1)?.id).toBe(2);
    expect(getNextQuestion(flow, 2)?.id).toBe(3);
  });

  it("gets previous question", () => {
    expect(getPreviousQuestion(flow, 3)?.id).toBe(2);
    expect(getPreviousQuestion(flow, 1)).toBeNull();
  });

  it("detects last question", () => {
    expect(isLastQuestion(flow, 1)).toBe(false);
    expect(isLastQuestion(flow, 3)).toBe(true);
  });

  it("attaches options to the matching question", () => {
    expect(flow.questions[1]?.options).toHaveLength(1);
  });

  it("uses the matching rule when a question has multiple branch rules", () => {
    const branched = buildSurveyFlow(
      flow.questions.map((question) =>
        question.id === 2
          ? {
              ...question,
              conditionJson: JSON.stringify({
                kind: "option_equals",
                rules: [
                  { optionId: 20, targetQuestionId: 3 },
                  { optionId: 21, targetQuestionId: 4 },
                ],
              }),
              skipToQuestionId: 3,
            }
          : question,
      ),
      [
        ...flow.questions[1]!.options,
        { id: 21, questionId: 2, label: "B", value: "b", order: 1, isOther: false, createdAt: "", updatedAt: "" },
      ],
    );
    branched.questions.push({ ...branched.questions[2]!, id: 4, title: "Q4", order: 3, options: [] });

    expect(getNextQuestionAfterOption(branched, 2, 20)?.id).toBe(3);
    expect(getNextQuestionAfterOption(branched, 2, 21)?.id).toBe(4);
  });
});

describe("getNextQuestionAfterAnswers", () => {
  const baseQuestion = (overrides: Partial<SurveyQuestion> & Pick<SurveyQuestion, "id" | "order" | "type" | "title">) => ({
    surveyId: 10,
    description: null,
    required: false,
    pageId: null,
    validationJson: null,
    settingsJson: null,
    parentQuestionId: null,
    conditionJson: null,
    skipToQuestionId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  });
  const options = [
    { id: 5, questionId: 1, label: "甲", value: "a", order: 0, isOther: false, createdAt: "", updatedAt: "" },
    { id: 6, questionId: 1, label: "乙", value: "b", order: 1, isOther: false, createdAt: "", updatedAt: "" },
  ];

  const buildNoteFlow = (conditionJson: string | null, skipToQuestionId: number | null = null) =>
    buildSurveyFlow(
      [
        baseQuestion({ id: 1, order: 0, type: "single", title: "选择" }),
        baseQuestion({ id: 2, order: 1, type: "note", title: "剧情", conditionJson, skipToQuestionId }),
        baseQuestion({ id: 3, order: 2, type: "text", title: "收束" }),
        baseQuestion({ id: 4, order: 3, type: "text", title: "尾声" }),
      ],
      options,
    );

  it("note questions jump on accumulated answers", () => {
    const flow = buildNoteFlow(
      JSON.stringify({ kind: "option_equals", answerRules: [{ questionId: 1, equals: 5, targetQuestionId: 3 }] }),
    );
    const answers = new Map<number, unknown>([[1, 5]]);
    expect(getNextQuestionAfterAnswers(flow, 2, null, answers)?.id).toBe(3);
  });

  it("note questions stay linear when no answer rule matches", () => {
    const flow = buildNoteFlow(
      JSON.stringify({ kind: "option_equals", answerRules: [{ questionId: 1, equals: 6, targetQuestionId: 3 }] }),
    );
    expect(getNextQuestionAfterAnswers(flow, 2, null, new Map([[1, 5]]))?.id).toBe(3);
  });

  it("answer rules never jump backwards", () => {
    const flow = buildNoteFlow(
      JSON.stringify({ kind: "option_equals", answerRules: [{ questionId: 1, equals: 5, targetQuestionId: 1 }] }),
    );
    expect(getNextQuestionAfterAnswers(flow, 2, null, new Map([[1, 5]]))?.id).toBe(3);
  });

  it("coerces stored values and equals numerically", () => {
    const flow = buildNoteFlow(
      JSON.stringify({ kind: "option_equals", answerRules: [{ questionId: 1, equals: "5", targetQuestionId: 3 }] }),
    );
    expect(getNextQuestionAfterAnswers(flow, 2, null, new Map([[1, "5"]]))?.id).toBe(3);
  });

  const buildChoiceFlow = (conditionJson: string | null, skipToQuestionId: number | null = null) =>
    buildSurveyFlow(
      [
        baseQuestion({ id: 1, order: 0, type: "single", title: "选择", conditionJson, skipToQuestionId }),
        baseQuestion({ id: 2, order: 1, type: "text", title: "B" }),
        baseQuestion({ id: 3, order: 2, type: "text", title: "C" }),
        baseQuestion({ id: 4, order: 3, type: "text", title: "D" }),
      ],
      options,
    );

  it("option rules fire without skipToQuestionId when a rules array is present", () => {
    const flow = buildChoiceFlow(
      JSON.stringify({ kind: "option_equals", rules: [{ optionId: 6, targetQuestionId: 4 }] }),
    );
    expect(getNextQuestionAfterAnswers(flow, 1, 6, new Map())?.id).toBe(4);
    expect(getNextQuestionAfterAnswers(flow, 1, 5, new Map())?.id).toBe(2);
  });

  it("keeps legacy single-option semantics (optionId must match, skipToQuestionId required)", () => {
    const legacy = buildChoiceFlow(JSON.stringify({ kind: "option_equals", optionId: 5 }), 3);
    expect(getNextQuestionAfterAnswers(legacy, 1, 5, new Map())?.id).toBe(3);
    expect(getNextQuestionAfterAnswers(legacy, 1, 6, new Map())?.id).toBe(2);
    const legacyWithoutSkip = buildChoiceFlow(JSON.stringify({ kind: "option_equals", optionId: 5 }));
    expect(getNextQuestionAfterAnswers(legacyWithoutSkip, 1, 5, new Map())?.id).toBe(2);
  });

  it("option rules take precedence over answer rules", () => {
    const conditionJson = JSON.stringify({
      kind: "option_equals",
      rules: [{ optionId: 5, targetQuestionId: 4 }],
      answerRules: [{ questionId: 1, equals: 5, targetQuestionId: 3 }],
    });
    const flow = buildSurveyFlow(
      [
        baseQuestion({ id: 1, order: 0, type: "single", title: "选择", conditionJson }),
        baseQuestion({ id: 2, order: 1, type: "text", title: "B" }),
        baseQuestion({ id: 3, order: 2, type: "text", title: "C" }),
        baseQuestion({ id: 4, order: 3, type: "text", title: "D" }),
      ],
      options,
    );
    expect(getNextQuestionAfterAnswers(flow, 1, 5, new Map([[1, 5]]))?.id).toBe(4);
  });

  it("falls back to linear order on malformed conditions", () => {
    const flow = buildNoteFlow("{not json");
    expect(getNextQuestionAfterAnswers(flow, 2, null, new Map([[1, 5]]))?.id).toBe(3);
  });
});
