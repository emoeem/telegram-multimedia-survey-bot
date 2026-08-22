import { getUserByTelegramId } from '../db/repositories/user.repository';
import type { Env } from '../index';

// Telegram initData is signed when the Mini App session opens; treat anything
// older than a day as stale.
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  const fail = (status: number, code: string, message: string) =>
    Response.json({ code, message, requestId }, { status });
  const telegramId =
    (await verifyTelegramWebAppUser(request, env.BOT_TOKEN)) ||
    (env.ENVIRONMENT === 'development' ? Number(request.headers.get('x-telegram-user-id')) : NaN);
  const user = Number.isInteger(telegramId) ? await getUserByTelegramId(env.DB, telegramId) : null;
  if (!user) return fail(401, 'unauthorized', '请通过 Telegram 登录管理后台。');
  const adminIds = env.ADMIN_IDS.split(',').map(Number).filter(Number.isFinite);
  const isAdmin = user.systemRole === 'admin' || adminIds.includes(user.telegramUserId);
  const json = (body: unknown) => Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'Method not allowed');

  if (url.pathname === '/api/admin/dashboard') {
    // Unqualified owner_id on purpose: the count subqueries select from a bare
    // "surveys" table (no alias), unlike the JOIN queries below.
    const ownerClause = isAdmin ? '' : ' WHERE owner_id = ?';
    const bind = isAdmin ? [] : [user.id];
    const [counts, recent, responses] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM surveys${ownerClause}) surveys, (SELECT COUNT(*) FROM surveys${ownerClause ? ownerClause + ' AND' : ' WHERE'} status='published') publishedSurveys, (SELECT COUNT(*) FROM survey_responses r JOIN surveys s ON s.id=r.survey_id${isAdmin ? '' : ' WHERE s.owner_id = ?'}) responses`,
      ).bind(...bind, ...bind, ...bind),
      env.DB.prepare(
        `SELECT s.id,s.title,s.status,s.updated_at updatedAt FROM surveys s${ownerClause} ORDER BY s.updated_at DESC LIMIT 5`,
      ).bind(...bind),
      env.DB.prepare(
        `SELECT r.id,r.survey_id surveyId,r.status,r.updated_at updatedAt,s.title FROM survey_responses r JOIN surveys s ON s.id=r.survey_id${isAdmin ? '' : ' WHERE s.owner_id = ?'} ORDER BY r.updated_at DESC LIMIT 5`,
      ).bind(...(isAdmin ? [] : [user.id])),
    ])) as [D1Result, D1Result, D1Result];
    return json({
      ...((counts.results?.[0] ?? {}) as object),
      recentSurveys: recent.results ?? [],
      recentResponses: responses.results ?? [],
    });
  }

  if (url.pathname === '/api/admin/surveys') {
    const search = (url.searchParams.get('search') ?? '').trim();
    const status = url.searchParams.get('status') ?? '';
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize') ?? 20)));
    const offset = (page - 1) * pageSize;
    const conditions = [isAdmin ? '1=1' : 's.owner_id = ?'];
    const binds: unknown[] = isAdmin ? [] : [user.id];
    if (search) {
      conditions.push("(lower(s.title) LIKE ? OR lower(COALESCE(s.description,'')) LIKE ?)");
      binds.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
    }
    if (status) {
      conditions.push('s.status = ?');
      binds.push(status);
    }
    const where = conditions.join(' AND ');
    const [items, count] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT s.id,s.title,s.description,s.status,s.owner_id ownerId,s.created_at createdAt,s.updated_at updatedAt,(SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id=s.id) questionCount,(SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id) responseCount FROM surveys s WHERE ${where} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`,
      ).bind(...binds, pageSize, offset),
      env.DB.prepare(`SELECT COUNT(*) count FROM surveys s WHERE ${where}`).bind(...binds),
    ])) as [D1Result, D1Result];
    const total = Number((count.results?.[0] as { count?: number })?.count ?? 0);
    return json({ items: items.results ?? [], page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }

  const match = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    const survey = await env.DB.prepare(
      "SELECT s.*, u.username, u.first_name firstName, (SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id=s.id) questionCount, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id) responseCount, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id AND r.status='completed') completedCount FROM surveys s JOIN users u ON u.id=s.owner_id WHERE s.id=?",
    )
      .bind(id)
      .first<Record<string, unknown>>();
    if (!survey) return fail(404, 'not_found', '问卷不存在');
    if (!isAdmin && survey.owner_id !== user.id) return fail(403, 'forbidden', '无权访问此问卷');
    return json(survey);
  }

  return fail(404, 'not_found', 'Not found');
}

export async function verifyTelegramWebAppUser(request: Request, botToken: string): Promise<number> {
  const initDataHeader = request.headers.get('x-telegram-init-data');
  if (!initDataHeader || !botToken) return NaN;
  let initData: string;
  try {
    // The browser sends initData percent-encoded because header values must
    // stay ASCII (Telegram user names routinely contain non-ASCII characters).
    initData = decodeURIComponent(initDataHeader);
  } catch {
    return NaN;
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const userJson = params.get('user');
  if (!hash || !userJson) return NaN;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0 || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SECONDS) {
    return NaN;
  }
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const encoder = new TextEncoder();
  const secretMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secret = await crypto.subtle.sign('HMAC', secretMaterial, encoder.encode(botToken));
  const checkMaterial = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', checkMaterial, encoder.encode(dataCheckString)));
  const expected = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (expected !== hash) return NaN;
  try {
    const telegramUser = JSON.parse(userJson) as { id?: number };
    return typeof telegramUser.id === 'number' ? telegramUser.id : NaN;
  } catch {
    return NaN;
  }
}
