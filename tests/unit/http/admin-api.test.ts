import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const repositoryMocks = vi.hoisted(() => ({
  getUserByTelegramId: vi.fn(),
}));

vi.mock('../../../src/db/repositories/user.repository', () => repositoryMocks);

import { handleAdminApi, verifyTelegramWebAppUser } from '../../../src/http/admin-api';
import type { Env } from '../../../src/index';

const BOT_TOKEN = 'test-bot-token';

function signInitData(botToken: string, user: Record<string, unknown>, authDateSeconds: number): string {
  const params = new URLSearchParams({
    auth_date: String(authDateSeconds),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return `${params.toString()}&hash=${hash}`;
}

function requestWithInitData(initData: string): Request {
  return new Request('https://example.test/api/admin/dashboard', {
    headers: { 'x-telegram-init-data': encodeURIComponent(initData) },
  });
}

function apiRequest(path: string, options: { method?: string; userId?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.userId !== undefined) headers['x-telegram-user-id'] = options.userId;
  return new Request(`https://example.test${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function makeDb() {
  const sqlLog: string[] = [];
  const firstRules: Array<[string, () => unknown]> = [];
  const allRules: Array<[string, () => unknown[]]> = [];
  let defaultFirst: unknown = null;
  let nextRowId = 101;
  const makeStatement = (sql: string) => {
    const statement = {
      bind: () => statement,
      first: async () => {
        for (const [pattern, value] of firstRules) if (sql.includes(pattern)) return value();
        return defaultFirst;
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
    setFirst: (value: unknown) => {
      defaultFirst = value;
    },
    firstOn: (pattern: string, value: unknown) => {
      firstRules.push([pattern, () => value]);
    },
    allOn: (pattern: string, rows: unknown[]) => {
      allRules.push([pattern, () => rows]);
    },
  };
}

function surveyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5,
    owner_id: 7,
    title: '草稿问卷',
    description: null,
    cover_media_id: null,
    status: 'draft',
    anonymous: 0,
    allow_multiple_responses: 0,
    max_responses_per_user: 1,
    version: 1,
    created_at: '2026-08-22 00:00:00',
    updated_at: '2026-08-22 00:00:00',
    published_at: null,
    closed_at: null,
    archived_at: null,
    access_code: null,
    access_code_encrypted: null,
    ...overrides,
  };
}

function questionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    survey_id: 5,
    type: 'single',
    title: '题目一',
    description: null,
    required: 1,
    order: 0,
    validation_json: null,
    settings_json: null,
    parent_question_id: null,
    condition_json: null,
    skip_to_question_id: null,
    created_at: '2026-08-22 00:00:00',
    updated_at: '2026-08-22 00:00:00',
    ...overrides,
  };
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    BOT_TOKEN,
    ADMIN_IDS: '111',
    ENVIRONMENT: 'development',
    ...overrides,
  } as unknown as Env;
}

const OWNER = { id: 7, telegramUserId: 222, systemRole: 'participant' };
const ADMIN = { id: 1, telegramUserId: 111, systemRole: 'admin' };

describe('verifyTelegramWebAppUser', () => {
  it('verifies a freshly signed initData and returns the Telegram user id', async () => {
    const initData = signInitData(
      BOT_TOKEN,
      { id: 4242, first_name: '问卷管理员' },
      Math.floor(Date.now() / 1000) - 60,
    );
    await expect(verifyTelegramWebAppUser(requestWithInitData(initData), BOT_TOKEN)).resolves.toBe(4242);
  });

  it('rejects a tampered hash', async () => {
    const initData = signInitData(BOT_TOKEN, { id: 4242 }, Math.floor(Date.now() / 1000) - 60);
    const tampered = initData.slice(0, -4) + '0000';
    await expect(verifyTelegramWebAppUser(requestWithInitData(tampered), BOT_TOKEN)).resolves.toBeNaN();
  });

  it('rejects initData signed with another bot token', async () => {
    const initData = signInitData('other-bot-token', { id: 4242 }, Math.floor(Date.now() / 1000) - 60);
    await expect(verifyTelegramWebAppUser(requestWithInitData(initData), BOT_TOKEN)).resolves.toBeNaN();
  });

  it('rejects stale initData older than 24 hours', async () => {
    const initData = signInitData(BOT_TOKEN, { id: 4242 }, Math.floor(Date.now() / 1000) - 25 * 60 * 60);
    await expect(verifyTelegramWebAppUser(requestWithInitData(initData), BOT_TOKEN)).resolves.toBeNaN();
  });

  it('returns NaN when the header is missing', async () => {
    await expect(verifyTelegramWebAppUser(apiRequest('/api/admin/dashboard'), BOT_TOKEN)).resolves.toBeNaN();
  });
});

describe('handleAdminApi authentication and permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests without any identity with 401', async () => {
    const { db } = makeDb();
    const response = await handleAdminApi(apiRequest('/api/admin/surveys'), makeEnv(db));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('rejects identities that do not exist in the users table with 401', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(null);
    const { db } = makeDb();
    const response = await handleAdminApi(apiRequest('/api/admin/surveys', { userId: '999' }), makeEnv(db));
    expect(response.status).toBe(401);
  });

  it('ignores the dev identity header in production', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const { db } = makeDb();
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys', { userId: '111' }),
      makeEnv(db, { ENVIRONMENT: 'production' }),
    );
    expect(response.status).toBe(401);
    expect(repositoryMocks.getUserByTelegramId).not.toHaveBeenCalled();
  });

  it('lets non-admin owners in and scopes the survey list to their own rows', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const { db, sqlLog } = makeDb();
    const response = await handleAdminApi(apiRequest('/api/admin/surveys', { userId: '222' }), makeEnv(db));
    expect(response.status).toBe(200);
    expect(sqlLog[0]).toContain('s.owner_id = ?');
    const body = await response.json();
    expect(body).toMatchObject({ items: [], page: 1 });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('gives admins the unfiltered survey list', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const { db, sqlLog } = makeDb();
    const response = await handleAdminApi(apiRequest('/api/admin/surveys', { userId: '111' }), makeEnv(db));
    expect(response.status).toBe(200);
    expect(sqlLog[0]).toContain('1=1');
    expect(sqlLog[0]).not.toContain('s.owner_id = ?');
  });

  it('blocks non-owners from a survey detail with 403', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const { db, setFirst } = makeDb();
    setFirst({ id: 5, owner_id: 99, title: '他人问卷' });
    const response = await handleAdminApi(apiRequest('/api/admin/surveys/5', { userId: '222' }), makeEnv(db));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'forbidden' });
  });

  it('returns survey detail to its owner', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const { db, setFirst } = makeDb();
    setFirst({ id: 5, owner_id: 7, title: '我的问卷' });
    const response = await handleAdminApi(apiRequest('/api/admin/surveys/5', { userId: '222' }), makeEnv(db));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 5, owner_id: 7 });
  });

  it('returns 404 when the survey does not exist', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const { db } = makeDb();
    const response = await handleAdminApi(apiRequest('/api/admin/surveys/404', { userId: '111' }), makeEnv(db));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
  });

  it('rejects methods outside GET/POST/PATCH/DELETE with 405', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const { db } = makeDb();
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys', { method: 'PUT', userId: '111' }),
      makeEnv(db),
    );
    expect(response.status).toBe(405);
  });

  it('returns the read-only editor assembly with an editable flag for a draft', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const { db, setFirst } = makeDb();
    setFirst({
      id: 5,
      owner_id: 7,
      title: '草稿问卷',
      description: null,
      cover_media_id: null,
      status: 'draft',
      anonymous: 0,
      allow_multiple_responses: 0,
      max_responses_per_user: 1,
      version: 1,
      created_at: '2026-08-22 00:00:00',
      updated_at: '2026-08-22 00:00:00',
      published_at: null,
      closed_at: null,
      archived_at: null,
      access_code: null,
      access_code_encrypted: null,
    });
    const response = await handleAdminApi(apiRequest('/api/admin/surveys/5/editor', { userId: '222' }), makeEnv(db));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { survey: Record<string, unknown>; questions: unknown[] };
    expect(body.survey).toMatchObject({ id: 5, ownerId: 7, status: 'draft', editable: true });
    expect(body.questions).toEqual([]);
  });

  it('blocks the editor assembly for non-owners with 403', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const { db, setFirst } = makeDb();
    setFirst({ id: 5, owner_id: 99 });
    const response = await handleAdminApi(apiRequest('/api/admin/surveys/5/editor', { userId: '222' }), makeEnv(db));
    expect(response.status).toBe(403);
  });

  it('returns 404 from the editor assembly for a missing survey', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const { db } = makeDb();
    const response = await handleAdminApi(apiRequest('/api/admin/surveys/404/editor', { userId: '111' }), makeEnv(db));
    expect(response.status).toBe(404);
  });
});

describe('handleAdminApi write endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 可写草稿的默认桩：admin 身份 + draft + 0 答卷
  function writableDraftDb(overrides: { survey?: Record<string, unknown>; responses?: number } = {}) {
    const harness = makeDb();
    harness.firstOn('FROM surveys WHERE id', surveyRow({ owner_id: 1, ...(overrides.survey ?? {}) }));
    harness.firstOn('FROM survey_responses WHERE survey_id', { count: overrides.responses ?? 0 });
    return harness;
  }

  it('creates a draft survey with initial questions (admin)', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = makeDb();
    harness.firstOn('FROM surveys WHERE id', surveyRow());
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys', {
        method: 'POST',
        userId: '111',
        body: {
          title: '新建问卷',
          questions: [{ type: 'single', title: '单选', required: true, options: [{ label: 'A' }, { label: 'B' }] }],
        },
      }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: number; updatedAt: string };
    expect(body.id).toBeGreaterThan(0);
    expect(typeof body.updatedAt).toBe('string');
    expect(harness.sqlLog.some((sql) => sql.includes('INSERT INTO surveys'))).toBe(true);
    expect(harness.sqlLog.some((sql) => sql.includes('INSERT INTO survey_questions'))).toBe(true);
    expect(harness.sqlLog.some((sql) => sql.includes('INSERT INTO question_options'))).toBe(true);
  });

  it('blocks survey creation for owners without a creator trial', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const { db } = makeDb();
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys', { method: 'POST', userId: '222', body: { title: 'X' } }),
      makeEnv(db),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'creator_trial_required' });
  });

  it('allows survey creation for owners with an active trial', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const harness = makeDb();
    harness.firstOn('FROM creator_trial_grants', { id: 1 });
    harness.firstOn('FROM surveys WHERE id', surveyRow({ owner_id: 7 }));
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys', { method: 'POST', userId: '222', body: { title: '试用创建' } }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(201);
  });

  it('rejects invalid create payloads', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const cases: Array<{ body: unknown; fragment: string }> = [
      { body: { title: '  ' }, fragment: '标题' },
      { body: { title: 'X', questions: [{ type: 'boolean', title: 'B' }] }, fragment: '题型' },
      {
        body: { title: 'X', questions: [{ type: 'single', title: 'S', options: [{ label: '仅一项' }] }] },
        fragment: '选项',
      },
      {
        body: { title: 'X', questions: [{ type: 'matrix', title: 'M', options: [{ label: '行1' }] }] },
        fragment: '列',
      },
    ];
    for (const item of cases) {
      const { db } = makeDb();
      const response = await handleAdminApi(
        apiRequest('/api/admin/surveys', { method: 'POST', userId: '111', body: item.body }),
        makeEnv(db),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe('validation_failed');
      expect(body.message).toContain(item.fragment);
    }
  });

  it('updates draft survey metadata and rejects stale writes with 409', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const fresh = writableDraftDb({ survey: { updated_at: 'T1' } });
    const ok = await handleAdminApi(
      apiRequest('/api/admin/surveys/5', {
        method: 'PATCH',
        userId: '111',
        body: { title: '新标题', baseUpdatedAt: 'T1' },
      }),
      makeEnv(fresh.db),
    );
    expect(ok.status).toBe(200);
    expect(fresh.sqlLog.some((sql) => sql.includes('UPDATE surveys SET title = ?'))).toBe(true);

    const stale = writableDraftDb({ survey: { updated_at: 'T2' } });
    const conflict = await handleAdminApi(
      apiRequest('/api/admin/surveys/5', {
        method: 'PATCH',
        userId: '111',
        body: { title: '新标题', baseUpdatedAt: 'T1' },
      }),
      makeEnv(stale.db),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'stale_write', currentUpdatedAt: 'T2' });
  });

  it('locks writes on published surveys and on surveys with responses', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const published = writableDraftDb({ survey: { status: 'published' } });
    const responseA = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions', {
        method: 'POST',
        userId: '111',
        body: { type: 'text', title: 'T' },
      }),
      makeEnv(published.db),
    );
    expect(responseA.status).toBe(403);
    expect(await responseA.json()).toMatchObject({ code: 'survey_locked' });

    const withResponses = writableDraftDb({ responses: 3 });
    const responseB = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions', {
        method: 'POST',
        userId: '111',
        body: { type: 'text', title: 'T' },
      }),
      makeEnv(withResponses.db),
    );
    expect(responseB.status).toBe(403);
    expect(await responseB.json()).toMatchObject({ code: 'survey_locked' });
  });

  it('blocks owners without a trial from writing their own draft', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(OWNER);
    const harness = makeDb();
    harness.firstOn('FROM surveys WHERE id', surveyRow({ owner_id: 7 }));
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5', { method: 'PATCH', userId: '222', body: { title: 'X' } }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'creator_trial_required' });
  });

  it('adds a question at the end with options and returns ids', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.allOn('FROM survey_questions WHERE survey_id', [questionRow({ id: 11, order: 0 })]);
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions', {
        method: 'POST',
        userId: '111',
        body: { type: 'single', title: '新题目', options: [{ label: '甲' }, { label: '乙' }] },
      }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: number; order: number };
    expect(body.order).toBe(1);
    expect(harness.sqlLog.some((sql) => sql.includes('INSERT INTO survey_questions'))).toBe(true);
    expect(harness.sqlLog.filter((sql) => sql.includes('INSERT INTO question_options')).length).toBe(2);
  });

  it('updates question fields in place and rejects type changes', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.firstOn('FROM survey_questions WHERE id', questionRow());
    const ok = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions/11', {
        method: 'PATCH',
        userId: '111',
        body: { title: '改标题', required: false, validation: { max_length: 50 } },
      }),
      makeEnv(harness.db),
    );
    expect(ok.status).toBe(200);
    expect(harness.sqlLog.some((sql) => sql.includes('UPDATE survey_questions SET title = ?'))).toBe(true);
    expect(harness.sqlLog.some((sql) => sql.includes('UPDATE survey_questions SET validation_json = ?'))).toBe(true);

    const rejected = writableDraftDb();
    rejected.firstOn('FROM survey_questions WHERE id', questionRow());
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions/11', {
        method: 'PATCH',
        userId: '111',
        body: { type: 'text' },
      }),
      makeEnv(rejected.db),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('appends options through the question patch endpoint', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.firstOn('FROM survey_questions WHERE id', questionRow());
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions/11', {
        method: 'PATCH',
        userId: '111',
        body: { appendOptions: [{ label: '新选项' }] },
      }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(200);
    expect(harness.sqlLog.some((sql) => sql.includes('INSERT INTO question_options'))).toBe(true);
  });

  it('creates a single option through the dedicated endpoint and returns its id', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.firstOn('FROM survey_questions WHERE id', questionRow());
    harness.allOn('WHERE question_id IN', []);
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions/11/options', {
        method: 'POST',
        userId: '111',
        body: { label: '丙' },
      }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: number; order: number };
    expect(body.order).toBe(0);
    expect(body.id).toBeGreaterThan(0);
  });

  it('deletes a question and compacts the order', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.firstOn('FROM survey_questions WHERE id', questionRow());
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions/11', { method: 'DELETE', userId: '111' }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(200);
    expect(harness.sqlLog.some((sql) => sql.includes('DELETE FROM survey_questions WHERE id'))).toBe(true);
    expect(harness.sqlLog.some((sql) => sql.includes('"order" = "order" - 1'))).toBe(true);
  });

  it('rejects reorder payloads that do not match the current question set', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.allOn('FROM survey_questions WHERE survey_id', [
      questionRow({ id: 11 }),
      questionRow({ id: 12, order: 1 }),
    ]);
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions/reorder', {
        method: 'POST',
        userId: '111',
        body: { questionIds: [11] },
      }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(400);
  });

  it('reorders questions with a full id sequence', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.allOn('FROM survey_questions WHERE survey_id', [
      questionRow({ id: 11 }),
      questionRow({ id: 12, order: 1 }),
    ]);
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/questions/reorder', {
        method: 'POST',
        userId: '111',
        body: { questionIds: [12, 11] },
      }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(200);
    const reorderSql = harness.sqlLog.filter((sql) => sql.includes('UPDATE survey_questions SET "order" = ?'));
    expect(reorderSql.length).toBe(2);
  });

  it('renames and deletes options with survey scoping', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.firstOn('FROM question_options WHERE id', {
      id: 21,
      question_id: 11,
      label: 'A',
      value: 'A',
      order: 0,
      is_other: 0,
    });
    harness.firstOn('FROM survey_questions WHERE id', questionRow());
    const rename = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/options/21', { method: 'PATCH', userId: '111', body: { label: '新文案' } }),
      makeEnv(harness.db),
    );
    expect(rename.status).toBe(200);
    expect(harness.sqlLog.some((sql) => sql.includes('UPDATE question_options'))).toBe(true);

    const remove = writableDraftDb();
    remove.firstOn('FROM question_options WHERE id', {
      id: 21,
      question_id: 11,
      label: 'A',
      value: 'A',
      order: 0,
      is_other: 0,
    });
    remove.firstOn('FROM survey_questions WHERE id', questionRow());
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/options/21', { method: 'DELETE', userId: '111' }),
      makeEnv(remove.db),
    );
    expect(response.status).toBe(200);
    expect(remove.sqlLog.some((sql) => sql.includes('DELETE FROM question_options WHERE id'))).toBe(true);
  });

  it('rejects options that belong to another survey', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const harness = writableDraftDb();
    harness.firstOn('FROM question_options WHERE id', {
      id: 21,
      question_id: 11,
      label: 'A',
      value: 'A',
      order: 0,
      is_other: 0,
    });
    harness.firstOn('FROM survey_questions WHERE id', questionRow({ survey_id: 99 }));
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/options/21', { method: 'PATCH', userId: '111', body: { label: 'X' } }),
      makeEnv(harness.db),
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown write subpaths and 400 for malformed bodies', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const notFound = writableDraftDb();
    const responseA = await handleAdminApi(
      apiRequest('/api/admin/surveys/5/unknown', { method: 'POST', userId: '111', body: {} }),
      makeEnv(notFound.db),
    );
    expect(responseA.status).toBe(404);

    const malformed = writableDraftDb();
    const request = new Request('https://example.test/api/admin/surveys/5', {
      method: 'PATCH',
      headers: { 'x-telegram-user-id': '111' },
      body: 'not-json',
    });
    const responseB = await handleAdminApi(request, makeEnv(malformed.db));
    expect(responseB.status).toBe(400);
    expect(await responseB.json()).toMatchObject({ code: 'invalid_body' });
  });
});
