import { describe, expect, it } from 'vitest';

import { isCompleteQuestionOrder, reorderByQuestionIds } from '../../../admin/src/editor/questionOrder';

describe('question ordering', () => {
  it('accepts only a complete unique permutation', () => {
    expect(isCompleteQuestionOrder([11, 12, 13], [13, 11, 12])).toBe(true);
    expect(isCompleteQuestionOrder([11, 12, 13], [11, 12])).toBe(false);
    expect(isCompleteQuestionOrder([11, 12, 13], [11, 11, 13])).toBe(false);
    expect(isCompleteQuestionOrder([11, 12, 13], [11, 12, 99])).toBe(false);
  });

  it('reorders entities and normalizes order to 0..n-1', () => {
    const questions = [
      { id: 11, order: 4, title: 'A' },
      { id: 12, order: 8, title: 'B' },
      { id: -1, order: 9, title: '未保存' },
    ];

    expect(reorderByQuestionIds(questions, [-1, 12, 11])).toEqual([
      { id: -1, order: 0, title: '未保存' },
      { id: 12, order: 1, title: 'B' },
      { id: 11, order: 2, title: 'A' },
    ]);
  });
});
