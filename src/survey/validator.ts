import { SURVEY_SCHEMA_VERSION, type UnifiedSurveyImport } from './schema';
import { MATRIX_COLUMN_MIN, SURVEY_QUESTION_TYPES, isSurveyQuestionType, minOptionCount } from './question-rules';

export interface ValidationIssue {
  path: string;
  message: string;
}

const QUESTION_TYPES = SURVEY_QUESTION_TYPES as readonly string[];

export function validateUnifiedSurvey(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (typeof input !== 'object' || input === null) {
    return [{ path: '$', message: 'Survey must be an object' }];
  }

  const data = input as Partial<UnifiedSurveyImport>;

  if (data.schema_version !== SURVEY_SCHEMA_VERSION) {
    issues.push({
      path: '$.schema_version',
      message: `schema_version must be ${SURVEY_SCHEMA_VERSION}`,
    });
  }

  if (!data.survey || typeof data.survey !== 'object') {
    issues.push({ path: '$.survey', message: 'survey is required' });
    return issues;
  }

  if (!data.survey.title?.trim()) {
    issues.push({ path: '$.survey.title', message: 'title is required' });
  }

  if (!Array.isArray(data.survey.questions) || data.survey.questions.length === 0) {
    issues.push({
      path: '$.survey.questions',
      message: 'questions must be a non-empty array',
    });
    return issues;
  }

  data.survey.questions.forEach((question, index) => {
    const path = `$.survey.questions[${index}]`;

    if (!question || typeof question !== 'object') {
      issues.push({ path, message: 'question must be an object' });
      return;
    }

    if (!question.id) {
      issues.push({ path: `${path}.id`, message: 'id is required' });
    }

    if (!isSurveyQuestionType(question.type)) {
      issues.push({
        path: `${path}.type`,
        message: `type must be one of: ${QUESTION_TYPES.join(', ')}`,
      });
    }

    if (!question.title?.trim()) {
      issues.push({ path: `${path}.title`, message: 'title is required' });
    }

    if (typeof question.required !== 'boolean' && question.required !== null) {
      issues.push({
        path: `${path}.required`,
        message: 'required must be a boolean or null',
      });
    }

    if (!Array.isArray(question.options)) {
      issues.push({
        path: `${path}.options`,
        message: 'options must be an array',
      });
    } else if (isSurveyQuestionType(question.type)) {
      const minOptions = minOptionCount(question.type);
      if (minOptions !== null && question.options.length < minOptions) {
        issues.push({
          path: `${path}.options`,
          message:
            question.type === 'matrix'
              ? `matrix questions require at least ${minOptions} row option(s)`
              : 'this question type requires at least two options',
        });
      }
      if (question.type === 'matrix') {
        const columns = Array.isArray(question.settings?.columns)
          ? (question.settings?.columns as unknown[]).filter((column): column is string => typeof column === 'string')
          : [];
        if (columns.length < MATRIX_COLUMN_MIN) {
          issues.push({
            path: `${path}.settings.columns`,
            message: `matrix questions require at least ${MATRIX_COLUMN_MIN} columns`,
          });
        }
      }
    }
  });

  return issues;
}
