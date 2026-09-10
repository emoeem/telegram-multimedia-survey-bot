import { describe, expect, it } from "vitest";
import { formatProfileAnswerText } from "../../../src/services/profile-gallery.service";
import type { Answer, QuestionType } from "../../../src/db/schema";

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: 1,
    responseId: 2,
    questionId: 10,
    textValue: null,
    numberValue: null,
    booleanValue: null,
    ratingValue: null,
    dateValue: null,
    timeValue: null,
    jsonValue: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function question(
  type: QuestionType,
  options: Array<{ id: number; label: string }> = [],
  settingsJson: string | null = null,
) {
  return { type, options, settingsJson };
}

describe("formatProfileAnswerText", () => {
  it("renders text and number answers", () => {
    expect(formatProfileAnswerText(question("text"), answer({ textValue: "  暮色蔷薇  " }))).toBe("暮色蔷薇");
    expect(formatProfileAnswerText(question("number"), answer({ numberValue: 27 }))).toBe("27");
    expect(formatProfileAnswerText(question("long_text"), answer({ textValue: "" }))).toBeNull();
  });

  it("maps single/multiple option ids to labels", () => {
    const options = [
      { id: 1, label: "夜行者" },
      { id: 2, label: "守夜人" },
      { id: 3, label: "探索者" },
    ];
    expect(formatProfileAnswerText(question("single", options), answer({ jsonValue: JSON.stringify([2]) }))).toBe(
      "守夜人",
    );
    expect(formatProfileAnswerText(question("multiple", options), answer({ jsonValue: JSON.stringify([1, 3]) }))).toBe(
      "夜行者、探索者",
    );
  });

  it("renders yes/no, rating and matrix answers", () => {
    expect(formatProfileAnswerText(question("yes_no"), answer({ booleanValue: true }))).toBe("是");
    expect(
      formatProfileAnswerText(
        question("rating", [
          { id: 1, label: "1 分" },
          { id: 5, label: "5 分" },
        ]),
        answer({ jsonValue: JSON.stringify([5]) }),
      ),
    ).toBe("5 分");
    const matrix = question(
      "matrix",
      [
        { id: 11, label: "性格" },
        { id: 12, label: "能力" },
      ],
      JSON.stringify({ columns: ["温和", "可靠"] }),
    );
    expect(
      formatProfileAnswerText(
        matrix,
        answer({ jsonValue: JSON.stringify({ kind: "matrix", selections: { 11: 1, 12: 0 } }) }),
      ),
    ).toBe("性格：可靠；能力：温和");
  });

  it("skips media answers and empty selections", () => {
    expect(
      formatProfileAnswerText(question("image"), answer({ jsonValue: JSON.stringify({ mediaAssetId: 7 }) })),
    ).toBeNull();
    expect(formatProfileAnswerText(question("single", [{ id: 1, label: "A" }]), answer({}))).toBeNull();
  });
});
