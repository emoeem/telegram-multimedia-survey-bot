import { describe, expect, it } from 'vitest';

import { validateUnifiedSurvey } from '../../../src/survey/validator';

describe('validateUnifiedSurvey', () => {
  const validSurvey = {
    schema_version: 1,
    survey: {
      title: 'Test Survey',
      pages: [],
      questions: [
        {
          id: 'q1',
          type: 'single',
          title: 'Question 1',
          required: true,
          order: 1,
          options: [
            { id: 'a', label: 'A', value: 'a', order: 1 },
            { id: 'b', label: 'B', value: 'b', order: 2 },
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

  it('accepts a valid unified survey', () => {
    expect(validateUnifiedSurvey(validSurvey)).toEqual([]);
  });

  it('rejects a missing title', () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        title: '',
      },
    });

    expect(issues.some((issue) => issue.path === '$.survey.title')).toBe(true);
  });

  it('rejects a single choice question without options', () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: 'q1',
            type: 'single',
            title: 'Question 1',
            required: true,
            order: 1,
            options: [],
            media: [],
          },
        ],
      },
    });

    expect(issues.some((issue) => issue.path.includes('options'))).toBe(true);
  });

  it('rejects the generator-domain boolean type', () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: 'q1',
            type: 'boolean',
            title: 'Question 1',
            required: true,
            order: 1,
            options: [],
            media: [],
          },
        ],
      },
    });

    expect(issues.some((issue) => issue.path === '$.survey.questions[0].type')).toBe(true);
  });

  it('accepts a matrix question with one row and two columns', () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: 'q1',
            type: 'matrix',
            title: 'Matrix 1',
            required: true,
            order: 1,
            options: [{ id: 'a', label: 'Row', value: 'a', order: 1 }],
            settings: { columns: ['低', '高'] },
            media: [],
          },
        ],
      },
    });

    expect(issues).toEqual([]);
  });

  it('rejects a matrix question without columns', () => {
    const issues = validateUnifiedSurvey({
      ...validSurvey,
      survey: {
        ...validSurvey.survey,
        questions: [
          {
            id: 'q1',
            type: 'matrix',
            title: 'Matrix 1',
            required: true,
            order: 1,
            options: [{ id: 'a', label: 'Row', value: 'a', order: 1 }],
            settings: { columns: ['低'] },
            media: [],
          },
        ],
      },
    });

    expect(issues.some((issue) => issue.path.includes('settings.columns'))).toBe(true);
  });
});
