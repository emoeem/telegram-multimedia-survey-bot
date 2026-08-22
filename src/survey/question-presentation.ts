import type { SurveyQuestionView } from './engine';

type PresentableQuestion = Pick<SurveyQuestionView, 'type' | 'settingsJson'>;

export function isSingleChoiceQuestion(question: Pick<PresentableQuestion, 'type'>): boolean {
  return question.type === 'single' || question.type === 'yes_no' || question.type === 'rating';
}

export function getMatrixColumns(question: Pick<PresentableQuestion, 'settingsJson'>): string[] {
  try {
    const parsed = question.settingsJson ? (JSON.parse(question.settingsJson) as { columns?: unknown }) : null;
    return Array.isArray(parsed?.columns)
      ? parsed.columns.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export function getQuestionInstruction(question: Pick<PresentableQuestion, 'type'>): string {
  if (isSingleChoiceQuestion(question)) {
    return question.type === 'rating' ? '请选择一个分数' : '请选择一个选项';
  }
  if (question.type === 'multiple') return '可选择多个选项，完成后点击“完成选择”';
  if (question.type === 'matrix') return '请为每一行选择一个选项，完成后点击“完成矩阵”';
  if (question.type === 'image' || question.type === 'video' || question.type === 'audio' || question.type === 'file') {
    return '请直接发送对应的媒体文件';
  }
  if (question.type === 'number') return '请输入一个数字';
  if (question.type === 'date') return '请输入日期，格式：YYYY-MM-DD';
  if (question.type === 'time') return '请输入时间，格式：HH:MM';
  return '请直接发送你的回答';
}
