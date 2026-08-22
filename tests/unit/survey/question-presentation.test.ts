import { describe, expect, it } from 'vitest';

import {
  getMatrixColumns,
  getQuestionInstruction,
  isSingleChoiceQuestion,
} from '../../../src/survey/question-presentation';

describe('shared question presentation', () => {
  it('keeps Telegram and Web preview instructions aligned by type', () => {
    expect(isSingleChoiceQuestion({ type: 'yes_no' })).toBe(true);
    expect(getQuestionInstruction({ type: 'rating' })).toBe('请选择一个分数');
    expect(getQuestionInstruction({ type: 'multiple' })).toContain('完成选择');
    expect(getQuestionInstruction({ type: 'matrix' })).toContain('完成矩阵');
    expect(getQuestionInstruction({ type: 'image' })).toContain('媒体文件');
    expect(getQuestionInstruction({ type: 'date' })).toContain('YYYY-MM-DD');
  });

  it('reads valid matrix columns and ignores malformed settings', () => {
    expect(getMatrixColumns({ settingsJson: JSON.stringify({ columns: ['满意', '', 3, '一般'] }) })).toEqual([
      '满意',
      '一般',
    ]);
    expect(getMatrixColumns({ settingsJson: '{bad json' })).toEqual([]);
  });
});
