import {
  getUserById,
  getUserByTelegramId,
} from '../db/repositories/user.repository';
import { createAuditLog } from '../db/repositories/audit.repository';
import {
  addUserTag,
  listUserDirectory,
  listUserResponses,
  listUserTags,
  removeUserTag,
} from '../db/repositories/user.repository';
import {
  createSurvey,
  deleteSurvey,
  getSurveyById,
  updateSurveyStatus,
} from '../db/repositories/survey.repository';
import {
  getReportDeliveryById,
  listReportDeliveries,
} from '../db/repositories/report-delivery.repository';
import {
  archiveResponse,
  deleteResponse,
  getResponseById,
} from '../db/repositories/response.repository';
import {
  createQuestion,
  createQuestionOption,
  deleteQuestion,
  deleteQuestionOption,
  duplicateQuestion,
  duplicateQuestionOption,
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
  updateQuestionType,
  updateQuestionPage,
  updateQuestionCondition,
} from '../db/repositories/question.repository';
import {
  createSurveyPage,
  deleteSurveyPage,
  getSurveyPageById,
  listSurveyPages,
  normalizePageOrder,
  updateSurveyPage,
} from '../db/repositories/page.repository';
import { hasActiveCreatorTrial } from '../db/repositories/creator-trial.repository';
import {
  MATRIX_COLUMN_MIN,
  SURVEY_QUESTION_TYPES,
  isMatrixQuestionType,
  isSurveyQuestionType,
  minOptionCount,
} from '../survey/question-rules';
import { buildCsv, getExportRows, serializeExport } from '../services/export.service';
import { exportUnifiedSurveyJson } from '../services/survey-json.service';
import { parseImportedSurvey, saveImportedSurvey } from '../services/import.service';
import type { QuestionType } from '../db/schema';
import type { Survey, SurveyQuestion } from '../db/schema';
import type { Env } from '../index';
import { duplicateSurvey, publishSurvey } from '../services/survey.service';
import {
  diffSurveyVersions,
  getSurveyVersionSnapshot,
  listSurveyVersions,
} from '../services/survey-version.service';
import { enqueueReportDelivery } from '../services/report-delivery.service';
import { prepareResultProfileForResponse } from '../services/result-visual.service';
import { REPORT_TEMPLATES } from '../services/report/template';
import { createReportAccessToken } from '../services/report-access-token.service';
import {
  loadSystemSettings,
  saveSystemSetting,
  SYSTEM_SETTING_KEYS,
} from '../services/system-settings.service';
import {
  getNumericStatistics,
  getOptionStatistics,
  getSurveyStatistics,
} from '../services/statistics.service';
import { downloadTelegramFile } from '../bot/telegram';

// Telegram initData is signed when the Mini App session opens; treat anything
// older than a day as stale.
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

type AdminUser = NonNullable<Awaited<ReturnType<typeof getUserByTelegramId>>>;

interface QuestionPayload {
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  pageId: number | null;
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

function normalizeQuestionCondition(
  value: unknown,
): { conditionJson: string | null; skipToQuestionId: number | null } | { error: string } {
  if (value === null) {
    return { conditionJson: null, skipToQuestionId: null };
  }
  if (!isRecord(value)) {
    return { error: 'condition 必须是对象或 null' };
  }
  const rules: Array<{ optionId: number; targetQuestionId: number }> = [];
  if (Array.isArray(value.rules)) {
    for (const item of value.rules) {
      if (!isRecord(item)) return { error: 'rules 必须是对象数组' };
      const optionId = Number(item.optionId);
      const targetQuestionId = Number(item.targetQuestionId);
      if (!Number.isInteger(optionId) || optionId <= 0 || !Number.isInteger(targetQuestionId) || targetQuestionId <= 0) {
        return { error: 'rules 中的 optionId / targetQuestionId 必须是正整数' };
      }
      rules.push({ optionId, targetQuestionId });
    }
  } else {
    const optionId = Number(value.optionId);
    const targetQuestionId = Number(value.targetQuestionId);
    if (!Number.isInteger(optionId) || optionId <= 0 || !Number.isInteger(targetQuestionId) || targetQuestionId <= 0) {
      return { error: 'condition 需要 optionId 与 targetQuestionId' };
    }
    rules.push({ optionId, targetQuestionId });
  }
  if (rules.length === 0) {
    return { conditionJson: null, skipToQuestionId: null };
  }
  return {
    conditionJson: JSON.stringify({ kind: 'option_equals', rules }),
    skipToQuestionId: rules[0]!.targetQuestionId,
  };
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

  let pageId: number | null | undefined;
  if (body.pageId !== undefined) {
    if (body.pageId === null) pageId = null;
    else if (Number.isInteger(body.pageId) && Number(body.pageId) > 0) pageId = Number(body.pageId);
    else return { error: 'pageId 必须是正整数或 null' };
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
      pageId: pageId ?? null,
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

const RESPONSE_STATUSES = ['in_progress', 'completed', 'abandoned', 'cancelled'] as const;

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadReadableSurvey(
  env: Env,
  ctx: ReadContext,
  surveyId: number,
): Promise<Survey | Response> {
  const survey = await getSurveyById(env.DB, surveyId);
  if (!survey) return ctx.fail(404, 'not_found', '问卷不存在');
  if (!ctx.isAdmin && survey.ownerId !== ctx.user.id) {
    return ctx.fail(403, 'forbidden', '无权访问此问卷');
  }
  return survey;
}

function responseStatusLabel(status: string): string {
  if (status === 'completed') return '已完成';
  if (status === 'in_progress') return '填写中';
  if (status === 'abandoned') return '已放弃';
  if (status === 'cancelled') return '已取消';
  return status;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function formatAdminAnswer(
  answer: Record<string, unknown>,
  question: SurveyQuestion,
  selectedLabels: string[],
  optionLabels: Map<number, string>,
): string {
  if (selectedLabels.length) return selectedLabels.join('、');
  if (answer.text_value !== null && answer.text_value !== undefined) return String(answer.text_value);
  if (answer.number_value !== null && answer.number_value !== undefined) return String(answer.number_value);
  if (answer.rating_value !== null && answer.rating_value !== undefined) return String(answer.rating_value);
  if (answer.boolean_value !== null && answer.boolean_value !== undefined) {
    return Number(answer.boolean_value) === 1 ? '是' : '否';
  }
  if (answer.date_value !== null && answer.date_value !== undefined) return String(answer.date_value);
  if (answer.time_value !== null && answer.time_value !== undefined) return String(answer.time_value);

  const parsed = parseStoredJson(answer.json_value);
  if (question.type === 'matrix' && isRecord(parsed)) {
    const selections = isRecord(parsed.selections) ? parsed.selections : null;
    let columns: string[] = [];
    try {
      const settings = question.settingsJson ? JSON.parse(question.settingsJson) as { columns?: unknown } : null;
      columns = Array.isArray(settings?.columns)
        ? settings.columns.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      columns = [];
    }
    if (selections) {
      return Object.entries(selections)
        .map(([rowId, columnIndex]) => {
          const row = optionLabels.get(Number(rowId)) ?? `行 #${rowId}`;
          const column = columns[Number(columnIndex)] ?? `列 ${Number(columnIndex) + 1}`;
          return `${row}：${column}`;
        })
        .join('；');
    }
  }
  if (Array.isArray(parsed)) {
    return parsed.map((value) => optionLabels.get(Number(value)) ?? String(value)).join('、');
  }
  if (isRecord(parsed) && typeof parsed.mediaAssetId === 'number') {
    return `媒体附件 #${parsed.mediaAssetId}`;
  }
  if (parsed !== null && parsed !== undefined) {
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  }
  return '';
}

async function handleAdminRead(url: URL, env: Env, ctx: ReadContext): Promise<Response> {
  const { user, isAdmin, fail, json } = ctx;

  if (url.pathname === '/api/admin/dashboard') {
    // Unqualified owner_id on purpose: the count subqueries select from a bare
    // "surveys" table (no alias), unlike the JOIN queries below.
    const ownerClause = isAdmin ? '' : ' WHERE owner_id = ?';
    const bind = isAdmin ? [] : [user.id];
    const [counts, recent, responses, deliveries, recentActions] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM users) users,
                (SELECT COUNT(*) FROM surveys${ownerClause}) surveys,
                (SELECT COUNT(*) FROM surveys${ownerClause ? ownerClause + ' AND' : ' WHERE'} status='published') publishedSurveys,
                (SELECT COUNT(*) FROM survey_responses r JOIN surveys s ON s.id=r.survey_id${isAdmin ? '' : ' WHERE s.owner_id = ?'}) responses,
                (SELECT COUNT(*) FROM survey_responses r JOIN surveys s ON s.id=r.survey_id
                 WHERE date(r.started_at) = date('now')${isAdmin ? '' : ' AND s.owner_id = ?'}) todayResponses`,
      ).bind(...bind, ...bind, ...bind, ...bind),
      env.DB.prepare(
        `SELECT s.id,s.title,s.status,s.updated_at updatedAt FROM surveys s${ownerClause} ORDER BY s.updated_at DESC LIMIT 5`,
      ).bind(...bind),
      env.DB.prepare(
        `SELECT r.id,r.survey_id surveyId,r.status,r.updated_at updatedAt,s.title FROM survey_responses r JOIN surveys s ON s.id=r.survey_id${isAdmin ? '' : ' WHERE s.owner_id = ?'} ORDER BY r.updated_at DESC LIMIT 5`,
      ).bind(...(isAdmin ? [] : [user.id])),
      env.DB.prepare(
        `SELECT rd.status, COUNT(*) count
         FROM report_deliveries rd
         JOIN survey_responses r ON r.id = rd.response_id
         JOIN surveys s ON s.id = r.survey_id
         ${isAdmin ? '' : 'WHERE s.owner_id = ?'}
         GROUP BY rd.status`,
      ).bind(...(isAdmin ? [] : [user.id])),
      env.DB.prepare(
        `SELECT a.id, a.action, a.entity_type entityType, a.entity_id entityId, a.created_at createdAt
         FROM audit_logs a
         ORDER BY a.id DESC
         LIMIT 8`,
      ),
    ])) as [
      D1Result,
      D1Result,
      D1Result,
      D1Result,
      D1Result,
    ];
    const statusCounts: Record<string, number> = {};
    for (const row of (deliveries.results ?? []) as Array<{ status: string; count: number }>) {
      statusCounts[row.status] = Number(row.count ?? 0);
    }
    return json({
      ...((counts.results?.[0] ?? {}) as object),
      recentSurveys: recent.results ?? [],
      recentResponses: responses.results ?? [],
      reportDeliveries: {
        pending: statusCounts["pending"] ?? 0,
        delivering: statusCounts["delivering"] ?? 0,
        delivered: statusCounts["delivered"] ?? 0,
        failed: statusCounts["failed"] ?? 0,
      },
      recentActions: isAdmin ? (recentActions.results ?? []) : [],
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

  if (url.pathname === '/api/admin/users') {
    if (!isAdmin) return fail(403, 'forbidden', '仅管理员可查看用户目录');
    const search = url.searchParams.get('search') ?? '';
    const tag = url.searchParams.get('tag') ?? '';
    const page = positiveInteger(url.searchParams.get('page'), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get('pageSize'), 20));
    const { items, total } = await listUserDirectory(env.DB, {
      search,
      tag,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }

  if (url.pathname === '/api/admin/report-deliveries') {
    const status = url.searchParams.get('status') ?? '';
    const page = positiveInteger(url.searchParams.get('page'), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get('pageSize'), 20));
    const listInput: {
      status?: string;
      ownerId?: number | null;
      limit: number;
      offset: number;
    } = { ownerId: isAdmin ? null : user.id, limit: pageSize, offset: (page - 1) * pageSize };
    if (status) listInput.status = status;
    const { items, total } = await listReportDeliveries(env.DB, listInput);
    return json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }

  if (url.pathname === '/api/admin/report-templates') {
    if (!isAdmin) return fail(403, 'forbidden', '仅管理员可查看报告模板');
    return json({
      templates: Object.values(REPORT_TEMPLATES).map((template) => ({
        id: template.id,
        name: template.name,
        theme: template.theme,
        renderers: template.renderers,
      })),
    });
  }

  if (url.pathname === '/api/admin/settings') {
    if (!isAdmin) return fail(403, 'forbidden', '仅管理员可查看系统设置');
    return json({ settings: await loadSystemSettings(env.DB) });
  }

  const userDetailMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userDetailMatch) {
    if (!isAdmin) return fail(403, 'forbidden', '仅管理员可查看用户详情');
    const userId = Number(userDetailMatch[1]);
    const user = await getUserById(env.DB, userId);
    if (!user) return fail(404, 'not_found', '用户不存在');
    const [tags, responses] = await Promise.all([
      listUserTags(env.DB, userId),
      listUserResponses(env.DB, userId),
    ]);
    return json({
      user: {
        id: user.id,
        telegramUserId: user.telegramUserId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        systemRole: user.systemRole,
        bannedAt: user.bannedAt,
        createdAt: user.createdAt,
      },
      tags,
      responses,
    });
  }

  const responseMediaMatch = url.pathname.match(
    /^\/api\/admin\/surveys\/(\d+)\/responses\/(\d+)\/media\/(\d+)$/,
  );
  if (responseMediaMatch) {
    const surveyId = Number(responseMediaMatch[1]);
    const responseId = Number(responseMediaMatch[2]);
    const mediaAssetId = Number(responseMediaMatch[3]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const media = await env.DB.prepare(
      `SELECT m.telegram_file_id telegramFileId,m.mime_type mimeType,m.file_name fileName,m.file_size fileSize
       FROM media_assets m
       JOIN answer_media am ON am.media_asset_id=m.id
       JOIN answers a ON a.id=am.answer_id
       JOIN survey_responses r ON r.id=a.response_id
       WHERE m.id=? AND m.asset_scope='response' AND r.id=? AND r.survey_id=?
       LIMIT 1`,
    ).bind(mediaAssetId, responseId, surveyId).first<{
      telegramFileId: string | null;
      mimeType: string | null;
      fileName: string | null;
      fileSize: number | null;
    }>();
    if (!media?.telegramFileId) return fail(404, 'not_found', '答卷媒体不存在或不可用');
    if (media.fileSize !== null && media.fileSize > 20 * 1024 * 1024) {
      return fail(413, 'media_too_large', '媒体文件超过 20MB，无法在线预览');
    }
    try {
      const downloaded = await downloadTelegramFile(env.BOT_TOKEN, media.telegramFileId);
      if (downloaded.data.byteLength > 20 * 1024 * 1024) {
        return fail(413, 'media_too_large', '媒体文件超过 20MB，无法在线预览');
      }
      const contentType = media.mimeType || downloaded.contentType || 'application/octet-stream';
      const safeName = (media.fileName || downloaded.filePath.split('/').pop() || `media-${mediaAssetId}`)
        .replace(/[\r\n"\\]/g, '_');
      const responseBody = new Uint8Array(downloaded.data).buffer;
      return new Response(responseBody, {
        headers: {
          'Cache-Control': 'private, max-age=300',
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${safeName}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      console.error('Admin response media download failed', { surveyId, responseId, mediaAssetId, error });
      return fail(502, 'media_download_failed', '媒体暂时无法读取，请稍后重试');
    }
  }

  const exportMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/export$/);
  if (exportMatch) {
    const surveyId = Number(exportMatch[1]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const format = url.searchParams.get('format') ?? 'csv';
    if (!['csv', 'xlsx', 'zip', 'json'].includes(format)) {
      return fail(400, 'validation_failed', '导出格式无效');
    }
    const fileName = `survey-${surveyId}.${format}`;
    if (format === 'json') {
      const exported = await exportUnifiedSurveyJson(env.DB, surveyId);
      if (!exported) return fail(404, 'not_found', '问卷不存在');
      return new Response(JSON.stringify(exported, null, 2), {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    const { rows } = await getExportRows(env.DB, surveyId);
    const csv = buildCsv(rows);
    const content = serializeExport(format as 'csv' | 'xlsx' | 'zip', csv, rows);
    const contentType = format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : format === 'zip'
        ? 'application/zip'
        : 'text/csv; charset=utf-8';
    const body = typeof content === 'string'
      ? new TextEncoder().encode(`\uFEFF${content}`).buffer
      : new Uint8Array(content).buffer;
    return new Response(body, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const analyticsMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/analytics$/);
  if (analyticsMatch) {
    const surveyId = Number(analyticsMatch[1]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const [overview, optionStats, numericStats, statusRows] = await Promise.all([
      getSurveyStatistics(env.DB, surveyId),
      getOptionStatistics(env.DB, surveyId),
      getNumericStatistics(env.DB, surveyId),
      env.DB.prepare(
        'SELECT status, COUNT(*) count FROM survey_responses WHERE survey_id = ? GROUP BY status',
      ).bind(surveyId).all<{ status: string; count: number }>(),
    ]);
    const statusCounts = Object.fromEntries(
      RESPONSE_STATUSES.map((status) => [status, 0]),
    ) as Record<(typeof RESPONSE_STATUSES)[number], number>;
    for (const row of statusRows.results ?? []) {
      if (RESPONSE_STATUSES.includes(row.status as (typeof RESPONSE_STATUSES)[number])) {
        statusCounts[row.status as (typeof RESPONSE_STATUSES)[number]] = Number(row.count ?? 0);
      }
    }
    return json({
      survey: { id: survey.id, title: survey.title, status: survey.status },
      overview,
      statusCounts,
      optionStats,
      numericStats,
    });
  }

  const responseDetailMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/responses\/(\d+)$/);
  if (responseDetailMatch) {
    const surveyId = Number(responseDetailMatch[1]);
    const responseId = Number(responseDetailMatch[2]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const response = await env.DB.prepare(
      `SELECT r.id,r.survey_id,r.user_id,r.status,r.started_at,r.completed_at,r.submitted_at,r.updated_at,
              u.telegram_user_id,u.username,u.first_name,u.last_name
       FROM survey_responses r
       LEFT JOIN users u ON u.id=r.user_id
       WHERE r.id=? AND r.survey_id=?`,
    ).bind(responseId, surveyId).first<Record<string, unknown>>();
    if (!response) return fail(404, 'not_found', '答卷不存在');

    const questions = await listQuestionsBySurvey(env.DB, surveyId);
    const options = await listOptionsForQuestions(env.DB, questions.map((question) => question.id));
    const [answerRows, selectedRows, mediaRows] = (await env.DB.batch([
      env.DB.prepare('SELECT * FROM answers WHERE response_id = ? ORDER BY id ASC').bind(responseId),
      env.DB.prepare(
        `SELECT ao.answer_id answerId,qo.id optionId,qo.label
         FROM answer_options ao
         JOIN question_options qo ON qo.id=ao.question_option_id
         JOIN answers a ON a.id=ao.answer_id
         WHERE a.response_id=?
         ORDER BY ao.id`,
      ).bind(responseId),
      env.DB.prepare(
        `SELECT am.answer_id answerId,m.id mediaAssetId,m.media_type mediaType,m.file_name fileName,m.mime_type mimeType
         FROM answer_media am
         JOIN media_assets m ON m.id=am.media_asset_id
         JOIN answers a ON a.id=am.answer_id
         WHERE a.response_id=? AND m.asset_scope='response'
         ORDER BY am.answer_id,am.sort_order,am.id`,
      ).bind(responseId),
    ])) as [
      D1Result<Record<string, unknown>>,
      D1Result<{ answerId: number; optionId: number; label: string }>,
      D1Result<{ answerId: number; mediaAssetId: number; mediaType: string; fileName: string | null; mimeType: string | null }>,
    ];
    const answersByQuestion = new Map<number, Record<string, unknown>>();
    for (const answer of answerRows.results ?? []) answersByQuestion.set(Number(answer.question_id), answer);
    const selectedByAnswer = new Map<number, string[]>();
    for (const row of selectedRows.results ?? []) {
      const labels = selectedByAnswer.get(row.answerId) ?? [];
      labels.push(row.label);
      selectedByAnswer.set(row.answerId, labels);
    }
    const mediaByAnswer = new Map<number, typeof mediaRows.results>();
    for (const row of mediaRows.results ?? []) {
      const media = mediaByAnswer.get(row.answerId) ?? [];
      media.push(row);
      mediaByAnswer.set(row.answerId, media);
    }
    const optionLabels = new Map(options.map((option) => [option.id, option.label]));

    return json({
      survey: { id: survey.id, title: survey.title, anonymous: survey.anonymous },
      response: {
        id: Number(response.id),
        status: String(response.status),
        statusLabel: responseStatusLabel(String(response.status)),
        startedAt: String(response.started_at),
        completedAt: response.completed_at === null ? null : String(response.completed_at),
        submittedAt: response.submitted_at === null ? null : String(response.submitted_at),
        updatedAt: String(response.updated_at),
        respondent: survey.anonymous || response.telegram_user_id === null
          ? null
          : {
              telegramUserId: Number(response.telegram_user_id),
              username: response.username === null ? null : String(response.username),
              firstName: response.first_name === null ? null : String(response.first_name),
              lastName: response.last_name === null ? null : String(response.last_name),
            },
      },
      answers: questions.map((question) => {
        const answer = answersByQuestion.get(question.id);
        const answerId = answer ? Number(answer.id) : null;
        return {
          questionId: question.id,
          questionTitle: question.title,
          questionType: question.type,
          order: question.order,
          answered: Boolean(answer),
          value: answer
            ? formatAdminAnswer(answer, question, selectedByAnswer.get(answerId!) ?? [], optionLabels)
            : '',
          media: answerId === null ? [] : mediaByAnswer.get(answerId) ?? [],
        };
      }),
    });
  }

  const responsesMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/responses$/);
  if (responsesMatch) {
    const surveyId = Number(responsesMatch[1]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const status = url.searchParams.get('status') ?? '';
    if (status && !RESPONSE_STATUSES.includes(status as (typeof RESPONSE_STATUSES)[number])) {
      return fail(400, 'validation_failed', '答卷状态无效');
    }
    const page = positiveInteger(url.searchParams.get('page'), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get('pageSize'), 20));
    const offset = (page - 1) * pageSize;
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return fail(400, 'validation_failed', 'from 必须是 YYYY-MM-DD');
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return fail(400, 'validation_failed', 'to 必须是 YYYY-MM-DD');
    }
    const statusClause = status ? ' AND r.status=?' : '';
    const dateClause = `${from ? ' AND date(r.started_at) >= ?' : ''}${to ? ' AND date(r.started_at) <= ?' : ''}`;
    const binds: unknown[] = [
      surveyId,
      ...(status ? [status] : []),
      ...(from ? [from] : []),
      ...(to ? [to] : []),
    ];
    const [items, count] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT r.id,r.status,r.started_at startedAt,r.completed_at completedAt,r.updated_at updatedAt,
                u.telegram_user_id telegramUserId,u.username,u.first_name firstName,u.last_name lastName
         FROM survey_responses r
         LEFT JOIN users u ON u.id=r.user_id
         WHERE r.survey_id=?${statusClause}${dateClause}
         ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      ).bind(...binds, pageSize, offset),
      env.DB.prepare(
        `SELECT COUNT(*) count FROM survey_responses r WHERE r.survey_id=?${statusClause}${dateClause}`,
      ).bind(...binds),
    ])) as [D1Result<Record<string, unknown>>, D1Result<{ count: number }>];
    const total = Number(count.results?.[0]?.count ?? 0);
    return json({
      survey: { id: survey.id, title: survey.title, anonymous: survey.anonymous },
      items: (items.results ?? []).map((item) => ({
        id: Number(item.id),
        status: String(item.status),
        statusLabel: responseStatusLabel(String(item.status)),
        startedAt: String(item.startedAt),
        completedAt: item.completedAt === null ? null : String(item.completedAt),
        updatedAt: String(item.updatedAt),
        respondent: survey.anonymous || item.telegramUserId === null
          ? null
          : {
              telegramUserId: Number(item.telegramUserId),
              username: item.username === null ? null : String(item.username),
              firstName: item.firstName === null ? null : String(item.firstName),
              lastName: item.lastName === null ? null : String(item.lastName),
            },
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
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
      pages: (await env.DB.prepare(
        `SELECT id, title, description, "order"
         FROM survey_pages
         WHERE survey_id = ?
         ORDER BY "order" ASC, id ASC`,
      ).bind(id).all<{
        id: number;
        title: string | null;
        description: string | null;
        order: number;
      }>()).results ?? [],
      questions: questions.map((question) => ({
        id: question.id,
        type: question.type,
        title: question.title,
        description: question.description,
        required: question.required,
        order: question.order,
        pageId: question.pageId,
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

  const versionsMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/versions$/);
  if (versionsMatch) {
    const id = Number(versionsMatch[1]);
    const survey = await loadReadableSurvey(env, ctx, id);
    if (survey instanceof Response) return survey;
    return json({ versions: await listSurveyVersions(env.DB, id) });
  }

  const versionCompareMatch = url.pathname.match(
    /^\/api\/admin\/surveys\/(\d+)\/versions\/(\d+)\/compare\/(\d+)$/,
  );
  if (versionCompareMatch) {
    const id = Number(versionCompareMatch[1]);
    const fromVersion = Number(versionCompareMatch[2]);
    const toVersion = Number(versionCompareMatch[3]);
    const survey = await loadReadableSurvey(env, ctx, id);
    if (survey instanceof Response) return survey;
    const [from, to] = await Promise.all([
      getSurveyVersionSnapshot(env.DB, id, fromVersion),
      getSurveyVersionSnapshot(env.DB, id, toVersion),
    ]);
    if (!from || !to) return fail(404, 'version_not_found', '版本不存在');
    return json({ fromVersion, toVersion, diff: diffSurveyVersions(from, to) });
  }

  const versionDetailMatch = url.pathname.match(
    /^\/api\/admin\/surveys\/(\d+)\/versions\/(\d+)$/,
  );
  if (versionDetailMatch) {
    const id = Number(versionDetailMatch[1]);
    const version = Number(versionDetailMatch[2]);
    const survey = await loadReadableSurvey(env, ctx, id);
    if (survey instanceof Response) return survey;
    const snapshot = await getSurveyVersionSnapshot(env.DB, id, version);
    if (!snapshot) return fail(404, 'version_not_found', '版本不存在');
    return json({ version, survey: snapshot.survey });
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

async function writeAudit(
  db: D1Database,
  input: {
    actorUserId: number | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  try {
    await createAuditLog(db, input);
  } catch (error) {
    // Auditing must never break the underlying operation.
    console.error("Audit log write failed", { action: input.action, error });
  }
}

interface WritableSurvey {
  survey: Survey;
}

async function loadManageableSurvey(
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

async function loadWritableSurvey(
  env: Env,
  ctx: WriteContext,
  surveyId: number,
  body: Record<string, unknown>,
): Promise<WritableSurvey | Response> {
  const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
  if (manageable instanceof Response) return manageable;
  const { survey } = manageable;
  const { fail } = ctx;
  if (survey.status !== 'draft') {
    return fail(403, 'survey_locked', '仅草稿状态可编辑；已发布的问卷请复制后再修改。');
  }
  const responseCountRow = await env.DB.prepare('SELECT COUNT(*) count FROM survey_responses WHERE survey_id = ?')
    .bind(surveyId)
    .first<{ count: number }>();
  if (Number(responseCountRow?.count ?? 0) > 0) {
    return fail(403, 'survey_locked', '该问卷已有答卷，题目和附件已锁定。');
  }
  return { survey };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    // Action endpoints (close/archive/publish/delete) legitimately send an
    // empty body; treat it as an empty object and validate fields explicitly.
    if (!text.trim()) return {};
    const body = JSON.parse(text) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

async function handleAdminWrite(request: Request, url: URL, env: Env, ctx: WriteContext): Promise<Response> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  const body = await readJsonBody(request);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');

  const retryDeliveryMatch = url.pathname.match(/^\/api\/admin\/report-deliveries\/(\d+)\/retry$/);
  if (request.method === 'POST' && retryDeliveryMatch) {
    const delivery = await getReportDeliveryById(db, Number(retryDeliveryMatch[1]));
    if (!delivery) return fail(404, 'delivery_not_found', '报告任务不存在');
    const response = await getResponseById(db, delivery.responseId);
    if (!response) return fail(404, 'response_not_found', '答卷不存在');
    const survey = await getSurveyById(db, response.surveyId);
    if (!isAdmin && (!survey || survey.ownerId !== user.id)) {
      return fail(403, 'forbidden', '无权操作该报告任务');
    }
    await enqueueReportDelivery(db, env.EXPORT_QUEUE, {
      responseId: delivery.responseId,
      force: true,
    });
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'report.retry',
      entityType: 'report_delivery',
      entityId: String(delivery.id),
      after: { responseId: delivery.responseId },
    });
    return json({ ok: true });
  }

  if (request.method === 'PUT' && url.pathname === '/api/admin/settings') {
    if (!isAdmin) return fail(403, 'forbidden', '仅管理员可修改系统设置');
    const updates: Record<string, string> = {};
    for (const key of SYSTEM_SETTING_KEYS) {
      if (body[key] === undefined) continue;
      const value = String(body[key]).trim();
      if (key === 'default_report_template' && value && !REPORT_TEMPLATES[value]) {
        return fail(400, 'validation_failed', '默认报告模板无效');
      }
      if (
        key === 'media_ttl_seconds' ||
        key === 'max_upload_mb' ||
        key === 'max_response_media_mb' ||
        key === 'pdf_max_mb'
      ) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          return fail(400, 'validation_failed', `${key} 必须是正数`);
        }
      }
      updates[key] = value;
    }
    if (!Object.keys(updates).length) {
      return fail(400, 'validation_failed', '没有可更新的设置');
    }
    for (const [key, value] of Object.entries(updates)) {
      await saveSystemSetting(db, key, value, user.id);
    }
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'settings.update',
      entityType: 'settings',
      after: Object.keys(updates),
    });
    return json({ ok: true, updated: Object.keys(updates) });
  }

  const userTagRoute = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/tags(?:\/([^/]+))?$/);
  if (userTagRoute) {
    if (!isAdmin) return fail(403, 'forbidden', '仅管理员可管理用户标签');
    const userId = Number(userTagRoute[1]);
    const target = await getUserById(db, userId);
    if (!target) return fail(404, 'not_found', '用户不存在');
    const tagValue = userTagRoute[2];
    if (request.method === 'POST' && tagValue === undefined) {
      const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
      if (!tag || tag.length > 30) {
        return fail(400, 'validation_failed', '标签必须是 1-30 字符的非空字符串');
      }
      await addUserTag(db, { userId, tag, createdBy: user.id });
      return json({ ok: true });
    }
    if (request.method === 'DELETE' && tagValue !== undefined) {
      await removeUserTag(db, userId, decodeURIComponent(tagValue));
      return json({ ok: true });
    }
    return fail(405, 'method_not_allowed', '仅支持 POST / DELETE');
  }

  if (request.method === 'POST' && (url.pathname === '/api/admin/imports/validate' || url.pathname === '/api/admin/imports')) {
    if (!isAdmin && !(await hasActiveCreatorTrial(db, user.id))) {
      return fail(403, 'creator_trial_required', '需要有效的创作者权限才能导入问卷。');
    }
    if (typeof body.content !== 'string' || !body.content.trim()) {
      return fail(400, 'validation_failed', '请选择 JSON 文件或粘贴 JSON 内容');
    }
    if (new TextEncoder().encode(body.content).byteLength > 2 * 1024 * 1024) {
      return fail(413, 'import_too_large', '导入文件不能超过 2MB');
    }
    let imported: ReturnType<typeof parseImportedSurvey>;
    try {
      imported = parseImportedSurvey(body.content);
    } catch (error) {
      return fail(400, 'invalid_import', error instanceof Error ? error.message : 'JSON 导入内容无效');
    }
    const summary = {
      title: imported.title,
      description: imported.description ?? null,
      questionCount: imported.questions.length,
      mediaCount: imported.questions.reduce(
        (total, question) => total + (question.media?.length ?? 0) + (question.options ?? []).reduce(
          (optionTotal, option) => optionTotal + option.media.length,
          0,
        ),
        0,
      ),
      warnings: imported.importWarnings ?? [],
    };
    if (url.pathname.endsWith('/validate')) return json(summary);
    try {
      const id = await saveImportedSurvey(db, user.id, imported);
      await writeAudit(db, {
        actorUserId: user.id,
        action: 'survey.import',
        entityType: 'survey',
        entityId: String(id),
        after: { title: imported.title, questionCount: imported.questions.length },
      });
      return Response.json(
        { id, ...summary },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      console.error('Admin survey import failed', { userId: user.id, error });
      return fail(500, 'import_failed', '导入保存失败，未完成的数据已回滚');
    }
  }

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
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'survey.create',
      entityType: 'survey',
      entityId: String(survey.id),
      after: { title: survey.title, questionCount: questions.length },
    });
    return Response.json({ id: survey.id, updatedAt }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  }

  const surveyMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)(\/.*)?$/);
  if (!surveyMatch) return fail(404, 'not_found', 'Not found');
  const surveyId = Number(surveyMatch[1]);
  const rest = surveyMatch[2] ?? '';

  if (request.method === 'POST' && rest === '/duplicate') {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const duplicate = await duplicateSurvey(db, surveyId, user.id);
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'survey.duplicate',
      entityType: 'survey',
      entityId: String(surveyId),
      after: { duplicateId: duplicate.id },
    });
    return Response.json(
      { id: duplicate.id, updatedAt: duplicate.updatedAt },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (request.method === 'POST' && (rest === '/close' || rest === '/archive' || rest === '/reopen')) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const before = { status: manageable.survey.status };
    try {
      let updated;
      if (rest === '/reopen') {
        updated = await publishSurvey(db, surveyId, user.id);
      } else {
        updated = await updateSurveyStatus(db, surveyId, rest === '/close' ? 'closed' : 'archived');
      }
      if (!updated) return fail(404, 'not_found', '问卷不存在');
      await writeAudit(db, {
        actorUserId: user.id,
        action: `survey.${rest === '/close' ? 'close' : rest === '/archive' ? 'archive' : 'reopen'}`,
        entityType: 'survey',
        entityId: String(surveyId),
        before,
        after: { status: updated.status },
      });
      return json({ status: updated.status, updatedAt: updated.updatedAt, version: updated.version });
    } catch (error) {
      return fail(400, 'status_change_failed', error instanceof Error ? error.message : '状态变更失败');
    }
  }

  if (request.method === 'DELETE' && rest === '') {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    try {
      await deleteSurvey(db, surveyId);
      await writeAudit(db, {
        actorUserId: user.id,
        action: 'survey.delete',
        entityType: 'survey',
        entityId: String(surveyId),
        before: { status: manageable.survey.status },
      });
      return json({ ok: true });
    } catch (error) {
      return fail(400, 'delete_blocked', error instanceof Error ? error.message : '删除失败');
    }
  }

  const regenerateMatch = rest.match(/^\/responses\/(\d+)\/report$/);
  if (request.method === 'POST' && regenerateMatch) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const responseId = Number(regenerateMatch[1]);
    const response = await getResponseById(db, responseId);
    if (!response || response.surveyId !== surveyId) {
      return fail(404, 'response_not_found', '答卷不存在');
    }
    await prepareResultProfileForResponse(db, responseId, { forceRecalculate: true });
    await enqueueReportDelivery(db, env.EXPORT_QUEUE, { responseId, force: true });
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'report.regenerate',
      entityType: 'response',
      entityId: String(responseId),
      after: { surveyId },
    });
    return json({ ok: true });
  }

  const responseActionMatch = rest.match(/^\/responses\/(\d+)\/(archive|delete|report-link)$/);
  if (request.method === 'POST' && responseActionMatch) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const responseId = Number(responseActionMatch[1]);
    const action = responseActionMatch[2];
    const response = await getResponseById(db, responseId);
    if (!response || response.surveyId !== surveyId) {
      return fail(404, 'response_not_found', '答卷不存在');
    }
    if (action === 'archive') {
      await archiveResponse(db, responseId);
      await writeAudit(db, {
        actorUserId: user.id,
        action: 'response.archive',
        entityType: 'response',
        entityId: String(responseId),
      });
      return json({ ok: true });
    }
    if (action === 'delete') {
      try {
        await deleteResponse(db, responseId);
        await writeAudit(db, {
          actorUserId: user.id,
          action: 'response.delete',
          entityType: 'response',
          entityId: String(responseId),
        });
        return json({ ok: true });
      } catch (error) {
        return fail(400, 'delete_blocked', error instanceof Error ? error.message : '删除失败');
      }
    }
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, responseId);
    return json({ reportUrl: `/report/${responseId}?t=${token}` });
  }

  const restoreMatch = rest.match(/^\/versions\/(\d+)\/restore$/);
  if (request.method === 'POST' && restoreMatch) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const version = Number(restoreMatch[1]);
    const snapshot = await getSurveyVersionSnapshot(db, surveyId, version);
    if (!snapshot) return fail(404, 'version_not_found', '版本不存在');
    const imported = parseImportedSurvey(JSON.stringify(snapshot));
    const restoredId = await saveImportedSurvey(db, user.id, imported);
    await writeAudit(db, {
      actorUserId: user.id,
      action: 'survey.restore',
      entityType: 'survey',
      entityId: String(surveyId),
      after: { version, restoredSurveyId: restoredId },
    });
    return Response.json(
      { id: restoredId, version },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const writable = await loadWritableSurvey(env, ctx, surveyId, body);
  if (writable instanceof Response) return writable;

  if (request.method === 'POST' && rest === '/publish') {
    try {
      const published = await publishSurvey(db, surveyId, user.id);
      await writeAudit(db, {
        actorUserId: user.id,
        action: 'survey.publish',
        entityType: 'survey',
        entityId: String(surveyId),
        after: { version: published.version },
      });
      return json({
        status: published.status,
        publishedAt: published.publishedAt,
        version: published.version,
        updatedAt: published.updatedAt,
      });
    } catch (error) {
      return fail(400, 'publish_validation', error instanceof Error ? error.message : '问卷不满足发布条件');
    }
  }

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
    if (body.reportTemplateId !== undefined) {
      if (body.reportTemplateId === null) {
        updates.push('report_template_id = ?');
        binds.push(null);
      } else if (typeof body.reportTemplateId === 'string') {
        const trimmed = body.reportTemplateId.trim();
        if (!REPORT_TEMPLATES[trimmed]) {
          return fail(400, 'validation_failed', '报告模板无效');
        }
        updates.push('report_template_id = ?');
        binds.push(trimmed);
      } else {
        return fail(400, 'validation_failed', 'reportTemplateId 必须是字符串或 null');
      }
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
    if (
      requestedIds.length !== existingIds.size ||
      new Set(requestedIds).size !== existingIds.size ||
      requestedIds.some((id: number) => !existingIds.has(id))
    ) {
      return fail(400, 'validation_failed', 'questionIds 必须与当前题目集合完全一致');
    }
    await normalizeQuestionOrder(db, surveyId, requestedIds);
    const updatedAt = await touchSurvey(db, surveyId);
    return json({ updatedAt });
  }

  // POST /api/admin/surveys/:id/pages — 新增分页
  if (request.method === 'POST' && rest === '/pages') {
    const title = body.title === undefined || body.title === null
      ? null
      : String(body.title).trim();
    if (title !== null && title.length > 200) {
      return fail(400, 'validation_failed', '分页标题长度不能超过 200 字符');
    }
    let description: string | null = null;
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') {
        return fail(400, 'validation_failed', '分页描述必须是字符串');
      }
      description = body.description.trim();
      if (description.length > 1000) {
        return fail(400, 'validation_failed', '分页描述长度不能超过 1000 字符');
      }
    }
    const existing = await listSurveyPages(db, surveyId);
    if (existing.length >= 50) {
      return fail(400, 'validation_failed', '分页数量不能超过 50');
    }
    const pageId = await createSurveyPage(db, {
      surveyId,
      title,
      description,
      order: existing.length,
    });
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      { id: pageId, order: existing.length, updatedAt },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // POST /api/admin/surveys/:id/pages/reorder — 批量重排分页
  if (request.method === 'POST' && rest === '/pages/reorder') {
    if (!Array.isArray(body.pageIds) || body.pageIds.some((value) => !Number.isInteger(value))) {
      return fail(400, 'validation_failed', 'pageIds 必须是整数数组');
    }
    const existing = await listSurveyPages(db, surveyId);
    const existingIds = new Set(existing.map((page) => page.id));
    const requestedIds = body.pageIds.map(Number);
    if (
      requestedIds.length !== existingIds.size ||
      new Set(requestedIds).size !== existingIds.size ||
      requestedIds.some((value) => !existingIds.has(value))
    ) {
      return fail(400, 'validation_failed', 'pageIds 必须与当前分页集合完全一致');
    }
    await normalizePageOrder(db, surveyId, requestedIds);
    const updatedAt = await touchSurvey(db, surveyId);
    return json({ updatedAt });
  }

  const pageMatch = rest.match(/^\/pages\/(\d+)$/);
  if (pageMatch) {
    const pageId = Number(pageMatch[1]);
    const page = await getSurveyPageById(db, pageId);
    if (!page || page.surveyId !== surveyId) {
      return fail(404, 'not_found', '分页不存在');
    }

    if (request.method === 'PATCH') {
      const title =
        body.title === undefined
          ? undefined
          : body.title === null
            ? null
            : String(body.title).trim();
      if (title !== undefined && title !== null && title.length > 200) {
        return fail(400, 'validation_failed', '分页标题长度不能超过 200 字符');
      }
      let description: string | null | undefined;
      if (body.description !== undefined) {
        if (body.description === null) description = null;
        else if (typeof body.description === 'string') {
          description = body.description.trim();
          if (description.length > 1000) {
            return fail(400, 'validation_failed', '分页描述长度不能超过 1000 字符');
          }
        } else return fail(400, 'validation_failed', '分页描述必须是字符串');
      }
      let order: number | undefined;
      if (body.order !== undefined) {
        if (!Number.isInteger(body.order) || Number(body.order) < 0) {
          return fail(400, 'validation_failed', 'order 必须是非负整数');
        }
        order = Number(body.order);
      }
      const pageUpdate: {
        title?: string | null;
        description?: string | null;
        order?: number;
      } = {};
      if (title !== undefined) pageUpdate.title = title;
      if (description !== undefined) pageUpdate.description = description;
      if (order !== undefined) pageUpdate.order = order;
      await updateSurveyPage(db, pageId, pageUpdate);
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }

    if (request.method === 'DELETE') {
      await deleteSurveyPage(db, pageId);
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
  }

  const questionMatch = rest.match(/^\/questions\/(\d+)$/);
  if (questionMatch) {
    const questionId = Number(questionMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, 'not_found', '题目不存在');

    // PATCH — 更新题目字段（保 ID；不改题型）
    if (request.method === 'PATCH') {
      const { payload, error } = validateQuestionPayload(body, false);
      if (error) return fail(400, 'validation_failed', error);
      const targetType = body.type !== undefined
        ? (body.type as QuestionType)
        : question.type;
      if (body.type !== undefined && body.type !== question.type) {
        await updateQuestionType(db, questionId, targetType);
        if (isMatrixQuestionType(question.type) && !isMatrixQuestionType(targetType)) {
          await updateQuestionSettings(db, questionId, null);
        }
        if (isMatrixQuestionType(targetType)) {
          if (!payload!.settingsJson) {
            return fail(400, 'validation_failed', 'matrix 题需要提供 settings.columns');
          }
          await updateQuestionSettings(db, questionId, payload!.settingsJson);
        }
      }
      if (payload!.title) await updateQuestionTitle(db, questionId, payload!.title);
      if (payload!.description !== undefined && body.description !== undefined) {
        await updateQuestionDescription(db, questionId, payload!.description);
      }
      if (payload!.required !== undefined && body.required !== undefined) {
        await updateQuestionRequired(db, questionId, payload!.required);
      }
      if (body.settings !== undefined) {
        if (!isMatrixQuestionType(targetType) && payload!.settingsJson) {
          return fail(400, 'validation_failed', '仅 matrix 题支持 settings');
        }
        await updateQuestionSettings(db, questionId, payload!.settingsJson);
      }
      if (body.validation !== undefined) {
        await updateQuestionValidation(db, questionId, payload!.validationJson);
      }
      if (body.pageId !== undefined) {
        if (body.pageId !== null) {
          const pageId = Number(body.pageId);
          const page = await getSurveyPageById(db, pageId);
          if (!page || page.surveyId !== surveyId) {
            return fail(400, 'validation_failed', 'pageId 无效');
          }
          await updateQuestionPage(db, questionId, pageId);
        } else {
          await updateQuestionPage(db, questionId, null);
        }
      }
      if (body.condition !== undefined) {
        const condition = normalizeQuestionCondition(body.condition);
        if ('error' in condition) {
          return fail(400, 'validation_failed', condition.error);
        }
        await updateQuestionCondition(
          db,
          questionId,
          condition.conditionJson,
          condition.skipToQuestionId,
        );
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

  const duplicateQuestionMatch = rest.match(/^\/questions\/(\d+)\/duplicate$/);
  if (request.method === 'POST' && duplicateQuestionMatch) {
    const questionId = Number(duplicateQuestionMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) {
      return fail(404, 'not_found', '题目不存在');
    }
    const newQuestionId = await duplicateQuestion(db, questionId);
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      { id: newQuestionId, updatedAt },
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

  const duplicateOptionMatch = rest.match(/^\/options\/(\d+)\/duplicate$/);
  if (request.method === 'POST' && duplicateOptionMatch) {
    const optionId = Number(duplicateOptionMatch[1]);
    const option = await getQuestionOptionById(db, optionId);
    if (!option) return fail(404, 'not_found', '选项不存在');
    const question = await getQuestionById(db, option.questionId);
    if (!question || question.surveyId !== surveyId) {
      return fail(404, 'not_found', '选项不存在');
    }
    const newOptionId = await duplicateQuestionOption(db, optionId);
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      { id: newOptionId, updatedAt },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
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
    pageId: payload.pageId,
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
