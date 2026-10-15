import { describe, expect, it } from "vitest";

import { validateUnifiedSurvey } from "../../../src/survey/validator";

describe("validateUnifiedSurvey", () => {
  const validSurvey = {
    schema_version: 1,
    survey: {
      title: "Test Survey",
      pages: [],
      questions: [
        {
          id: "q1",
          type: "single",
          title: "Question 1",
          required: true,
          order: 1,
          options: [
            { id: "a", label: "A", value: "a", order: 1 },
            { id: "b", label: "B", value: "b", order: 2 },
          ],
          media: [],
        },
      ],
      settings: {
        anonymous: false,
        allow_multiple: false,
        max_responses: 1,
        shuffle_questions: false,
        shuffle_options: false,
        show_progress: true,
        allow_back: true,
        allow_resume: true,
      },
    },
  };

  it("accepts a valid unified survey", () => {
    expect(validateUnifiedSurvey(validSurvey)).toEqual([]);
  });

  it("rejects a missing title", () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        title: "",
      },
    });

    expect(issues.some((issue) => issue.path === "$.survey.title")).toBe(true);
  });

  it("rejects a single choice question without options", () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: "q1",
            type: "single",
            title: "Question 1",
            required: true,
            order: 1,
            options: [],
            media: [],
          },
        ],
      },
    });

    expect(issues.some((issue) => issue.path.includes("options"))).toBe(true);
  });

  it("rejects the generator-domain boolean type", () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: "q1",
            type: "boolean",
            title: "Question 1",
            required: true,
            order: 1,
            options: [],
            media: [],
          },
        ],
      },
    });

    expect(issues.some((issue) => issue.path === "$.survey.questions[0].type")).toBe(true);
  });

  it("accepts a matrix question with one row and two columns", () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: "q1",
            type: "matrix",
            title: "Matrix 1",
            required: true,
            order: 1,
            options: [{ id: "a", label: "Row", value: "a", order: 1 }],
            settings: { columns: ["低", "高"] },
            media: [],
          },
        ],
      },
    });

    expect(issues).toEqual([]);
  });

  it("rejects a matrix question without columns", () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: "q1",
            type: "matrix",
            title: "Matrix 1",
            required: true,
            order: 1,
            options: [{ id: "a", label: "Row", value: "a", order: 1 }],
            settings: { columns: ["低"] },
            media: [],
          },
        ],
      },
    });

    expect(issues.some((issue) => issue.path.includes("settings.columns"))).toBe(true);
  });
});

describe("condition validation", () => {
  const baseQuestion = (id: string, order: number, extra: Record<string, unknown> = {}) => ({
    id,
    type: "single",
    title: `Q${order}`,
    required: true,
    order,
    options: [
      { id: `${id}-a`, label: "A", value: "a", order: 1 },
      { id: `${id}-b`, label: "B", value: "b", order: 2 },
    ],
    media: [],
    ...extra,
  });

  const surveyWith = (questions: unknown[]) => ({
    schema_version: 1,
    survey: { title: "T", pages: [], questions, settings: { anonymous: false } },
  });

  it("accepts forward option rules and answer rules", () => {
    const issues = validateUnifiedSurvey(
      surveyWith([
        baseQuestion("q1", 1, {
          condition: {
            kind: "option_equals",
            rules: [{ optionId: "q1-a", targetQuestionId: "q3" }],
            skipToQuestionId: "q3",
            answerRules: [{ questionId: "q1", equals: 2, targetQuestionId: "q4" }],
          },
        }),
        baseQuestion("q2", 2),
        baseQuestion("q3", 3),
        baseQuestion("q4", 4),
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("rejects backward and unknown jump targets", () => {
    const issues = validateUnifiedSurvey(
      surveyWith([
        baseQuestion("q1", 1, { condition: { kind: "option_equals", rules: [{ optionId: "q1-a", targetQuestionId: "q0" }] } }),
        baseQuestion("q2", 2, { condition: { kind: "option_equals", rules: [{ optionId: "q2-a", targetQuestionId: "q1" }] } }),
        baseQuestion("q3", 3, { condition: { kind: "option_equals", rules: [{ optionId: "nope", targetQuestionId: "q4" }] } }),
      ]),
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      "jump target must reference a question id in this survey",
      "jump targets are forward-only",
      "optionId must reference an option of this question",
      "jump target must reference a question id in this survey",
    ]);
  });

  it("rejects malformed answerRules", () => {
    const issues = validateUnifiedSurvey(
      surveyWith([
        baseQuestion("q1", 1, { condition: { answerRules: [{ questionId: "ghost", equals: 0, targetQuestionId: "q2" }] } }),
        baseQuestion("q2", 2),
      ]),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      "$.survey.questions[0].condition.answerRules[0].questionId",
      "$.survey.questions[0].condition.answerRules[0].equals",
    ]);
  });
});
