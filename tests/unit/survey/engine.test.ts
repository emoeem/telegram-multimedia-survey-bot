import { describe, expect, it } from "vitest";

import {
  buildSurveyFlow,
  getFirstQuestion,
  getNextQuestion,
  getPreviousQuestion,
  isLastQuestion,
} from "../../../src/survey/engine";

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
});
