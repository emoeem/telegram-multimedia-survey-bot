import { describe, expect, it } from 'vitest';

import { buildEditorPreviewFlow } from '../../../admin/src/editor/previewModel';

describe('editor preview model', () => {
  it('builds the shared SurveyQuestionView shape from local editor state', () => {
    const questions = buildEditorPreviewFlow(5, [
      {
        id: -1,
        type: 'matrix',
        title: '满意度',
        description: '请选择',
        required: true,
        order: 0,
        columns: ['满意', '不满意'],
        validation: null,
        condition: null,
        media: [{ mediaAssetId: 7, mediaType: 'photo' }],
        options: [{ id: -2, label: '服务', order: 0, media: [] }],
      },
    ]);

    expect(questions[0]).toMatchObject({ id: -1, surveyId: 5, title: '满意度' });
    expect(questions[0]?.options).toMatchObject([{ id: -2, questionId: -1, label: '服务' }]);
    expect(questions[0]?.settingsJson).toBe(JSON.stringify({ columns: ['满意', '不满意'] }));
    expect(questions[0]?.media).toHaveLength(1);
  });
});
