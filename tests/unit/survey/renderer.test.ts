import { describe, expect, it } from "vitest";

import {
  renderMediaMissingWarning,
  renderMultipleChoiceKeyboard,
  renderQuestionText,
  renderSingleChoiceKeyboard,
} from "../../../src/survey/renderer";

const question = {
  id: "q1",
  type: "single" as const,
  title: "你的选择？",
  required: true,
  order: 1,
  options: [
    { id: "a", label: "A", value: "a", order: 1 },
    { id: "b", label: "B", value: "b", order: 2 },
  ],
  media: [],
};

describe("survey renderer", () => {
  it("renders question text with required marker", () => {
    const text = renderQuestionText(question, 0, 2);

    expect(text).toContain("第 1 / 2 题");
    expect(text).toContain("你的选择？");
    expect(text).toContain("⚠️ 此题必答");
  });

  it("renders single choice keyboard with exit button", () => {
    const keyboard = renderSingleChoiceKeyboard(question);

    expect(keyboard.inline_keyboard.flat().map((button) => button.text))
      .toEqual(["A", "B", "退出问卷"]);
  });

  it("renders multiple choice keyboard with selected markers", () => {
    const keyboard = renderMultipleChoiceKeyboard(question, ["a"]);
    const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

    expect(labels[0]).toBe("✅ A");
    expect(labels[1]).toBe("⬜ B");
  });

  it("shows media missing warning for media questions", () => {
    expect(
      renderMediaMissingWarning({
        ...question,
        type: "image",
        media: [],
      }),
    ).toBe("⚠️ 媒体缺失");
  });

  it("shows media marker for options with media", () => {
    const keyboard = renderSingleChoiceKeyboard({
      ...question,
      options: [
        {
          id: "a",
          label: "A",
          value: "a",
          order: 1,
          media: {
            id: "m1",
            type: "photo",
            source: "telegram",
          },
        },
      ],
    });

    expect(keyboard.inline_keyboard[0]?.[0]?.text).toBe("A 🖼");
  });
});
