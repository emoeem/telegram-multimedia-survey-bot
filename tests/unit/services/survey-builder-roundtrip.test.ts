import { beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreLatestBuilderDraft, saveDraftSurvey } from '../../../src/services/survey-builder.service';
import type { SurveyBuilderState } from '../../../src/durable-objects/survey-builder';

// R1 regression: the bot wizard used to re-save drafts by deleting and
// re-inserting questions, silently dropping condition_json skip rules.
// Restore must read them back into the builder state and save must write
// them into the INSERT again.
function makeDb() {
  const sqlLog: string[] = [];
  const firstRules: Array<[string, () => unknown]> = [];
  const allRules: Array<[string, () => unknown[]]> = [];
  let nextRowId = 501;
  const makeStatement = (sql: string) => {
    const statement = {
      bind: () => statement,
      first: async () => {
        for (const [pattern, value] of firstRules) if (sql.includes(pattern)) return value();
        return null;
      },
      all: async () => {
        for (const [pattern, value] of allRules) if (sql.includes(pattern)) return { results: value() };
        return { results: [] };
      },
      run: async () => ({ meta: { last_row_id: nextRowId++, changes: 1 } }),
    };
    return statement;
  };
  const db = {
    prepare: vi.fn((sql: string) => {
      sqlLog.push(sql);
      return makeStatement(sql);
    }),
    batch: vi.fn(async (batch: unknown[]) => batch.map(() => ({ results: [] }))),
  };
  return {
    db: db as unknown as D1Database,
    sqlLog,
    firstOn: (pattern: string, value: unknown) => {
      firstRules.push([pattern, () => value]);
    },
    allOn: (pattern: string, rows: unknown[]) => {
      allRules.push([pattern, () => rows]);
    },
  };
}

function builderState(overrides: Partial<SurveyBuilderState> = {}): SurveyBuilderState {
  return {
    userId: 222,
    step: 'ready',
    activeDraft: true,
    surveyTitle: '带跳题的草稿',
    surveyDescription: '',
    currentQuestionType: null,
    currentQuestionTitle: '',
    currentQuestionRequired: true,
    currentOptions: [],
    currentMatrixColumns: [],
    currentMediaAssetId: null,
    targetOptionId: null,
    targetQuestionId: null,
    targetSurveyId: null,
    appendSurveyId: null,
    draftSurveyId: 5,
    suspendedStep: null,
    questions: [
      {
        type: 'single',
        title: '第一题',
        required: true,
        options: [
          { label: '甲', mediaAssetId: null },
          { label: '乙', mediaAssetId: null },
        ],
        matrixColumns: [],
        mediaAssetId: null,
        conditionJson: '{"kind":"option_equals","rules":[{"optionId":21,"targetQuestionId":12}]}',
        skipToQuestionId: 12,
      },
    ],
    updatedAt: '2026-08-22 00:00:00',
    ...overrides,
  } as SurveyBuilderState;
}

function makeNamespace() {
  const calls: unknown[] = [];
  const namespace = {
    idFromName: () => 'builder-id',
    get: () => ({
      fetch: async (_url: unknown, init: { body: string }) => {
        calls.push(JSON.parse(init.body));
        return Response.json(builderState());
      },
    }),
  };
  return { namespace: namespace as never, calls };
}

describe('survey builder draft round-trip keeps skip rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('save writes condition_json and skip_to_question_id back into the INSERT', async () => {
    const harness = makeDb();
    harness.firstOn('FROM surveys WHERE id', {
      id: 5,
      owner_id: 7,
      title: '带跳题的草稿',
      description: null,
      status: 'draft',
    });
    await saveDraftSurvey(harness.db, builderState(), 7);
    const insert = harness.sqlLog.find((sql) => sql.includes('INSERT INTO survey_questions'));
    expect(insert).toBeDefined();
    expect(insert).toContain('condition_json');
    expect(insert).toContain('skip_to_question_id');
  });

  it('restore reads the stored rules back into the builder state', async () => {
    const harness = makeDb();
    harness.firstOn("WHERE owner_id = ? AND status = 'draft'", { id: 5 });
    harness.allOn('FROM survey_questions WHERE survey_id', [
      {
        id: 11,
        survey_id: 5,
        type: 'single',
        title: '第一题',
        description: null,
        required: 1,
        order: 0,
        validation_json: null,
        settings_json: null,
        parent_question_id: null,
        condition_json: '{"kind":"option_equals","rules":[{"optionId":21,"targetQuestionId":12}]}',
        skip_to_question_id: 12,
        created_at: '2026-08-22 00:00:00',
        updated_at: '2026-08-22 00:00:00',
      },
    ]);
    harness.allOn('FROM question_options', [
      { id: 21, question_id: 11, label: '甲', value: '甲', order: 0, is_other: 0 },
      { id: 22, question_id: 11, label: '乙', value: '乙', order: 1, is_other: 0 },
    ]);
    const { namespace, calls } = makeNamespace();
    const state = await restoreLatestBuilderDraft(harness.db, namespace, 222, 7);
    expect(state).not.toBeNull();
    expect(state!.questions[0]).toMatchObject({
      type: 'single',
      conditionJson: '{"kind":"option_equals","rules":[{"optionId":21,"targetQuestionId":12}]}',
      skipToQuestionId: 12,
    });
    // The DO restore action carries the rules through the namespace call.
    const restoreCall = calls.find((body) => (body as { action?: string }).action === 'restore') as {
      questions: { conditionJson?: string | null }[];
    };
    expect(restoreCall.questions[0]?.conditionJson).toContain('option_equals');
  });
});
