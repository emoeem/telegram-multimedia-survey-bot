import type { QuestionType } from '../db/schema';

// Single source of truth for survey question-type rules shared by the JSON
// import validator, the publish check, and the bot builder wizard. The DB layer
// (src/db/schema.ts QuestionType) is authoritative; the domain union in
// src/survey/schema.ts additionally carries "boolean", which only exists in the
// image-generator / report-import domain and must never enter a survey.
export const SURVEY_QUESTION_TYPES: readonly QuestionType[] = [
  'single',
  'multiple',
  'text',
  'long_text',
  'number',
  'yes_no',
  'rating',
  'matrix',
  'date',
  'time',
  'image',
  'video',
  'audio',
  'file',
];

export const CHOICE_OPTION_MIN = 2;
export const MATRIX_ROW_MIN = 1;
export const MATRIX_COLUMN_MIN = 2;

export function isSurveyQuestionType(value: unknown): value is QuestionType {
  return typeof value === 'string' && (SURVEY_QUESTION_TYPES as readonly string[]).includes(value);
}

export function isChoiceQuestionType(type: QuestionType): boolean {
  return type === 'single' || type === 'multiple' || type === 'yes_no' || type === 'rating';
}

export function isMatrixQuestionType(type: QuestionType): boolean {
  return type === 'matrix';
}

// Minimum option ("row") count a question needs before it can be published /
// imported. Returns null for types without options.
export function minOptionCount(type: QuestionType): number | null {
  if (isChoiceQuestionType(type)) return CHOICE_OPTION_MIN;
  if (isMatrixQuestionType(type)) return MATRIX_ROW_MIN;
  return null;
}

export function parseMatrixColumns(settingsJson: string | null): string[] {
  if (!settingsJson) return [];
  try {
    const parsed = JSON.parse(settingsJson) as { columns?: unknown };
    return Array.isArray(parsed.columns) ? parsed.columns.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}
