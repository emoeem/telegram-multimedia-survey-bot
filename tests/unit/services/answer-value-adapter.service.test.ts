import { describe, expect, it } from "vitest";
import { normalizeAnswer } from "../../../src/services/answer-value-adapter.service";
import type { Answer } from "../../../src/db/schema";

function answer(values: Partial<Answer>): Answer {
  return { id: 1, responseId: 1, questionId: 7, textValue: null, numberValue: null, booleanValue: null, ratingValue: null, dateValue: null, timeValue: null, jsonValue: null, createdAt: "", updatedAt: "", ...values };
}

describe("AnswerValueAdapter", () => {
  it("normalizes scalar, list and media answers without leaking persistence fields", () => {
    expect(normalizeAnswer(answer({ ratingValue: 8 }), "rating").value).toBe(8);
    expect(normalizeAnswer(answer({ jsonValue: "[1,3]" }), "multiple").value).toEqual([1, 3]);
    expect(normalizeAnswer(answer({ jsonValue: '{"mediaAssetId":42}' }), "image")).toMatchObject({
      type: "image", value: { mediaAssetId: 42 }, media: [{ mediaAssetId: 42 }],
    });
  });

  it("does not let an unset booleanValue shadow json or text answers", () => {
    expect(normalizeAnswer(answer({ booleanValue: null, jsonValue: "[7]" }), "single").value).toEqual([7]);
    expect(normalizeAnswer(answer({ booleanValue: null, jsonValue: '{"mediaAssetId":9}' }), "image").media).toEqual([{ mediaAssetId: 9 }]);
    expect(normalizeAnswer(answer({ booleanValue: null, textValue: "回答" }), "text").value).toBe("回答");
    expect(normalizeAnswer(answer({ booleanValue: true }), "yes_no").value).toBe(true);
  });
});
