import type { SurveyQuestion } from "./schema";

export interface SurveyKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SurveyKeyboard {
  inline_keyboard: SurveyKeyboardButton[][];
}

export function renderQuestionText(
  question: SurveyQuestion,
  index: number,
  total: number,
): string {
  const lines = [`第 ${index + 1} / ${total} 题`, question.title];

  if (question.description) {
    lines.push(question.description);
  }

  if (question.required) {
    lines.push("⚠️ 此题必答");
  } else {
    lines.push("⚪ 非必答");
  }

  if (question.type === "single") {
    lines.push("请选择一个选项");
  } else if (question.type === "multiple") {
    lines.push("可选择多个选项，完成后点击“完成选择”");
  } else if (question.type === "rating") {
    lines.push("请选择一个分数");
  } else {
    lines.push("请直接发送你的回答");
  }

  return lines.join("\n\n");
}

export function renderSingleChoiceKeyboard(
  question: SurveyQuestion,
): SurveyKeyboard {
  const optionRows = question.options.map((option) => [
    {
      text: option.media ? `${option.label} 🖼` : option.label,
      callback_data: `q:single:${question.id}:${option.id}`,
    },
  ]);

  optionRows.push([
    {
      text: "退出问卷",
      callback_data: "q:exit",
    },
  ]);

  return { inline_keyboard: optionRows };
}

export function renderMultipleChoiceKeyboard(
  question: SurveyQuestion,
  selectedOptionIds: string[],
): SurveyKeyboard {
  const selected = new Set(selectedOptionIds);
  const rows = question.options.map((option) => [
    {
      text: `${selected.has(option.id) ? "✅" : "⬜"} ${option.label}${option.media ? " 🖼" : ""}`,
      callback_data: `q:multi:toggle:${question.id}:${option.id}`,
    },
  ]);

  rows.push([
    {
      text: "完成选择",
      callback_data: `q:multi:confirm:${question.id}`,
    },
  ]);
  rows.push([
    {
      text: "退出问卷",
      callback_data: "q:exit",
    },
  ]);

  return { inline_keyboard: rows };
}

export function renderNavigationKeyboard(
  question: SurveyQuestion,
  total: number,
  currentIndex: number,
): SurveyKeyboard {
  const rows: SurveyKeyboardButton[][] = [];

  if (currentIndex > 0) {
    rows.push([
      {
        text: "⬅️ 上一题",
        callback_data: `q:prev:${question.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: currentIndex === total - 1 ? "✅ 提交" : "下一题 ➡️",
      callback_data:
        currentIndex === total - 1 ? "q:submit" : `q:next:${question.id}`,
    },
  ]);
  rows.push([
    {
      text: "退出问卷",
      callback_data: "q:exit",
    },
  ]);

  return { inline_keyboard: rows };
}

export function renderMediaMissingWarning(
  question: SurveyQuestion,
): string {
  if (
    (question.type === "image" ||
      question.type === "video" ||
      question.type === "audio" ||
      question.type === "file") &&
    question.media.length === 0
  ) {
    return "⚠️ 媒体缺失";
  }

  return "";
}
