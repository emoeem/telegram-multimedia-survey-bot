import { getUserById } from "../../db/repositories/user.repository";
import { readCachedJson, writeCachedJson } from "../../services/kv-cache.service";
import { listAuditLogs } from "../../db/repositories/audit.repository";
import { getSurveyById } from "../../db/repositories/survey.repository";
import { listReportDeliveries } from "../../db/repositories/report-delivery.repository";
import { listPlazaComments } from "../../db/repositories/plaza-comment.repository";
import { listTaskPacks } from "../../db/repositories/task-pack.repository";
import { buildMediaResponse } from "../../services/media/media-serve.service";
import { listPlazaPosts } from "../../db/repositories/plaza-post.repository";
import { buildCsv, getExportRows, serializeExport } from "../../services/export.service";
import { exportUnifiedSurveyJson } from "../../services/survey-json.service";
import type { Env } from "../../index";
import { normalizeSurveyTheme, SURVEY_THEME_PRESETS } from "../../survey/theme";
import {
  diffSurveyVersions,
  getSurveyVersionSnapshot,
  listSurveyVersions,
} from "../../services/survey-version.service";
import { REPORT_TEMPLATES } from "../../services/report/template";
import { loadSystemSettings } from "../../services/system-settings.service";
import {
  getCompletionTimeBuckets,
  getNumericStatistics,
  getOptionStatistics,
  getSurveyStatistics,
} from "../../services/statistics.service";
import { downloadTelegramFile } from "../../bot/telegram";
import {
  ADMIN_DASHBOARD_CACHE_TTL_SECONDS,
  ADMIN_DASHBOARD_CACHE_VERSION,
  DASHBOARD_TZ_OFFSET,
  RESPONSE_STATUSES,
  ReadContext,
  ResponseParticipantRow,
  adminProfileItem,
  formatAdminAnswer,
  loadReadableSurvey,
  mapResponseParticipant,
  parseSettingsJson,
  positiveInteger,
  rawStoredAnswer,
  responseStatusLabel,
} from "./helpers";
import { listUserDirectory, listUserResponses, listUserTags } from "../../db/repositories/user.repository";
import { getCustomReportTemplate, listCustomReportTemplates } from "../../db/repositories/report-template.repository";
import { getMediaAssetById } from "../../db/repositories/media.repository";
import { listProfileGalleryItems } from "../../services/profile-gallery.service";
import { listOptionsForQuestions, listQuestionsBySurvey } from "../../db/repositories/question.repository";
import { getSurveyResultRuleSet } from "../../db/repositories/result-profile.repository";

export async function handleAdminRead(url: URL, env: Env, ctx: ReadContext): Promise<Response> {
  const { user, isAdmin, fail, json } = ctx;

  const resultRulesMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/result-rules$/);
  if (resultRulesMatch) {
    const surveyId = Number(resultRulesMatch[1]);
    const survey = await getSurveyById(env.DB, surveyId);
    if (!survey) return fail(404, "not_found", "问卷不存在");
    if (!isAdmin && survey.ownerId !== user.id) return fail(403, "forbidden", "无权访问该问卷");
    const ruleSet = await getSurveyResultRuleSet(env.DB, surveyId);
    return json({ ruleSet: ruleSet ? JSON.parse(ruleSet.rulesJson) : null });
  }

  if (url.pathname === "/api/admin/dashboard") {
    // Every widget here is a COUNT or GROUP BY over whole tables, so opening
    // the dashboard repeatedly is one of the pricier things an operator can
    // do on a metered plan. The payload is per-owner (admins see everything),
    // so the owner is part of the key, and a few minutes of staleness on a
    // dashboard is a fair trade for the reads.
    const dashboardCacheKey = `admin-dashboard:${ADMIN_DASHBOARD_CACHE_VERSION}:${
      isAdmin ? "admin" : `owner-${user.id}`
    }`;
    const cachedDashboard = await readCachedJson<Record<string, unknown>>(env.CACHE, dashboardCacheKey);
    if (cachedDashboard) return json(cachedDashboard);

    // Unqualified owner_id on purpose: the count subqueries select from a bare
    // "surveys" table (no alias), unlike the JOIN queries below.
    const ownerClause = isAdmin ? "" : " WHERE owner_id = ?";
    const bind = isAdmin ? [] : [user.id];
    const [counts, recent, responses, deliveries, recentActions] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM users) users,
                (SELECT COUNT(*) FROM surveys${ownerClause}) surveys,
                (SELECT COUNT(*) FROM surveys${ownerClause ? ownerClause + " AND" : " WHERE"} status='published') publishedSurveys,
                (SELECT COUNT(*) FROM survey_responses r JOIN surveys s ON s.id=r.survey_id${isAdmin ? "" : " WHERE s.owner_id = ?"}) responses,
                (SELECT COUNT(*) FROM survey_responses r JOIN surveys s ON s.id=r.survey_id
                 WHERE date(r.started_at, '${DASHBOARD_TZ_OFFSET}') = date('now', '${DASHBOARD_TZ_OFFSET}')${
                   isAdmin ? "" : " AND s.owner_id = ?"
                 }) todayResponses`,
      ).bind(...bind, ...bind, ...bind, ...bind),
      env.DB.prepare(
        `SELECT s.id,s.title,s.status,s.updated_at updatedAt FROM surveys s${ownerClause} ORDER BY s.updated_at DESC LIMIT 5`,
      ).bind(...bind),
      env.DB.prepare(
        `SELECT r.id,r.survey_id surveyId,r.status,r.completed_at completedAt,r.updated_at updatedAt,
                r.participant_hash participantKey,s.title,
                u.id userId,u.telegram_user_id telegramUserId,u.username,u.first_name firstName,u.last_name lastName
         FROM survey_responses r
         JOIN surveys s ON s.id=r.survey_id
         LEFT JOIN users u ON u.id=r.user_id
         ${isAdmin ? "" : "WHERE s.owner_id = ?"}
         ORDER BY r.updated_at DESC LIMIT 5`,
      ).bind(...(isAdmin ? [] : [user.id])),
      env.DB.prepare(
        `SELECT rd.status, COUNT(*) count
         FROM report_deliveries rd
         JOIN survey_responses r ON r.id = rd.response_id
         JOIN surveys s ON s.id = r.survey_id
         ${isAdmin ? "" : "WHERE s.owner_id = ?"}
         GROUP BY rd.status`,
      ).bind(...(isAdmin ? [] : [user.id])),
      env.DB.prepare(
        `SELECT a.id, a.action, a.entity_type entityType, a.entity_id entityId, a.created_at createdAt
         FROM audit_logs a
         ORDER BY a.id DESC
         LIMIT 8`,
      ),
    ])) as [D1Result, D1Result, D1Result, D1Result, D1Result];
    const statusCounts: Record<string, number> = {};
    for (const row of (deliveries.results ?? []) as Array<{ status: string; count: number }>) {
      statusCounts[row.status] = Number(row.count ?? 0);
    }
    const recentResponseRows = (responses.results ?? []) as Array<Record<string, unknown>>;
    const dashboard = {
      ...((counts.results?.[0] ?? {}) as object),
      recentSurveys: recent.results ?? [],
      recentResponses: recentResponseRows.map((row) => {
        const participant = mapResponseParticipant(row as ResponseParticipantRow);
        return {
          id: Number(row.id),
          surveyId: Number(row.surveyId),
          status: String(row.status),
          statusLabel: responseStatusLabel(String(row.status)),
          updatedAt: String(row.updatedAt),
          completedAt: row.completedAt === null || row.completedAt === undefined ? null : String(row.completedAt),
          title: String(row.title ?? ""),
          ...participant,
        };
      }),
      reportDeliveries: {
        pending: statusCounts["pending"] ?? 0,
        delivering: statusCounts["delivering"] ?? 0,
        delivered: statusCounts["delivered"] ?? 0,
        failed: statusCounts["failed"] ?? 0,
      },
      recentActions: isAdmin ? (recentActions.results ?? []) : [],
    };
    await writeCachedJson(env.CACHE, dashboardCacheKey, dashboard, ADMIN_DASHBOARD_CACHE_TTL_SECONDS);
    return json(dashboard);
  }

  if (url.pathname === "/api/admin/responses") {
    const status = url.searchParams.get("status") ?? "";
    if (status && !RESPONSE_STATUSES.includes(status as (typeof RESPONSE_STATUSES)[number])) {
      return fail(400, "validation_failed", "答卷状态无效");
    }
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return fail(400, "validation_failed", "from 必须是 YYYY-MM-DD");
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return fail(400, "validation_failed", "to 必须是 YYYY-MM-DD");
    }
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
    const surveyFilter = Number(url.searchParams.get("survey") ?? "");
    const page = positiveInteger(url.searchParams.get("page"), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get("pageSize"), 20));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [isAdmin ? "1=1" : "s.owner_id = ?"];
    const binds: unknown[] = [];
    if (!isAdmin) binds.push(user.id);
    if (status) {
      conditions.push("r.status = ?");
      binds.push(status);
    }
    if (from) {
      conditions.push("date(r.started_at) >= ?");
      binds.push(from);
    }
    if (to) {
      conditions.push("date(r.started_at) <= ?");
      binds.push(to);
    }
    if (Number.isInteger(surveyFilter) && surveyFilter > 0) {
      conditions.push("r.survey_id = ?");
      binds.push(surveyFilter);
    }
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        `(lower(COALESCE(s.title,'')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(u.username,'')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(u.first_name,'')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(u.last_name,'')) LIKE ? ESCAPE '\\'
          OR CAST(r.id AS TEXT) LIKE ? ESCAPE '\\'
          OR CAST(COALESCE(u.telegram_user_id, 0) AS TEXT) LIKE ? ESCAPE '\\')`,
      );
      binds.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const where = conditions.join(" AND ");
    const ownerJoin = isAdmin
      ? "FROM survey_responses r"
      : "FROM survey_responses r JOIN surveys s ON s.id=r.survey_id AND s.owner_id = ?";
    const summaryBinds = isAdmin ? [] : [user.id];
    const [items, count, summaryRows] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT r.id,r.survey_id surveyId,s.title surveyTitle,r.status,r.started_at startedAt,
                r.completed_at completedAt,r.updated_at updatedAt,r.participant_hash participantKey,
                u.id userId,u.telegram_user_id telegramUserId,u.username,u.first_name firstName,u.last_name lastName
         FROM survey_responses r
         JOIN surveys s ON s.id=r.survey_id
         LEFT JOIN users u ON u.id=r.user_id
         WHERE ${where}
         ORDER BY COALESCE(r.completed_at, r.updated_at) DESC, r.id DESC
         LIMIT ? OFFSET ?`,
      ).bind(...binds, pageSize, offset),
      env.DB.prepare(
        `SELECT COUNT(*) count
         FROM survey_responses r
         JOIN surveys s ON s.id=r.survey_id
         LEFT JOIN users u ON u.id=r.user_id
         WHERE ${where}`,
      ).bind(...binds),
      env.DB.prepare(`SELECT r.status, COUNT(*) count ${ownerJoin} GROUP BY r.status`).bind(...summaryBinds),
    ])) as [D1Result, D1Result, D1Result];
    const rows = (items.results ?? []) as Array<Record<string, unknown>>;
    const total = Number((count.results?.[0] as { count?: number })?.count ?? 0);
    const statusSummary: Record<string, number> = {};
    for (const row of summaryRows.results ?? []) {
      const r = row as { status: string; count: number | null };
      statusSummary[r.status] = Number(r.count ?? 0);
    }
    return json({
      items: rows.map((row) => {
        const participant = mapResponseParticipant(row as ResponseParticipantRow);
        return {
          id: Number(row.id),
          surveyId: Number(row.surveyId),
          surveyTitle: String(row.surveyTitle ?? ""),
          status: String(row.status),
          statusLabel: responseStatusLabel(String(row.status)),
          startedAt: String(row.startedAt),
          completedAt: row.completedAt === null || row.completedAt === undefined ? null : String(row.completedAt),
          updatedAt: String(row.updatedAt),
          ...participant,
        };
      }),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      statusSummary,
    });
  }

  if (url.pathname === "/api/admin/surveys") {
    const search = (url.searchParams.get("search") ?? "").trim();
    const status = url.searchParams.get("status") ?? "";
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") ?? 20)));
    const offset = (page - 1) * pageSize;
    const conditions = [isAdmin ? "1=1" : "s.owner_id = ?"];
    const binds: unknown[] = isAdmin ? [] : [user.id];
    if (search) {
      conditions.push("(lower(s.title) LIKE ? OR lower(COALESCE(s.description,'')) LIKE ?)");
      binds.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
    }
    if (status) {
      conditions.push("s.status = ?");
      binds.push(status);
    }
    const where = conditions.join(" AND ");
    const ownerClause = isAdmin ? "" : " WHERE owner_id = ?";
    const summaryBinds = isAdmin ? [] : [user.id];
    const [items, count, summaryRows] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT s.id,s.title,s.description,s.status,s.owner_id ownerId,s.created_at createdAt,s.updated_at updatedAt,COALESCE(m.url, NULL) coverUrl,(SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id=s.id) questionCount,(SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id) responseCount FROM surveys s LEFT JOIN media_assets m ON m.id=s.cover_media_id WHERE ${where} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`,
      ).bind(...binds, pageSize, offset),
      env.DB.prepare(`SELECT COUNT(*) count FROM surveys s WHERE ${where}`).bind(...binds),
      env.DB.prepare(`SELECT status, COUNT(*) count FROM surveys${ownerClause} GROUP BY status`).bind(...summaryBinds),
    ])) as [D1Result, D1Result, D1Result];
    const total = Number((count.results?.[0] as { count?: number })?.count ?? 0);
    const statusSummary = { draft: 0, published: 0, closed: 0, archived: 0 };
    for (const row of summaryRows.results ?? []) {
      const r = row as { status: string; count: number | null };
      if (r.status in statusSummary) {
        statusSummary[r.status as keyof typeof statusSummary] = Number(r.count ?? 0);
      }
    }
    return json({
      items: items.results ?? [],
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      statusSummary,
    });
  }

  if (url.pathname === "/api/admin/users") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看用户目录");
    const search = url.searchParams.get("search") ?? "";
    const tag = url.searchParams.get("tag") ?? "";
    const page = positiveInteger(url.searchParams.get("page"), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get("pageSize"), 20));
    const { items, total } = await listUserDirectory(env.DB, {
      search,
      tag,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }

  if (url.pathname === "/api/admin/report-deliveries") {
    const status = url.searchParams.get("status") ?? "";
    const page = positiveInteger(url.searchParams.get("page"), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get("pageSize"), 20));
    const listInput: {
      status?: string;
      ownerId?: number | null;
      limit: number;
      offset: number;
    } = { ownerId: isAdmin ? null : user.id, limit: pageSize, offset: (page - 1) * pageSize };
    if (status) listInput.status = status;
    const { items, total } = await listReportDeliveries(env.DB, listInput);
    const ownerJoin = isAdmin
      ? ""
      : " JOIN survey_responses r ON r.id = rd.response_id JOIN surveys s ON s.id = r.survey_id AND s.owner_id = ?";
    const summaryRows = await env.DB.prepare(
      `SELECT rd.status, COUNT(*) count FROM report_deliveries rd${ownerJoin} GROUP BY rd.status`,
    )
      .bind(...(isAdmin ? [] : [user.id]))
      .all<{ status: string; count: number | null }>();
    const statusSummary = { pending: 0, delivering: 0, delivered: 0, failed: 0 };
    for (const row of summaryRows.results ?? []) {
      if (row.status in statusSummary) {
        statusSummary[row.status as keyof typeof statusSummary] = Number(row.count ?? 0);
      }
    }
    return json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize), statusSummary });
  }

  if (url.pathname === "/api/admin/report-templates") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看报告模板");
    const custom = await listCustomReportTemplates(env.DB);
    return json({
      templates: [
        ...Object.values(REPORT_TEMPLATES).map((template) => ({
          id: template.id,
          name: template.name,
          theme: template.theme,
          layout: template.layout ?? null,
          renderers: template.renderers,
          isCustom: false,
        })),
        ...custom.map(({ id, name, spec }) => ({
          id,
          name,
          theme: spec.theme,
          layout: spec.layout ?? null,
          renderers: spec.renderers,
          isCustom: true,
        })),
      ],
    });
  }

  if (url.pathname === "/api/admin/audit-logs") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看审计日志");
    const page = positiveInteger(url.searchParams.get("page"), 1);
    const pageSize = Math.min(100, positiveInteger(url.searchParams.get("pageSize"), 50));
    const action = url.searchParams.get("action") ?? "";
    const entityType = url.searchParams.get("entityType") ?? "";
    const { items, total } = await listAuditLogs(env.DB, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      ...(action ? { action } : {}),
      ...(entityType ? { entityType } : {}),
    });
    return json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }

  const adminMediaImageMatch = url.pathname.match(/^\/api\/admin\/media\/(\d+)\/image$/);
  if (adminMediaImageMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看媒体文件");
    const asset = await getMediaAssetById(env.DB, Number(adminMediaImageMatch[1]));
    if (!asset) return fail(404, "not_found", "媒体文件不存在");
    const response = await buildMediaResponse(env, asset);
    return response ?? fail(410, "gone", "媒体文件已被清理");
  }

  if (url.pathname === "/api/admin/profile-gallery") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看个人画廊");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const view = url.searchParams.get("view") === "published" ? "published" : "all";
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
    const system = await loadSystemSettings(env.DB);
    const surveyId = Number(system.profileGallerySurveyId);
    if (!Number.isInteger(surveyId) || surveyId <= 0) {
      return json({ items: [], total: 0, limit, offset, surveyId: null });
    }
    const { items, total, publishedTotal } = await listProfileGalleryItems(env.DB, {
      surveyId,
      publishedOnly: view === "published",
      limit,
      offset,
      search,
    });
    const survey = await env.DB.prepare("SELECT title FROM surveys WHERE id = ? LIMIT 1")
      .bind(surveyId)
      .first<{ title: string }>();
    return json({
      items: items.map((item) => adminProfileItem(item)),
      total,
      publishedTotal,
      limit,
      offset,
      surveyId,
      surveyTitle: survey?.title ?? "",
      search,
    });
  }

  if (url.pathname === "/api/admin/plaza/posts") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理树洞内容");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const view = url.searchParams.get("view") === "published" ? "published" : "all";
    const { items, total } = await listPlazaPosts(env.DB, { limit, offset, view });
    return json({ items, total, limit, offset });
  }

  const adminPostCommentsMatch = url.pathname.match(/^\/api\/admin\/plaza\/posts\/(\d+)\/comments$/);
  if (adminPostCommentsMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理树洞评论");
    const postId = Number(adminPostCommentsMatch[1]);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const view = url.searchParams.get("view") === "published" ? "published" : "all";
    const { items, total } = await listPlazaComments(env.DB, postId, { limit, offset, view });
    return json({ items, total, limit, offset, postId });
  }

  if (url.pathname === "/api/admin/task-packs") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理挑战任务包");
    const packs = await listTaskPacks(env.DB, { withItems: true });
    return json({ packs });
  }

  const profileGalleryMediaMatch = url.pathname.match(/^\/api\/admin\/profile-gallery\/(\d+)\/media\/(\d+)$/);
  if (profileGalleryMediaMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看个人画廊");
    const responseId = Number(profileGalleryMediaMatch[1]);
    const mediaAssetId = Number(profileGalleryMediaMatch[2]);
    const visible = await env.DB.prepare(
      `SELECT 1 FROM gallery_profile_media WHERE response_id = ? AND media_asset_id = ? LIMIT 1`,
    )
      .bind(responseId, mediaAssetId)
      .first();
    if (!visible) return fail(404, "not_found", "个人资料图片不存在");
    const asset = await getMediaAssetById(env.DB, mediaAssetId);
    if (!asset) return fail(404, "not_found", "个人资料图片不存在");
    const response = await buildMediaResponse(env, asset);
    return response ?? fail(410, "gone", "个人资料图片已被清理");
  }

  const templateDetailMatch = url.pathname.match(/^\/api\/admin\/report-templates\/([^/]+)$/);
  if (templateDetailMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看报告模板");
    const id = decodeURIComponent(templateDetailMatch[1] ?? "");
    const system = REPORT_TEMPLATES[id];
    const custom = system ? null : await getCustomReportTemplate(env.DB, id);
    const spec = system ?? custom?.spec;
    if (!spec) return fail(404, "not_found", "模板不存在");
    return json({ template: { ...spec, isCustom: !system } });
  }

  if (url.pathname === "/api/admin/settings") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看系统设置");
    return json({ settings: await loadSystemSettings(env.DB) });
  }

  const userDetailMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userDetailMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可查看用户详情");
    const userId = Number(userDetailMatch[1]);
    const user = await getUserById(env.DB, userId);
    if (!user) return fail(404, "not_found", "用户不存在");
    const page = positiveInteger(url.searchParams.get("page"), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get("pageSize"), 20));
    const [tags, responsePage] = await Promise.all([
      listUserTags(env.DB, userId),
      listUserResponses(env.DB, userId, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    ]);
    const { items: responses, total: responseTotal } = responsePage;
    return json({
      user: {
        id: user.id,
        telegramUserId: user.telegramUserId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        systemRole: user.systemRole,
        bannedAt: user.bannedAt,
        bannedBy: user.bannedBy,
        banReason: user.banReason,
        createdAt: user.createdAt,
      },
      tags,
      responses,
      responsePage: page,
      responsePageSize: pageSize,
      responseTotal,
      responseTotalPages: Math.ceil(responseTotal / pageSize),
    });
  }

  const responseMediaMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/responses\/(\d+)\/media\/(\d+)$/);
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
    )
      .bind(mediaAssetId, responseId, surveyId)
      .first<{
        telegramFileId: string | null;
        mimeType: string | null;
        fileName: string | null;
        fileSize: number | null;
      }>();
    if (!media?.telegramFileId) return fail(404, "not_found", "答卷媒体不存在或不可用");
    if (media.fileSize !== null && media.fileSize > 20 * 1024 * 1024) {
      return fail(413, "media_too_large", "媒体文件超过 20MB，无法在线预览");
    }
    try {
      const downloaded = await downloadTelegramFile(env.BOT_TOKEN, media.telegramFileId);
      if (downloaded.data.byteLength > 20 * 1024 * 1024) {
        return fail(413, "media_too_large", "媒体文件超过 20MB，无法在线预览");
      }
      const contentType = media.mimeType || downloaded.contentType || "application/octet-stream";
      const safeName = (media.fileName || downloaded.filePath.split("/").pop() || `media-${mediaAssetId}`).replace(
        /[\r\n"\\]/g,
        "_",
      );
      const responseBody = new Uint8Array(downloaded.data).buffer;
      return new Response(responseBody, {
        headers: {
          "Cache-Control": "private, max-age=300",
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${safeName}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error("Admin response media download failed", { surveyId, responseId, mediaAssetId, error });
      return fail(502, "media_download_failed", "媒体暂时无法读取，请稍后重试");
    }
  }

  const exportMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/export$/);
  if (exportMatch) {
    const surveyId = Number(exportMatch[1]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const format = url.searchParams.get("format") ?? "csv";
    if (!["csv", "zip", "json"].includes(format)) {
      return fail(400, "validation_failed", "导出格式无效");
    }
    const fileName = `survey-${surveyId}.${format}`;
    if (format === "json") {
      const exported = await exportUnifiedSurveyJson(env.DB, surveyId);
      if (!exported) return fail(404, "not_found", "问卷不存在");
      return new Response(JSON.stringify(exported, null, 2), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const { rows } = await getExportRows(env.DB, surveyId);
    const csv = buildCsv(rows);
    const content = serializeExport(format as "csv" | "zip", csv, rows);
    const contentType = format === "zip" ? "application/zip" : "text/csv; charset=utf-8";
    const body =
      typeof content === "string"
        ? new TextEncoder().encode(`\uFEFF${content}`).buffer
        : new Uint8Array(content).buffer;
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const analyticsMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/analytics$/);
  if (analyticsMatch) {
    const surveyId = Number(analyticsMatch[1]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const [overview, optionStats, numericStats, completionTimeBuckets, statusRows] = await Promise.all([
      getSurveyStatistics(env.DB, surveyId),
      getOptionStatistics(env.DB, surveyId),
      getNumericStatistics(env.DB, surveyId),
      getCompletionTimeBuckets(env.DB, surveyId, 14),
      env.DB.prepare("SELECT status, COUNT(*) count FROM survey_responses WHERE survey_id = ? GROUP BY status")
        .bind(surveyId)
        .all<{ status: string; count: number }>(),
    ]);
    const statusCounts = Object.fromEntries(RESPONSE_STATUSES.map((status) => [status, 0])) as Record<
      (typeof RESPONSE_STATUSES)[number],
      number
    >;
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
      completionTimeBuckets,
    });
  }

  const responseDetailMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/responses\/(\d+)$/);
  if (responseDetailMatch) {
    const surveyId = Number(responseDetailMatch[1]);
    const responseId = Number(responseDetailMatch[2]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const response = await env.DB.prepare(
      `SELECT r.id,r.survey_id,r.user_id,r.status,r.version,r.started_at,r.completed_at,r.submitted_at,r.updated_at,r.participant_hash,
              r.device_fingerprint deviceFingerprint, r.browser_info browserInfo, r.ip_address ipAddress,
              u.telegram_user_id,u.username,u.first_name,u.last_name
       FROM survey_responses r
       LEFT JOIN users u ON u.id=r.user_id
       WHERE r.id=? AND r.survey_id=?`,
    )
      .bind(responseId, surveyId)
      .first<Record<string, unknown>>();
    if (!response) return fail(404, "not_found", "答卷不存在");
    const adjacent = await env.DB.prepare(
      `SELECT
         (SELECT id FROM survey_responses WHERE survey_id = ? AND id < ? ORDER BY id DESC LIMIT 1) previousResponseId,
         (SELECT id FROM survey_responses WHERE survey_id = ? AND id > ? ORDER BY id ASC LIMIT 1) nextResponseId`,
    )
      .bind(surveyId, responseId, surveyId, responseId)
      .first<{ previousResponseId: number | null; nextResponseId: number | null }>();

    const questions = await listQuestionsBySurvey(env.DB, surveyId);
    const options = await listOptionsForQuestions(
      env.DB,
      questions.map((question) => question.id),
    );
    const [answerRows, selectedRows, mediaRows] = (await env.DB.batch([
      env.DB.prepare("SELECT * FROM answers WHERE response_id = ? ORDER BY id ASC").bind(responseId),
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
      D1Result<{
        answerId: number;
        mediaAssetId: number;
        mediaType: string;
        fileName: string | null;
        mimeType: string | null;
      }>,
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
        version: Number(response.version ?? 0),
        startedAt: String(response.started_at),
        completedAt: response.completed_at === null ? null : String(response.completed_at),
        submittedAt: response.submitted_at === null ? null : String(response.submitted_at),
        updatedAt: String(response.updated_at),
        respondent:
          response.telegram_user_id === null
            ? null
            : {
                userId: Number(response.user_id ?? 0),
                telegramUserId: Number(response.telegram_user_id),
                username: response.username === null ? null : String(response.username),
                firstName: response.first_name === null ? null : String(response.first_name),
                lastName: response.last_name === null ? null : String(response.last_name),
              },
        participantKey:
          response.telegram_user_id === null
            ? response.participant_hash === null
              ? null
              : String(response.participant_hash)
            : null,
        deviceFingerprint: response.deviceFingerprint === null ? null : String(response.deviceFingerprint),
        browserInfo: response.browserInfo === null ? null : String(response.browserInfo),
        ipAddress: response.ipAddress === null ? null : String(response.ipAddress),
        previousResponseId: adjacent?.previousResponseId == null ? null : Number(adjacent.previousResponseId),
        nextResponseId: adjacent?.nextResponseId == null ? null : Number(adjacent.nextResponseId),
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
          value: answer ? formatAdminAnswer(answer, question, selectedByAnswer.get(answerId!) ?? [], optionLabels) : "",
          raw: answer ? rawStoredAnswer(answer) : null,
          media: answerId === null ? [] : (mediaByAnswer.get(answerId) ?? []),
        };
      }),
    });
  }

  const responsesMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/responses$/);
  if (responsesMatch) {
    const surveyId = Number(responsesMatch[1]);
    const survey = await loadReadableSurvey(env, ctx, surveyId);
    if (survey instanceof Response) return survey;
    const status = url.searchParams.get("status") ?? "";
    if (status && !RESPONSE_STATUSES.includes(status as (typeof RESPONSE_STATUSES)[number])) {
      return fail(400, "validation_failed", "答卷状态无效");
    }
    const page = positiveInteger(url.searchParams.get("page"), 1);
    const pageSize = Math.min(50, positiveInteger(url.searchParams.get("pageSize"), 20));
    const offset = (page - 1) * pageSize;
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return fail(400, "validation_failed", "from 必须是 YYYY-MM-DD");
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return fail(400, "validation_failed", "to 必须是 YYYY-MM-DD");
    }
    const statusClause = status ? " AND r.status=?" : "";
    const dateClause = `${from ? " AND date(r.started_at) >= ?" : ""}${to ? " AND date(r.started_at) <= ?" : ""}`;
    const binds: unknown[] = [surveyId, ...(status ? [status] : []), ...(from ? [from] : []), ...(to ? [to] : [])];
    const [items, count] = (await env.DB.batch([
      env.DB.prepare(
        `SELECT r.id,r.status,r.started_at startedAt,r.completed_at completedAt,r.updated_at updatedAt,
                r.participant_hash participantKey,
                u.id userId,u.telegram_user_id telegramUserId,u.username,u.first_name firstName,u.last_name lastName
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
        respondent:
          item.telegramUserId === null
            ? null
            : {
                userId: Number(item.userId ?? 0),
                telegramUserId: Number(item.telegramUserId),
                username: item.username === null ? null : String(item.username),
                firstName: item.firstName === null ? null : String(item.firstName),
                lastName: item.lastName === null ? null : String(item.lastName),
              },
        participantKey:
          item.telegramUserId === null ? (item.participantKey === null ? null : String(item.participantKey)) : null,
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
    if (!survey) return fail(404, "not_found", "问卷不存在");
    if (!isAdmin && survey.ownerId !== user.id) return fail(403, "forbidden", "无权访问此问卷");
    const responseCountRow = await env.DB.prepare("SELECT COUNT(*) count FROM survey_responses WHERE survey_id = ?")
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
        "SELECT qm.question_id questionId, m.id mediaAssetId, m.media_type mediaType, m.file_name fileName, m.mime_type mimeType FROM question_media qm JOIN media_assets m ON m.id = qm.media_asset_id WHERE qm.question_id IN (SELECT id FROM survey_questions WHERE survey_id = ?) ORDER BY qm.question_id, qm.sort_order, m.id",
      ).bind(id),
      env.DB.prepare(
        "SELECT om.question_option_id optionId, m.id mediaAssetId, m.media_type mediaType, m.file_name fileName, m.mime_type mimeType FROM option_media om JOIN media_assets m ON m.id = om.media_asset_id JOIN question_options o ON o.id = om.question_option_id WHERE o.question_id IN (SELECT id FROM survey_questions WHERE survey_id = ?) ORDER BY om.question_option_id, om.sort_order, m.id",
      ).bind(id),
    ])) as [
      D1Result<{
        questionId: number;
        mediaAssetId: number;
        mediaType: string;
        fileName: string | null;
        mimeType: string | null;
      }>,
      D1Result<{
        optionId: number;
        mediaAssetId: number;
        mediaType: string;
        fileName: string | null;
        mimeType: string | null;
      }>,
    ];
    const questionMediaByQuestion = new Map<
      number,
      { mediaAssetId: number; mediaType: string; fileName: string | null; mimeType: string | null }[]
    >();
    for (const row of questionMedia.results ?? []) {
      const list = questionMediaByQuestion.get(row.questionId) ?? [];
      list.push({
        mediaAssetId: row.mediaAssetId,
        mediaType: row.mediaType,
        fileName: row.fileName,
        mimeType: row.mimeType,
      });
      questionMediaByQuestion.set(row.questionId, list);
    }
    const optionMediaByOption = new Map<
      number,
      { mediaAssetId: number; mediaType: string; fileName: string | null; mimeType: string | null }[]
    >();
    for (const row of optionMedia.results ?? []) {
      const list = optionMediaByOption.get(row.optionId) ?? [];
      list.push({
        mediaAssetId: row.mediaAssetId,
        mediaType: row.mediaType,
        fileName: row.fileName,
        mimeType: row.mimeType,
      });
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
        editable: survey.status === "draft" && responseCount === 0,
      },
      pages:
        (
          await env.DB.prepare(
            `SELECT id, title, description, "order"
         FROM survey_pages
         WHERE survey_id = ?
         ORDER BY "order" ASC, id ASC`,
          )
            .bind(id)
            .all<{
              id: number;
              title: string | null;
              description: string | null;
              order: number;
            }>()
        ).results ?? [],
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

  const versionCompareMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/versions\/(\d+)\/compare\/(\d+)$/);
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
    if (!from || !to) return fail(404, "version_not_found", "版本不存在");
    return json({ fromVersion, toVersion, diff: diffSurveyVersions(from, to) });
  }

  const versionDetailMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)\/versions\/(\d+)$/);
  if (versionDetailMatch) {
    const id = Number(versionDetailMatch[1]);
    const version = Number(versionDetailMatch[2]);
    const survey = await loadReadableSurvey(env, ctx, id);
    if (survey instanceof Response) return survey;
    const snapshot = await getSurveyVersionSnapshot(env.DB, id, version);
    if (!snapshot) return fail(404, "version_not_found", "版本不存在");
    return json({ version, survey: snapshot.survey });
  }

  const match = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    const survey = await env.DB.prepare(
      "SELECT s.*, u.username, u.first_name firstName, COALESCE(m.url, NULL) coverUrl, (SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id=s.id) questionCount, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id) responseCount, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id AND r.status='completed') completedCount FROM surveys s JOIN users u ON u.id=s.owner_id LEFT JOIN media_assets m ON m.id=s.cover_media_id WHERE s.id=?",
    )
      .bind(id)
      .first<Record<string, unknown>>();
    if (!survey) return fail(404, "not_found", "问卷不存在");
    if (!isAdmin && survey.owner_id !== user.id) return fail(403, "forbidden", "无权访问此问卷");
    let theme: ReturnType<typeof normalizeSurveyTheme> = null;
    try {
      theme = normalizeSurveyTheme(parseSettingsJson(String(survey.settings_json ?? "")));
    } catch {
      theme = null;
    }
    return json({
      ...survey,
      settings_json: undefined,
      theme,
      themePresets: SURVEY_THEME_PRESETS,
      isAdmin,
    });
  }

  return fail(404, "not_found", "Not found");
}
