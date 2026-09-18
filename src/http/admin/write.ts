import { createSurvey, getSurveyById } from "../../db/repositories/survey.repository";
import {
  createTaskPack,
  deleteTaskPack,
  listTaskPacks,
  updateTaskPack,
} from "../../db/repositories/task-pack.repository";
import { hasActiveCreatorTrial } from "../../db/repositories/creator-trial.repository";
import { fetchZohoFormsSurveyJson, isZohoUrl, ZohoImportError } from "../../services/zoho-forms.service";
import { createImportMediaResolver } from "../../services/import-media.service";
import { ImportValidationError, parseImportedSurvey, saveImportedSurvey } from "../../services/import.service";
import type { Env } from "../../index";
import { REPORT_TEMPLATES } from "../../services/report/template";
import { saveSystemSetting, SYSTEM_SETTING_KEYS } from "../../services/system-settings.service";
import { hashAdminPassword, isValidAdminPassword, ADMIN_PASSWORD_SETTING_KEY } from "../../services/admin-password.service";
import { cleanImportText } from "../../services/text-cleaner";
import { handleAdminSurveysWrite } from "./surveys";
import { handleAdminEditorWrite } from "./editor";
import { handleAdminReportsWrite } from "./reports";
import { handleAdminCommunityWrite } from "./community";
import { handleAdminTemplatesWrite } from "./templates";
import { handleAdminUsersWrite } from "./users";
import { handleAdminLicensesWrite } from "./licenses";
import {
  IMPORT_MAX_BYTES,
  QuestionPayload,
  WriteContext,
  buildImportSummary,
  insertQuestionWithOptions,
  isRecord,
  readJsonBody,
  readString,
  touchSurvey,
  validateQuestionPayload,
  writeAudit,
} from "./helpers";
import {
  FormsImportError,
  fetchMicrosoftFormsCover,
  fetchMicrosoftFormsSurveyJson,
  isFormsUrl,
} from "../../services/microsoft-forms.service";
import { createMediaAsset } from "../../db/repositories/media.repository";

export async function handleAdminWrite(request: Request, url: URL, env: Env, ctx: WriteContext): Promise<Response> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  // Media upload endpoints send multipart/form-data; the file is parsed at the
  // endpoint itself, so skip the JSON body reader for those requests.
  const contentTypeHeader = request.headers.get("content-type") ?? "";
  const isMultipart = contentTypeHeader.toLowerCase().includes("multipart/form-data");
  let body: Record<string, unknown> | null = {};
  if (!isMultipart) {
    body = await readJsonBody(request);
    if (body === null) return fail(400, "invalid_body", "请求体必须是 JSON 对象");
  }

  const reportResponse = await handleAdminReportsWrite(request, url, env, ctx, body);
  if (reportResponse) return reportResponse;

  const communityResponse = await handleAdminCommunityWrite(request, url, env, ctx, body);
  if (communityResponse) return communityResponse;

  if (request.method === "PUT" && url.pathname === "/api/admin/settings") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可修改系统设置");
    const updates: Record<string, string> = {};
    const newAdminPassword = typeof body.admin_password === "string" ? body.admin_password : "";
    if (body.admin_password !== undefined && !isValidAdminPassword(newAdminPassword)) return fail(400, "validation_failed", "管理员密码长度必须为 8-256 个字符");
    for (const key of SYSTEM_SETTING_KEYS) {
      if (body[key] === undefined) continue;
      const value = String(body[key]).trim();
      if (key === "default_report_template" && value && !REPORT_TEMPLATES[value]) {
        return fail(400, "validation_failed", "默认报告模板无效");
      }
      if (key === "profile_gallery_survey_id" && value) {
        const surveyId = Number(value);
        if (!Number.isInteger(surveyId) || surveyId <= 0) {
          return fail(400, "validation_failed", "个人画廊问卷必须是有效的问卷编号");
        }
      }
      if (
        key === "media_ttl_seconds" ||
        key === "max_upload_mb" ||
        key === "max_response_media_mb" ||
        key === "pdf_max_mb"
      ) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          return fail(400, "validation_failed", `${key} 必须是正数`);
        }
      }
      updates[key] = value;
    }
    if (newAdminPassword) {
      updates[ADMIN_PASSWORD_SETTING_KEY] = await hashAdminPassword(newAdminPassword);
    }
    if (!Object.keys(updates).length) {
      return fail(400, "validation_failed", "没有可更新的设置");
    }
    for (const [key, value] of Object.entries(updates)) {
      await saveSystemSetting(db, key, value, user.id);
    }
    await writeAudit(db, {
      actorUserId: user.id,
      action: "settings.update",
      entityType: "settings",
      after: Object.keys(updates),
    });
    return json({ ok: true, updated: Object.keys(updates) });
  }

  const templateResponse = await handleAdminTemplatesWrite(request, url, env, ctx, body);
  if (templateResponse) return templateResponse;

  const userResponse = await handleAdminUsersWrite(request, url, env, ctx, body);
  if (userResponse) return userResponse;

  if (request.method === "POST" && url.pathname === "/api/admin/imports/from-url") {
    if (!isAdmin && !(await hasActiveCreatorTrial(db, user.id))) {
      return fail(403, "creator_trial_required", "需要有效的创作者权限才能导入问卷。");
    }
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return fail(400, "invalid_url", "请输入有效的 http/https URL");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return fail(400, "invalid_url", "仅支持 http/https URL");
    }
    const source = isFormsUrl(rawUrl) ? "microsoft_forms" : isZohoUrl(rawUrl) ? "zoho_forms" : null;
    if (!source) {
      return fail(
        400,
        "unsupported_in_worker",
        "当前支持 Microsoft Forms 和 Zoho Forms 链接在线导入。PDF / Word / Excel / PowerPoint 文档请在本地运行：\n" +
          'uv run python scripts/import_survey_from_url.py "<URL>"\n' +
          "然后把生成的 survey.json 粘贴到下方文本框完成导入。",
      );
    }
    let content: string;
    try {
      content =
        source === "microsoft_forms"
          ? await fetchMicrosoftFormsSurveyJson(rawUrl)
          : await fetchZohoFormsSurveyJson(rawUrl);
    } catch (error) {
      if (error instanceof FormsImportError || error instanceof ZohoImportError) {
        const status =
          error.code === "DOCUMENT_REQUIRES_AUTH"
            ? 401
            : error.code === "HTTP_404"
              ? 404
              : error.code === "DOCUMENT_TOO_LARGE"
                ? 413
                : error.code === "NETWORK_ERROR"
                  ? 502
                  : 422;
        return fail(status, error.code, error.message);
      }
      console.error("Microsoft Forms URL import failed", { url: rawUrl, error });
      return fail(502, "network_error", "获取 Microsoft Forms 问卷失败，请稍后重试。");
    }
    let imported: ReturnType<typeof parseImportedSurvey>;
    try {
      imported = parseImportedSurvey(content);
    } catch (error) {
      if (error instanceof ImportValidationError) {
        return Response.json(
          {
            ok: false,
            code: "invalid_import",
            message: error.message,
            issues: error.issues,
            requestId: ctx.requestId,
          },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      return fail(400, "invalid_import", error instanceof Error ? error.message : "问卷 JSON 无效");
    }
    const summary = buildImportSummary(imported);
    return json({
      ok: true,
      content,
      source,
      ...summary,
    });
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/api/admin/imports/validate" || url.pathname === "/api/admin/imports")
  ) {
    if (!isAdmin && !(await hasActiveCreatorTrial(db, user.id))) {
      return fail(403, "creator_trial_required", "需要有效的创作者权限才能导入问卷。");
    }
    if (typeof body.content !== "string" || !body.content.trim()) {
      return fail(400, "validation_failed", "请选择 JSON 文件或粘贴 JSON 内容");
    }
    if (new TextEncoder().encode(body.content).byteLength > IMPORT_MAX_BYTES) {
      return fail(413, "import_too_large", "导入文件不能超过 40MB");
    }
    let imported: ReturnType<typeof parseImportedSurvey>;
    try {
      imported = parseImportedSurvey(body.content);
    } catch (error) {
      if (error instanceof ImportValidationError) {
        return Response.json(
          {
            ok: false,
            code: "invalid_import",
            message: error.message,
            issues: error.issues,
            requestId: ctx.requestId,
          },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      return fail(400, "invalid_import", error instanceof Error ? error.message : "JSON 导入内容无效");
    }
    if (body.reportTemplateId !== undefined && body.reportTemplateId !== null) {
      if (typeof body.reportTemplateId !== "string" || !REPORT_TEMPLATES[body.reportTemplateId.trim()]) {
        return fail(400, "validation_failed", "报告模板不存在");
      }
      imported.settings = {
        anonymous: imported.settings?.anonymous ?? false,
        allowMultipleResponses: imported.settings?.allowMultipleResponses ?? false,
        maxResponsesPerUser: imported.settings?.maxResponsesPerUser ?? 1,
        ...(imported.settings?.reportTemplateId ? { reportTemplateId: imported.settings.reportTemplateId } : {}),
        ...(imported.settings?.theme !== undefined ? { theme: imported.settings.theme } : {}),
        reportTemplateId: body.reportTemplateId.trim(),
      };
    }
    const summary = buildImportSummary(imported);
    if (url.pathname.endsWith("/validate")) return json(summary);
    try {
      const id = await saveImportedSurvey(db, user.id, imported, createImportMediaResolver(env));
      await writeAudit(db, {
        actorUserId: user.id,
        action: "survey.import",
        entityType: "survey",
        entityId: String(id),
        after: { title: imported.title, questionCount: imported.questions.length },
      });
      return Response.json({ id, ...summary }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("Admin survey import failed", { userId: user.id, error });
      return fail(500, "import_failed", "导入保存失败，未完成的数据已回滚");
    }
  }

  // POST /api/admin/surveys — 创建草稿问卷（可带初始题目）
  if (request.method === "POST" && url.pathname === "/api/admin/surveys") {
    if (!isAdmin && !(await hasActiveCreatorTrial(db, user.id))) {
      return fail(403, "creator_trial_required", "需要有效的创作者权限才能创建问卷。");
    }
    const titleError = readString(body.title, "标题", 200);
    if (titleError) return fail(400, "validation_failed", titleError);
    let description: string | null = null;
    if (typeof body.description === "string" && body.description.trim()) {
      if (body.description.length > 1000) return fail(400, "validation_failed", "描述长度不能超过 1000 字符");
      description = body.description.trim();
    }
    const anonymous = body.anonymous === true;
    const allowMultipleResponses = body.allowMultipleResponses === true;
    const maxResponsesPerUser = body.maxResponsesPerUser === undefined ? 1 : Number(body.maxResponsesPerUser);
    if (!Number.isInteger(maxResponsesPerUser) || maxResponsesPerUser < 0 || maxResponsesPerUser > 999) {
      return fail(400, "validation_failed", "填写次数上限必须是 0-999 的整数");
    }
    const questions: QuestionPayload[] = [];
    if (body.questions !== undefined) {
      if (!Array.isArray(body.questions)) return fail(400, "validation_failed", "questions 必须是数组");
      for (const item of body.questions) {
        if (!isRecord(item)) return fail(400, "validation_failed", "题目必须是对象");
        const { payload, error } = validateQuestionPayload(item, true);
        if (error) return fail(400, "validation_failed", error);
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
      action: "survey.create",
      entityType: "survey",
      entityId: String(survey.id),
      after: { title: survey.title, questionCount: questions.length },
    });
    return Response.json({ id: survey.id, updatedAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  const licenseResponse = await handleAdminLicensesWrite(request, url, env, ctx, body);
  if (licenseResponse) return licenseResponse;

  // POST /api/admin/surveys/backfill-covers — 批量给已有问卷补封面
  // （只更新封面，不动题目和答卷）。
  if (request.method === "POST" && url.pathname === "/api/admin/system/repair-text") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可修复问卷文本");
    const dryRun = body.dryRun === true;
    const since = typeof body.since === "string" && body.since.length ? body.since : null;

    const timestamp = new Date().toISOString();
    const stats = {
      surveys: { scanned: 0, fixed: 0 },
      pages: { scanned: 0, fixed: 0 },
      questions: { scanned: 0, fixed: 0 },
      options: { scanned: 0, fixed: 0 },
      optionDuplicates: 0,
    };
    const changes: string[] = [];

    const surveysSql = `SELECT id, title, description FROM surveys ${since ? "WHERE updated_at >= ?" : ""}`;
    const surveysRows =
      (
        await db
          .prepare(surveysSql)
          .bind(...(since ? [since] : []))
          .all<{ id: number; title: string; description: string | null }>()
      ).results ?? [];
    for (const row of surveysRows) {
      stats.surveys.scanned++;
      let dirty = false;
      const newTitle = cleanImportText(row.title);
      const newDesc = row.description !== null ? cleanImportText(row.description) : null;
      if (newTitle !== row.title) {
        dirty = true;
        changes.push(`surveys#${row.id}.title: [${row.title.slice(0, 40)}] → [${newTitle.slice(0, 40)}]`);
      }
      if ((newDesc ?? null) !== (row.description ?? null)) {
        dirty = true;
        changes.push(`surveys#${row.id}.description changed`);
      }
      if (dirty && !dryRun) {
        await db
          .prepare("UPDATE surveys SET title = ?, description = ?, updated_at = ? WHERE id = ?")
          .bind(newTitle, newDesc, timestamp, row.id)
          .run();
        stats.surveys.fixed++;
      } else if (dirty) {
        stats.surveys.fixed++;
      }
    }

    const pagesSql = `SELECT id, title, description FROM survey_pages ${since ? "WHERE updated_at >= ?" : ""}`;
    const pagesRows =
      (
        await db
          .prepare(pagesSql)
          .bind(...(since ? [since] : []))
          .all<{ id: number; title: string | null; description: string | null }>()
      ).results ?? [];
    for (const row of pagesRows) {
      stats.pages.scanned++;
      let dirty = false;
      const newTitle = row.title !== null ? cleanImportText(row.title) : null;
      const newDesc = row.description !== null ? cleanImportText(row.description) : null;
      if ((newTitle ?? null) !== (row.title ?? null)) {
        dirty = true;
        changes.push(`survey_pages#${row.id}.title changed`);
      }
      if ((newDesc ?? null) !== (row.description ?? null)) {
        dirty = true;
        changes.push(`survey_pages#${row.id}.description changed`);
      }
      if (dirty && !dryRun) {
        await db
          .prepare("UPDATE survey_pages SET title = ?, description = ?, updated_at = ? WHERE id = ?")
          .bind(newTitle, newDesc, timestamp, row.id)
          .run();
        stats.pages.fixed++;
      } else if (dirty) {
        stats.pages.fixed++;
      }
    }

    const questionsSql = `SELECT id, title, description FROM survey_questions ${since ? "WHERE updated_at >= ?" : ""}`;
    const questionsRows =
      (
        await db
          .prepare(questionsSql)
          .bind(...(since ? [since] : []))
          .all<{ id: number; title: string; description: string | null }>()
      ).results ?? [];
    for (const row of questionsRows) {
      stats.questions.scanned++;
      let dirty = false;
      const newTitle = cleanImportText(row.title);
      const newDesc = row.description !== null ? cleanImportText(row.description) : null;
      if (newTitle !== row.title) {
        dirty = true;
        changes.push(`survey_questions#${row.id}.title: [${row.title.slice(0, 40)}] → [${newTitle.slice(0, 40)}]`);
      }
      if ((newDesc ?? null) !== (row.description ?? null)) {
        dirty = true;
        changes.push(`survey_questions#${row.id}.description changed`);
      }
      if (dirty && !dryRun) {
        await db
          .prepare("UPDATE survey_questions SET title = ?, description = ?, updated_at = ? WHERE id = ?")
          .bind(newTitle, newDesc, timestamp, row.id)
          .run();
        stats.questions.fixed++;
      } else if (dirty) {
        stats.questions.fixed++;
      }
    }

    const optionsSql = `SELECT id, question_id, label, value FROM question_options ${since ? "WHERE updated_at >= ?" : ""}`;
    const optionsRows =
      (
        await db
          .prepare(optionsSql)
          .bind(...(since ? [since] : []))
          .all<{ id: number; question_id: number; label: string; value: string }>()
      ).results ?? [];
    for (const row of optionsRows) {
      stats.options.scanned++;
      let dirty = false;
      const newLabel = cleanImportText(row.label);
      const newValue = cleanImportText(row.value);
      if (newLabel !== row.label) {
        dirty = true;
        changes.push(`question_options#${row.id}.label: [${row.label.slice(0, 40)}] → [${newLabel.slice(0, 40)}]`);
      }
      if (newValue !== row.value) {
        dirty = true;
        changes.push(`question_options#${row.id}.value: [${row.value.slice(0, 40)}] → [${newValue.slice(0, 40)}]`);
      }
      if (dirty && !dryRun) {
        await db
          .prepare("UPDATE question_options SET label = ?, value = ?, updated_at = ? WHERE id = ?")
          .bind(newLabel, newValue, timestamp, row.id)
          .run();
        stats.options.fixed++;
      } else if (dirty) {
        stats.options.fixed++;
      }
    }

    if (!dryRun) {
      await writeAudit(db, {
        actorUserId: user.id,
        action: "system.repair_text",
        entityType: "system",
        entityId: "text",
        before: { dryRun, since },
        after: stats,
      });
    }

    return json({ dryRun, stats, sampleChanges: changes.slice(0, 30) });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/surveys/backfill-covers") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可批量补封面");
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > 50) {
      return fail(400, "validation_failed", "items 必须是 1-50 项的数组");
    }
    const resolver = createImportMediaResolver(env);
    const results: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const record = item as Record<string, unknown>;
      const surveyId = Number(record.surveyId);
      const rawUrl = typeof record.url === "string" ? record.url.trim() : "";
      if (!Number.isInteger(surveyId) || surveyId <= 0) {
        results.push({ surveyId, ok: false, error: "invalid_survey_id" });
        continue;
      }
      const survey = await getSurveyById(db, surveyId);
      if (!survey) {
        results.push({ surveyId, ok: false, error: "not_found" });
        continue;
      }
      try {
        const cover = await fetchMicrosoftFormsCover(rawUrl);
        if (!cover) {
          results.push({ surveyId, ok: false, error: "no_cover" });
          continue;
        }
        const resolved = await resolver({
          type: "photo",
          source: "url",
          url: cover.url,
          ...(cover.mimeType ? { mimeType: cover.mimeType } : {}),
          ...(cover.fileName ? { fileName: cover.fileName } : {}),
          ...(cover.width !== undefined ? { width: cover.width } : {}),
          ...(cover.height !== undefined ? { height: cover.height } : {}),
        });
        const asset = await createMediaAsset(db, {
          scope: "survey",
          mediaType: "photo",
          storageKind: resolved?.storageKey ? (resolved.storageKind ?? "url") : "url",
          storageKey: resolved?.storageKey ?? null,
          url: resolved?.storageKey ? null : cover.url,
          mimeType: resolved?.mimeType ?? cover.mimeType ?? null,
          fileName: resolved?.fileName ?? cover.fileName ?? null,
          fileSize: resolved?.size ?? null,
          width: resolved?.width ?? cover.width ?? null,
          height: resolved?.height ?? cover.height ?? null,
        });
        const timestamp = new Date().toISOString();
        await db
          .prepare("UPDATE surveys SET cover_media_id = ?, updated_at = ? WHERE id = ?")
          .bind(asset.id, timestamp, surveyId)
          .run();
        await writeAudit(db, {
          actorUserId: user.id,
          action: "survey.cover_backfill",
          entityType: "survey",
          entityId: String(surveyId),
          after: { mediaAssetId: asset.id },
        });
        results.push({ surveyId, ok: true, mediaAssetId: asset.id });
      } catch (error) {
        results.push({
          surveyId,
          ok: false,
          error: error instanceof Error ? error.message : "backfill_failed",
        });
      }
    }
    return json({ results });
  }

  // ---- 挑战任务包（trial task packs）管理 ----
  const taskPackMatch = url.pathname.match(/^\/api\/admin\/task-packs\/(\d+)$/);

  if (request.method === "POST" && url.pathname === "/api/admin/task-packs") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理挑战任务包");
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return fail(400, "validation_failed", "任务包名称不能为空");
    const createInput: {
      name: string;
      description?: string | null;
      normalFloors?: number;
      hellFloors?: number;
      prepItems?: string[];
      prepText?: string | null;
      items?: unknown[];
    } = {
      name,
      description: typeof body.description === "string" ? body.description.slice(0, 300) : null,
      items: Array.isArray(body.items) ? body.items : [],
    };
    if (typeof body.normalFloors === "number") createInput.normalFloors = body.normalFloors;
    if (typeof body.hellFloors === "number") createInput.hellFloors = body.hellFloors;
    if (Array.isArray(body.prepItems)) {
      createInput.prepItems = body.prepItems
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 60))
        .slice(0, 12);
    }
    if (typeof body.prepText === "string") createInput.prepText = body.prepText.slice(0, 300);
    else if (body.prepText === null) createInput.prepText = null;
    const pack = await createTaskPack(db, createInput);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "task_pack.create",
      entityType: "task_pack",
      entityId: String(pack.id),
      after: { name: pack.name, normalFloors: pack.normalFloors, hellFloors: pack.hellFloors },
    });
    return json({ pack });
  }

  if ((request.method === "PUT" || request.method === "PATCH") && taskPackMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理挑战任务包");
    const packId = Number(taskPackMatch[1]);
    const existing = await listTaskPacks(db, { withItems: true }).then((packs) =>
      packs.find((pack) => pack.id === packId),
    );
    if (!existing) return fail(404, "not_found", "任务包不存在");
    const updateInput: {
      name?: string;
      description?: string | null;
      normalFloors?: number;
      hellFloors?: number;
      prepItems?: string[];
      prepText?: string | null;
      enabled?: boolean;
      sortOrder?: number;
      items?: unknown[];
    } = {};
    if (typeof body.name === "string") updateInput.name = body.name;
    if (typeof body.description === "string") updateInput.description = body.description;
    if (body.description === null) updateInput.description = null;
    if (typeof body.normalFloors === "number") updateInput.normalFloors = body.normalFloors;
    if (typeof body.hellFloors === "number") updateInput.hellFloors = body.hellFloors;
    if (Array.isArray(body.prepItems)) {
      updateInput.prepItems = body.prepItems
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 60))
        .slice(0, 12);
    }
    if (typeof body.prepText === "string") updateInput.prepText = body.prepText.slice(0, 300);
    else if (body.prepText === null) updateInput.prepText = null;
    if (typeof body.enabled === "boolean") updateInput.enabled = body.enabled;
    if (typeof body.sortOrder === "number") updateInput.sortOrder = body.sortOrder;
    if (Array.isArray(body.items)) updateInput.items = body.items;
    const updated = await updateTaskPack(db, packId, updateInput);
    if (!updated) return fail(404, "not_found", "任务包不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: "task_pack.update",
      entityType: "task_pack",
      entityId: String(packId),
      before: { name: existing.name, enabled: existing.enabled, itemCount: existing.items?.length ?? 0 },
      after: {
        name: updated.name,
        enabled: updated.enabled,
        itemCount: updated.items?.length ?? 0,
      },
    });
    return json({ pack: updated });
  }

  if (request.method === "DELETE" && taskPackMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理挑战任务包");
    const packId = Number(taskPackMatch[1]);
    const removed = await deleteTaskPack(db, packId);
    if (!removed) return fail(404, "not_found", "任务包不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: "task_pack.delete",
      entityType: "task_pack",
      entityId: String(packId),
    });
    return json({ ok: true, id: packId });
  }

  const surveyResponse = await handleAdminSurveysWrite(request, url, env, ctx, body);
  if (surveyResponse) return surveyResponse;

  const editorResponse = await handleAdminEditorWrite(request, url, env, ctx, body);
  if (editorResponse) return editorResponse;

  return fail(404, "not_found", "Not found");
}
