import { describe, expect, it } from "vitest";

import {
  buildMatrixColumnKeyboard,
  buildMatrixKeyboard,
  buildMultipleChoiceKeyboard,
  buildSingleChoiceKeyboard,
  cleanSurveyDescription,
  formatChoiceOptionText,
  formatQuestionText,
  usesNumberedChoiceList,
} from "../../../src/bot/survey-handler";
import type { SurveyQuestionView } from "../../../src/survey/engine";

function questionWithOptions(labels: string[]): SurveyQuestionView {
  return {
    id: 10,
    surveyId: 20,
    type: "single",
    title: "请选择最符合的一项",
    description: null,
    required: true,
    order: 1,
    validationJson: null,
    settingsJson: null,
    parentQuestionId: null,
    conditionJson: null,
    skipToQuestionId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    options: labels.map((label, index) => ({
      id: 100 + index,
      questionId: 10,
      label,
      value: String(index + 1),
      order: index + 1,
      isOther: false,
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    })),
  };
}

describe("survey question presentation", () => {
  it("hides the generated PDF import description from survey listings", () => {
    expect(cleanSurveyDescription("Imported from Microsoft Forms PDF")).toBeNull();
    expect(cleanSurveyDescription(" Imported from Microsoft Forms PDF. ")).toBeNull();
    expect(cleanSurveyDescription("这是一份自定义问卷说明")).toBe("这是一份自定义问卷说明");
  });

  it("shows long imported options in the message and uses numbered buttons", () => {
    const question = questionWithOptions([
      "这是一个很长的选项内容，需要完整显示而不能只依赖按钮宽度",
      "另一个同样需要参与者完整阅读后才能选择的选项内容",
    ]);

    expect(usesNumberedChoiceList(question)).toBe(true);
    expect(formatQuestionText(question, 0, 4)).not.toContain(
      "这是一个很长的选项内容，需要完整显示而不能只依赖按钮宽度",
    );
    expect(formatChoiceOptionText(1, question.options[0]!.label)).toBe(
      "【选项 1】\n\n这是一个很长的选项内容，需要完整显示而不能只依赖按钮宽度",
    );
    expect(
      buildSingleChoiceKeyboard(question, 0).inline_keyboard
        .slice(0, 2)
        .flat()
        .map((button) => button.text),
    ).toEqual(["选择 1", "选择 2"]);
  });

  it("keeps short labels on buttons and numbers long multiple-choice labels", () => {
    const shortQuestion = questionWithOptions(["是", "否"]);
    expect(
      buildSingleChoiceKeyboard(shortQuestion, 0).inline_keyboard[0]?.[0]?.text,
    ).toBe("是");

    const multipleQuestion = {
      ...questionWithOptions([
        "第一项内容非常长，需要在正文区域完整显示给填写者阅读",
        "第二项内容也非常长，需要在正文区域完整显示给填写者阅读",
      ]),
      type: "multiple" as const,
    };
    const labels = buildMultipleChoiceKeyboard(
      multipleQuestion,
      [multipleQuestion.options[0]!.id],
      0,
    ).inline_keyboard
      .slice(0, 2)
      .flat()
      .map((button) => button.text);

    expect(labels).toEqual(["✅ 选择 1", "⬜ 选择 2"]);
  });

  it("lets mobile users choose a matrix row before showing its columns", () => {
    const question = {
      ...questionWithOptions(["服务态度", "响应速度"]),
      type: "matrix" as const,
      settingsJson: JSON.stringify({ columns: ["满意", "一般", "不满意"] }),
    };
    const matrixButtons = buildMatrixKeyboard(question, { "100": 1 }, 0)
      .inline_keyboard
      .flat();

    expect(matrixButtons.some((button) => button.callback_data === "q:matrix:row:10:100")).toBe(true);
    expect(matrixButtons.some((button) => button.callback_data?.startsWith("q:matrix:select:"))).toBe(false);
    expect(matrixButtons.find((button) => button.callback_data === "q:matrix:row:10:100")?.text).toContain("一般");

    const columnButtons = buildMatrixColumnKeyboard(question, 100, 0, 1)
      .inline_keyboard
      .flat();
    expect(columnButtons.map((button) => button.text)).toContain("✅ 一般");
    expect(columnButtons.some((button) => button.callback_data === "q:matrix:back:10")).toBe(true);
  });
});
