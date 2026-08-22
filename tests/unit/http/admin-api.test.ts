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

function apiRequest(path: string, options: { method?: string; userId?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.userId !== undefined) headers['x-telegram-user-id'] = options.userId;
  return new Request(`https://example.test${path}`, { method: options.method ?? 'GET', headers });
}

function makeDb() {
  const sqlLog: string[] = [];
  let firstResult: unknown = null;
  const makeStatement = () => {
    const statement = {
      bind: () => statement,
      first: async () => firstResult,
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({})),
    };
    return statement;
  };
  const db = {
    prepare: vi.fn((sql: string) => {
      sqlLog.push(sql);
      return makeStatement();
    }),
    batch: vi.fn(async (batch: unknown[]) => batch.map(() => ({ results: [] }))),
  };
  return {
    db: db as unknown as D1Database,
    sqlLog,
    setFirst: (value: unknown) => {
      firstResult = value;
    },
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

  it('rejects non-GET methods with 405', async () => {
    repositoryMocks.getUserByTelegramId.mockResolvedValue(ADMIN);
    const { db } = makeDb();
    const response = await handleAdminApi(
      apiRequest('/api/admin/surveys', { method: 'POST', userId: '111' }),
      makeEnv(db),
    );
    expect(response.status).toBe(405);
  });
});
