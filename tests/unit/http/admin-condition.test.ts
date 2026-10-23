import { describe, expect, it } from "vitest";

import { normalizeQuestionCondition } from "../../../src/http/admin/helpers";

describe("normalizeQuestionCondition", () => {
  it("derives skipToQuestionId from the first option rule", () => {
    const result = normalizeQuestionCondition({
      kind: "option_equals",
      rules: [
        { optionId: 11, targetQuestionId: 21 },
        { optionId: 12, targetQuestionId: 22 },
      ],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(JSON.parse(result.conditionJson ?? "{}")).toEqual({
        kind: "option_equals",
        rules: [
          { optionId: 11, targetQuestionId: 21 },
          { optionId: 12, targetQuestionId: 22 },
        ],
      });
      expect(result.skipToQuestionId).toBe(21);
    }
  });

  it("keeps answerRules through a save and allows them without option rules", () => {
    const condition = {
      kind: "option_equals",
      answerRules: [{ questionId: 5, equals: 2, targetQuestionId: 9 }],
    };
    const result = normalizeQuestionCondition(condition);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(JSON.parse(result.conditionJson ?? "{}")).toEqual(condition);
      expect(result.skipToQuestionId).toBeNull();
    }
  });

  it("keeps answerRules when option rules are removed", () => {
    const result = normalizeQuestionCondition({
      kind: "option_equals",
      rules: [],
      answerRules: [{ questionId: 5, equals: 2, targetQuestionId: 9 }],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(JSON.parse(result.conditionJson ?? "{}")).toEqual({
        kind: "option_equals",
        answerRules: [{ questionId: 5, equals: 2, targetQuestionId: 9 }],
      });
    }
  });

  it("clears the condition when nothing remains", () => {
    const result = normalizeQuestionCondition({ kind: "option_equals", rules: [] });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.conditionJson).toBeNull();
      expect(result.skipToQuestionId).toBeNull();
    }
  });

  it("still accepts the legacy single-option shape", () => {
    const result = normalizeQuestionCondition({ optionId: 3, targetQuestionId: 7 });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(JSON.parse(result.conditionJson ?? "{}")).toEqual({
        kind: "option_equals",
        rules: [{ optionId: 3, targetQuestionId: 7 }],
      });
      expect(result.skipToQuestionId).toBe(7);
    }
  });

  it("rejects malformed input", () => {
    expect(normalizeQuestionCondition("nope")).toEqual({ error: "condition 必须是对象或 null" });
    expect(normalizeQuestionCondition({ rules: [{ optionId: -1, targetQuestionId: 2 }] })).toEqual({
      error: "rules 中的 optionId / targetQuestionId 必须是正整数",
    });
    expect(normalizeQuestionCondition({ answerRules: "nope" })).toEqual({ error: "answerRules 必须是对象数组" });
    expect(normalizeQuestionCondition({ answerRules: [{ questionId: 1, equals: 0, targetQuestionId: 2 }] })).toEqual({
      error: "answerRules 中的 questionId / equals / targetQuestionId 必须是正整数",
    });
  });
});
