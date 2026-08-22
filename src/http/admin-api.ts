import { getUserByTelegramId } from '../db/repositories/user.repository';
import { createSurvey, getSurveyById } from '../db/repositories/survey.repository';
import {
  createQuestion,
  createQuestionOption,
  deleteQuestion,
  deleteQuestionOption,
  getQuestionById,
  getQuestionOptionById,
  listOptionsForQuestions,
  listQuestionsBySurvey,
  normalizeQuestionOrder,
  updateQuestionDescription,
  updateQuestionOptionLabel,
  updateQuestionRequired,
  updateQuestionSettings,
  updateQuestionTitle,
  updateQuestionValidation,
} from '../db/repositories/question.repository';
import { hasActiveCreatorTrial } from '../db/repositories/creator-trial.repository';
import {
  MATRIX_COLUMN_MIN,
  SURVEY_QUESTION_TYPES,
  isMatrixQuestionType,
  isSurveyQuestionType,
  minOptionCount,
} from '../survey/question-rules';
import type { QuestionType } from '../db/schema';
import type { Survey, SurveyQuestion } from '../db/schema';
import type { Env } from '../index';

// Telegram initData is signed when the Mini App session opens; treat anything
// older than a day as stale.
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

type AdminUser = NonNullable<Awaited<ReturnType<typeof getUserByTelegramId>>>;

interface QuestionPayload {
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  settingsJson: string | null;
  validationJson: string | null;
  options: { label: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, field: string, max: number): string | null {
  if (typeof value !== 'string') return `${field}必须是字符串`;
  const trimmed = value.trim();
  if (!trimmed) return `${field}不能为空`;
  if (trimmed.length > max) return `${field}长度不能超过 ${max} 字符`;
  return null;
}

// Validates one question payload. `creating` distinguishes the full-create
// shape (type + options minimums enforced) from partial updates.
function validateQuestionPayload(
  body: Record<string, unknown>,
  creating: boolean,
): { payload?: QuestionPayload; error?: string } {
  const type = body.type;
  if (creating || type !== undefined) {
    if (!isSurveyQuestionType(type)) {
      return { error: `题型必须是以下之一：${SURVEY_QUESTION_TYPES.join(', ')}` };
    }
  }

  let title: string | undefined;
  if (body.title !== undefined || creating) {
    const error = readString(body.title, '标题', 200);
    if (error) return { error };
    title = String(body.title).trim();
  }

  let description: string | null | undefined;
  if (body.description !== undefined) {
    if (body.description === null) description = null;
    else if (typeof body.description === 'string') {
      if (body.description.length > 1000) return { error: '描述长度不能超过 1000 字符' };
      description = body.description.trim() || null;
    } else return { error: '描述必须是字符串' };
  }

  let required: boolean | undefined;
  if (body.required !== undefined) {
    if (typeof body.required !== 'boolean') return { error: '必答必须是布尔值' };
    required = body.required;
  }

  const effectiveType = creating ? (type as QuestionType) : undefined;
  const optionsInput = creating ? body.options : body.appendOptions;
  let options: { label: string }[] | undefined;
  if (optionsInput !== undefined) {
    if (!Array.isArray(optionsInput)) return { error: '选项必须是数组' };
    options = [];
    for (const item of optionsInput) {
      if (!isRecord(item)) return { error: '选项必须是对象' };
      const error = readString(item.label, '选项文本', 200);
      if (error) return { error };
      options.push({ label: String(item.label).trim() });
    }
    if (creating && effectiveType) {
      const minimum = minOptionCount(effectiveType);
      if (minimum !== null && options.length < minimum) {
        return { error: `该题型至少需要 ${minimum} 个选项` };
      }
    }
  }

  let settingsJson: string | null | undefined;
  if (body.settings !== undefined && body.settings !== null) {
    if (!isRecord(body.settings)) return { error: 'settings 必须是对象' };
    const columns = body.settings.columns;
    if (!Array.isArray(columns)) return { error: 'matrix 列必须是字符串数组' };
    for (const column of columns) {
      if (typeof column !== 'string' || !column.trim() || column.length > 100) {
        return { error: 'matrix 列必须是非空字符串（≤100 字符）' };
      }
    }
    if (columns.length < MATRIX_COLUMN_MIN) {
      return { error: `matrix 题至少需要 ${MATRIX_COLUMN_MIN} 列` };
    }
    settingsJson = JSON.stringify({ columns: columns.map((column) => column.trim()) });
  } else if (body.settings === null) {
    settingsJson = null;
  }
  if (creating && effectiveType === 'matrix' && !settingsJson) {
    return { error: `matrix 题需要提供 settings.columns（至少 ${MATRIX_COLUMN_MIN} 列）` };
  }

  let validationJson: string | null | undefined;
  if (body.validation !== undefined) {
    if (body.validation === null) {
      validationJson = null;
    } else if (isRecord(body.validation)) {
      const allowed = ['min_length', 'max_length', 'min', 'max', 'min_selections', 'max_selections'];
      const normalized: Record<string, number | boolean> = {};
      for (const [key, value] of Object.entries(body.validation)) {
        if (!allowed.includes(key)) return { error: `不支持的校验字段：${key}` };
        if (key === 'decimal') {
          if (typeof value !== 'boolean') return { error: 'decimal 必须是布尔值' };
          normalized.decimal = value;
          continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          return { error: `${key} 必须是非负数字` };
        }
        normalized[key] = value;
      }
      validationJson = Object.keys(normalized).length ? JSON.stringify(normalized) : null;
    } else return { error: 'validation 必须是对象' };
  }

  return {
    payload: {
      type: (effectiveType ?? 'single') as QuestionType,
      title: title ?? '',
      description: description ?? null,
      required: required ?? true,
      settingsJson: settingsJson ?? null,
      validationJson: validationJson ?? null,
      options: options ?? [],
    },
  };
}

async function touchSurvey(db: D1Database, surveyId: number): Promise<string> {
  const timestamp = new Date().toISOString();
  await db.prepare('UPDATE surveys SET updated_at = ? WHERE id = ?').bind(timestamp, surveyId).run();
  return timestamp;
}

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

  if (request.method === 'GET') {
    return handleAdminRead(url, env, { user, isAdmin, fail, json });
  }
  if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
    return handleAdminWrite(request, url, env, { user, isAdmin, requestId, fail, json });
  }
  return fail(405, 'method_not_allowed', 'Method not allowed');
}

interface ReadContext {
  user: AdminUser;
  isAdmin: boolean;
  fail: (status: number, code: string, message: string) => Response;
  json: (body: unknown) => Response;
}

async function handleAdminRead(url: URL, env: Env, ctx: ReadContext): Promise<Response> {
  const { user, isAdmin, fail, json } = ctx;

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

  const editorMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/editor$/);
  if (editorMatch) {
    const id = Number(editorMatch[1]);
    const survey = await getSurveyById(env.DB, id);
    if (!survey) return fail(404, 'not_found', '问卷不存在');
    if (!isAdmin && survey.ownerId !== user.id) return fail(403, 'forbidden', '无权访问此问卷');
    const responseCountRow = await env.DB.prepare('SELECT COUNT(*) count FROM survey_responses WHERE survey_id = ?')
      .bind(id)
      .first<{ count: number }>();
    const responseCount = Number(responseCountRow?.count ?? 0);
    const questions = await listQuestionsBySurvey(env.DB, id);
    const options = await listOptionsForQuestions(
      env.DB,
      questions.map((question) => question.id),
    );
    const [questionMedia, optionMedia] = (await env.DB.batch([
      env.DB.prepare(
        'SELECT qm.question_id questionId, m.id mediaAssetId, m.media_type mediaType FROM question_media qm JOIN media_assets m ON m.id = qm.media_asset_id WHERE qm.question_id IN (SELECT id FROM survey_questions WHERE survey_id = ?) ORDER BY qm.question_id, qm.sort_order, m.id',
      ).bind(id),
      env.DB.prepare(
        'SELECT om.question_option_id optionId, m.id mediaAssetId, m.media_type mediaType FROM option_media om JOIN media_assets m ON m.id = om.media_asset_id JOIN question_options o ON o.id = om.question_option_id WHERE o.question_id IN (SELECT id FROM survey_questions WHERE survey_id = ?) ORDER BY om.question_option_id, om.sort_order, m.id',
      ).bind(id),
    ])) as [
      D1Result<{ questionId: number; mediaAssetId: number; mediaType: string }>,
      D1Result<{ optionId: number; mediaAssetId: number; mediaType: string }>,
    ];
    const questionMediaByQuestion = new Map<number, { mediaAssetId: number; mediaType: string }[]>();
    for (const row of questionMedia.results ?? []) {
      const list = questionMediaByQuestion.get(row.questionId) ?? [];
      list.push({ mediaAssetId: row.mediaAssetId, mediaType: row.mediaType });
      questionMediaByQuestion.set(row.questionId, list);
    }
    const optionMediaByOption = new Map<number, { mediaAssetId: number; mediaType: string }[]>();
    for (const row of optionMedia.results ?? []) {
      const list = optionMediaByOption.get(row.optionId) ?? [];
      list.push({ mediaAssetId: row.mediaAssetId, mediaType: row.mediaType });
      optionMediaByOption.set(row.optionId, list);
    }
    const parseJson = (value: string | null): Record<string, unknown> | null => {
      if (!value) return null;
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    return json({
      survey: {
        ...survey,
        responseCount,
        questionCount: questions.length,
        editable: survey.status === 'draft' && responseCount === 0,
      },
      questions: questions.map((question) => ({
        id: question.id,
        type: question.type,
        title: question.title,
        description: question.description,
        required: question.required,
        order: question.order,
        settings: parseJson(question.settingsJson),
        validation: parseJson(question.validationJson),
        condition: parseJson(question.conditionJson),
        media: questionMediaByQuestion.get(question.id) ?? [],
        options: options
          .filter((option) => option.questionId === question.id)
          .map((option) => ({
            id: option.id,
            label: option.label,
            order: option.order,
            media: optionMediaByOption.get(option.id) ?? [],
          })),
      })),
    });
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

interface WriteContext extends ReadContext {
  requestId: string;
}

interface WritableSurvey {
  survey: Survey;
}

async function loadWritableSurvey(
  env: Env,
  ctx: WriteContext,
  surveyId: number,
  body: Record<string, unknown>,
): Promise<WritableSurvey | Response> {
  const { user, isAdmin, fail, requestId } = ctx;
  const survey = await getSurveyById(env.DB, surveyId);
  if (!survey) return fail(404, 'not_found', '问卷不存在');
  if (!isAdmin && survey.ownerId !== user.id) return fail(403, 'forbidden', '无权访问此问卷');
  if (!isAdmin && !(await hasActiveCreatorTrial(env.DB, user.id))) {
    return fail(403, 'creator_trial_required', '需要有效的创作者权限才能管理问卷。');
  }
  if (survey.status !== 'draft') {
    return fail(403, 'survey_locked', '仅草稿状态可编辑；已发布的问卷请复制后再修改。');
  }
  const responseCountRow = await env.DB.prepare('SELECT COUNT(*) count FROM survey_responses WHERE survey_id = ?')
    .bind(surveyId)
    .first<{ count: number }>();
  if (Number(responseCountRow?.count ?? 0) > 0) {
    return fail(403, 'survey_locked', '该问卷已有答卷，题目和附件已锁定。');
  }
  const baseUpdatedAt = typeof body.baseUpdatedAt === 'string' ? body.baseUpdatedAt : null;
  if (baseUpdatedAt && baseUpdatedAt !== survey.updatedAt) {
    return Response.json(
      {
        code: 'stale_write',
        message: '问卷已在其他窗口被修改，请刷新后重试。',
        requestId,
        currentUpdatedAt: survey.updatedAt,
      },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return { survey };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

async function handleAdminWrite(request: Request, url: URL, env: Env, ctx: WriteContext): Promise<Response> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  const body = request.method === 'DELETE' ? {} : await readJsonBody(request);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');

  // POST /api/admin/surveys — 创建草稿问卷（可带初始题目）
  if (request.method === 'POST' && url.pathname === '/api/admin/surveys') {
    if (!isAdmin && !(await hasActiveCreatorTrial(db, user.id))) {
      return fail(403, 'creator_trial_required', '需要有效的创作者权限才能创建问卷。');
    }
    const titleError = readString(body.title, '标题', 200);
    if (titleError) return fail(400, 'validation_failed', titleError);
    let description: string | null = null;
    if (typeof body.description === 'string' && body.description.trim()) {
      if (body.description.length > 1000) return fail(400, 'validation_failed', '描述长度不能超过 1000 字符');
      description = body.description.trim();
    }
    const anonymous = body.anonymous === true;
    const allowMultipleResponses = body.allowMultipleResponses === true;
    const maxResponsesPerUser = body.maxResponsesPerUser === undefined ? 1 : Number(body.maxResponsesPerUser);
    if (!Number.isInteger(maxResponsesPerUser) || maxResponsesPerUser < 0 || maxResponsesPerUser > 999) {
      return fail(400, 'validation_failed', '填写次数上限必须是 0-999 的整数');
    }
    const questions: QuestionPayload[] = [];
    if (body.questions !== undefined) {
      if (!Array.isArray(body.questions)) return fail(400, 'validation_failed', 'questions 必须是数组');
      for (const item of body.questions) {
        if (!isRecord(item)) return fail(400, 'validation_failed', '题目必须是对象');
        const { payload, error } = validateQuestionPayload(item, true);
        if (error) return fail(400, 'validation_failed', error);
        questions.push(payload!);
      }
    }
    const survey = await createSurvey(db, {
      ownerId: user.id,
      title: String(body.title).trim(),
      description,
      anonymous,
      allowMultipleResponses,
      maxResponsesPerUser,
    });
    for (let index = 0; index < questions.length; index += 1) {
      await insertQuestionWithOptions(db, survey.id, questions[index]!, index);
    }
    const updatedAt = await touchSurvey(db, survey.id);
    return Response.json({ id: survey.id, updatedAt }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  }

  const surveyMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)(\/.*)?$/);
  if (!surveyMatch) return fail(404, 'not_found', 'Not found');
  const surveyId = Number(surveyMatch[1]);
  const rest = surveyMatch[2] ?? '';

  const writable = await loadWritableSurvey(env, ctx, surveyId, body);
  if (writable instanceof Response) return writable;

  // PATCH /api/admin/surveys/:id — 问卷基本信息
  if (request.method === 'PATCH' && rest === '') {
    const updates: string[] = [];
    const binds: unknown[] = [];
    if (body.title !== undefined) {
      const error = readString(body.title, '标题', 200);
      if (error) return fail(400, 'validation_failed', error);
      updates.push('title = ?');
      binds.push(String(body.title).trim());
    }
    if (body.description !== undefined) {
      if (body.description === null || body.description === '') {
        updates.push('description = ?');
        binds.push(null);
      } else if (typeof body.description === 'string') {
        if (body.description.length > 1000) return fail(400, 'validation_failed', '描述长度不能超过 1000 字符');
        updates.push('description = ?');
        binds.push(body.description.trim());
      } else return fail(400, 'validation_failed', '描述必须是字符串');
    }
    if (body.anonymous !== undefined) {
      if (typeof body.anonymous !== 'boolean') return fail(400, 'validation_failed', 'anonymous 必须是布尔值');
      updates.push('anonymous = ?');
      binds.push(body.anonymous ? 1 : 0);
    }
    if (body.allowMultipleResponses !== undefined) {
      if (typeof body.allowMultipleResponses !== 'boolean')
        return fail(400, 'validation_failed', 'allowMultipleResponses 必须是布尔值');
      updates.push('allow_multiple_responses = ?');
      binds.push(body.allowMultipleResponses ? 1 : 0);
    }
    if (body.maxResponsesPerUser !== undefined) {
      const value = Number(body.maxResponsesPerUser);
      if (!Number.isInteger(value) || value < 0 || value > 999)
        return fail(400, 'validation_failed', '填写次数上限必须是 0-999 的整数');
      updates.push('max_responses_per_user = ?');
      binds.push(value);
    }
    if (!updates.length) return fail(400, 'validation_failed', '没有可更新的字段');
    const timestamp = new Date().toISOString();
    updates.push('updated_at = ?');
    binds.push(timestamp, surveyId);
    await db
      .prepare(`UPDATE surveys SET ${updates.join(', ')} WHERE id = ? AND status = 'draft'`)
      .bind(...binds)
      .run();
    return json({ updatedAt: timestamp });
  }

  // POST /api/admin/surveys/:id/questions — 新增题目
  if (request.method === 'POST' && rest === '/questions') {
    const { payload, error } = validateQuestionPayload(body, true);
    if (error) return fail(400, 'validation_failed', error);
    const existing = await listQuestionsBySurvey(db, surveyId);
    if (existing.length >= 200) return fail(400, 'validation_failed', '题目数量不能超过 200');
    const order = existing.length;
    const questionId = await insertQuestionWithOptions(db, surveyId, payload!, order);
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      { id: questionId, order, updatedAt },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // POST /api/admin/surveys/:id/questions/reorder — 批量重排
  if (request.method === 'POST' && rest === '/questions/reorder') {
    if (!Array.isArray(body.questionIds) || body.questionIds.some((value) => !Number.isInteger(value))) {
      return fail(400, 'validation_failed', 'questionIds 必须是整数数组');
    }
    const questions = await listQuestionsBySurvey(db, surveyId);
    const existingIds = new Set(questions.map((question: SurveyQuestion) => question.id));
    const requestedIds = body.questionIds.map(Number);
    if (requestedIds.length !== existingIds.size || requestedIds.some((id: number) => !existingIds.has(id))) {
      return fail(400, 'validation_failed', 'questionIds 必须与当前题目集合完全一致');
    }
    await normalizeQuestionOrder(db, surveyId, requestedIds);
    const updatedAt = await touchSurvey(db, surveyId);
    return json({ updatedAt });
  }

  const questionMatch = rest.match(/^\/questions\/(\d+)$/);
  if (questionMatch) {
    const questionId = Number(questionMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, 'not_found', '题目不存在');

    // PATCH — 更新题目字段（保 ID；不改题型）
    if (request.method === 'PATCH') {
      if (body.type !== undefined && body.type !== question.type) {
        return fail(400, 'validation_failed', '不能修改题型；请删除后重新添加。');
      }
      const { payload, error } = validateQuestionPayload(body, false);
      if (error) return fail(400, 'validation_failed', error);
      if (payload!.title) await updateQuestionTitle(db, questionId, payload!.title);
      if (payload!.description !== undefined && body.description !== undefined) {
        await updateQuestionDescription(db, questionId, payload!.description);
      }
      if (payload!.required !== undefined && body.required !== undefined) {
        await updateQuestionRequired(db, questionId, payload!.required);
      }
      if (body.settings !== undefined) {
        if (!isMatrixQuestionType(question.type) && payload!.settingsJson) {
          return fail(400, 'validation_failed', '仅 matrix 题支持 settings');
        }
        await updateQuestionSettings(db, questionId, payload!.settingsJson);
      }
      if (body.validation !== undefined) {
        await updateQuestionValidation(db, questionId, payload!.validationJson);
      }
      if (body.appendOptions !== undefined) {
        const existingOptions = await listOptionsForQuestions(db, [questionId]);
        let order = existingOptions.length;
        for (const option of payload!.options) {
          await createQuestionOption(db, { questionId, label: option.label, value: option.label, order });
          order += 1;
        }
      }
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }

    // DELETE — 删除题目（repository 内含 order 补位；跳题规则的悬挂引用与
    // bot 端 deleteQuestion 行为一致：引擎对失效目标回退线性顺序）
    if (request.method === 'DELETE') {
      await deleteQuestion(db, questionId);
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
  }

  // POST /api/admin/surveys/:id/questions/:qid/options — 追加单个选项
  // （独立端点返回新选项 ID，供编辑器的保存队列做临时 ID 映射）
  const questionOptionsMatch = rest.match(/^\/questions\/(\d+)\/options$/);
  if (request.method === 'POST' && questionOptionsMatch) {
    const questionId = Number(questionOptionsMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, 'not_found', '题目不存在');
    const error = readString(body.label, '选项文本', 200);
    if (error) return fail(400, 'validation_failed', error);
    const existingOptions = await listOptionsForQuestions(db, [questionId]);
    if (existingOptions.length >= 50) return fail(400, 'validation_failed', '选项数量不能超过 50');
    const optionId = await createQuestionOption(db, {
      questionId,
      label: String(body.label).trim(),
      value: String(body.label).trim(),
      order: existingOptions.length,
    });
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      { id: optionId, order: existingOptions.length, updatedAt },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const optionMatch = rest.match(/^\/options\/(\d+)$/);
  if (optionMatch) {
    const optionId = Number(optionMatch[1]);
    const option = await getQuestionOptionById(db, optionId);
    if (!option) return fail(404, 'not_found', '选项不存在');
    const question = await getQuestionById(db, option.questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, 'not_found', '选项不存在');

    if (request.method === 'PATCH') {
      const error = readString(body.label, '选项文本', 200);
      if (error) return fail(400, 'validation_failed', error);
      await updateQuestionOptionLabel(db, optionId, String(body.label).trim());
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
    if (request.method === 'DELETE') {
      await deleteQuestionOption(db, optionId);
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
  }

  return fail(404, 'not_found', 'Not found');
}

async function insertQuestionWithOptions(
  db: D1Database,
  surveyId: number,
  payload: QuestionPayload,
  order: number,
): Promise<number> {
  const questionId = await createQuestion(db, {
    surveyId,
    type: payload.type,
    title: payload.title,
    description: payload.description,
    required: payload.required,
    order,
    settingsJson: isMatrixQuestionType(payload.type) ? payload.settingsJson : null,
    validationJson: payload.validationJson,
  });
  for (let index = 0; index < payload.options.length; index += 1) {
    const option = payload.options[index]!;
    await createQuestionOption(db, {
      questionId,
      label: option.label,
      value: option.label,
      order: index,
    });
  }
  return questionId;
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
