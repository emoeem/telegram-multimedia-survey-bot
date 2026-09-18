import { getSurveyById } from "../../db/repositories/survey.repository";
import type { MediaAsset, QuestionType, SurveyQuestion } from "../../db/schema";
import { normalizeSurveyTheme } from "../../survey/theme";
import { REPORT_TEMPLATES } from "../../services/report/template";
import {
  WriteContext,
  insertQuestionWithOptions,
  loadManageableSurvey,
  loadWritableSurvey,
  normalizeQuestionCondition,
  parseSettingsJson,
  readString,
  storeSurveyAdminMedia,
  touchSurvey,
  validateQuestionPayload,
  writeAudit,
} from "./helpers";
import { Env } from "../../index";
import { getCustomReportTemplate } from "../../db/repositories/report-template.repository";
import {
  createQuestionOption,
  deleteQuestion,
  deleteQuestionOption,
  duplicateQuestion,
  duplicateQuestionOption,
  getQuestionOptionById,
  listOptionsForQuestions,
  listQuestionsBySurvey,
  normalizeQuestionOrder,
  updateQuestionCondition,
  updateQuestionDescription,
  updateQuestionOptionLabel,
  updateQuestionPage,
  updateQuestionRequired,
  updateQuestionSettings,
  updateQuestionTitle,
  updateQuestionType,
  updateQuestionValidation,
} from "../../db/repositories/question.repository";
import {
  createSurveyPage,
  deleteSurveyPage,
  getSurveyPageById,
  listSurveyPages,
  normalizePageOrder,
  updateSurveyPage,
} from "../../db/repositories/page.repository";
import { getQuestionById } from "../../db/repositories/question.repository";
import { isMatrixQuestionType } from "../../survey/question-rules";
import {
  createOptionMedia,
  createQuestionMedia,
  deleteOptionMediaByAsset,
  deleteQuestionMediaByAsset,
  getOptionMediaByOptionId,
  getQuestionMediaByQuestionId,
} from "../../db/repositories/media.repository";
import { getSurveyVersionSnapshot } from "../../services/survey-version.service";
import { parseImportedSurvey, saveImportedSurvey } from "../../services/import.service";
import { getSurveyResultRuleSet, saveSurveyResultRuleSet } from "../../db/repositories/result-profile.repository";
import { parseResultRuleSet } from "../../services/result-engine.service";

export async function handleAdminEditorWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;
  const surveyMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)(\/.*)?$/);
  if (!surveyMatch) return null;
  const surveyId = Number(surveyMatch[1]);
  const rest = surveyMatch[2] ?? "";

  const restoreMatch = rest.match(/^\/versions\/(\d+)\/restore$/);
  if (request.method === "POST" && restoreMatch) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const version = Number(restoreMatch[1]);
    const snapshot = await getSurveyVersionSnapshot(db, surveyId, version);
    if (!snapshot) return fail(404, "version_not_found", "版本不存在");
    const imported = parseImportedSurvey(JSON.stringify(snapshot));
    const restoredId = await saveImportedSurvey(db, user.id, imported);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey.restore",
      entityType: "survey",
      entityId: String(surveyId),
      after: { version, restoredSurveyId: restoredId },
    });
    return Response.json({ id: restoredId, version }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  // Metadata patches (title/description/policy/report template/theme) stay
  // editable on published surveys; structural question edits keep the lock.
  const isMetadataPatch = request.method === "PATCH" && rest === "";
  if (!isMetadataPatch) {
    const writable = await loadWritableSurvey(env, ctx, surveyId, body);
    if (writable instanceof Response) return writable;
  }

  // PATCH /api/admin/surveys/:id — 问卷基本信息
  if (request.method === "PATCH" && rest === "") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const updates: string[] = [];
    const binds: unknown[] = [];
    if (body.title !== undefined) {
      const error = readString(body.title, "标题", 200);
      if (error) return fail(400, "validation_failed", error);
      updates.push("title = ?");
      binds.push(String(body.title).trim());
    }
    if (body.description !== undefined) {
      if (body.description === null || body.description === "") {
        updates.push("description = ?");
        binds.push(null);
      } else if (typeof body.description === "string") {
        if (body.description.length > 1000) return fail(400, "validation_failed", "描述长度不能超过 1000 字符");
        updates.push("description = ?");
        binds.push(body.description.trim());
      } else return fail(400, "validation_failed", "描述必须是字符串");
    }
    if (body.anonymous !== undefined) {
      if (typeof body.anonymous !== "boolean") return fail(400, "validation_failed", "anonymous 必须是布尔值");
      updates.push("anonymous = ?");
      binds.push(body.anonymous ? 1 : 0);
    }
    if (body.allowMultipleResponses !== undefined) {
      if (typeof body.allowMultipleResponses !== "boolean")
        return fail(400, "validation_failed", "allowMultipleResponses 必须是布尔值");
      updates.push("allow_multiple_responses = ?");
      binds.push(body.allowMultipleResponses ? 1 : 0);
    }
    if (body.maxResponsesPerUser !== undefined) {
      const value = Number(body.maxResponsesPerUser);
      if (!Number.isInteger(value) || value < 0 || value > 999)
        return fail(400, "validation_failed", "填写次数上限必须是 0-999 的整数");
      updates.push("max_responses_per_user = ?");
      binds.push(value);
    }
    if (body.reportTemplateId !== undefined) {
      if (body.reportTemplateId === null) {
        updates.push("report_template_id = ?");
        binds.push(null);
      } else if (typeof body.reportTemplateId === "string") {
        const trimmed = body.reportTemplateId.trim();
        const known = REPORT_TEMPLATES[trimmed] || (await getCustomReportTemplate(db, trimmed)) !== null;
        if (!known) {
          return fail(400, "validation_failed", "报告模板无效");
        }
        updates.push("report_template_id = ?");
        binds.push(trimmed);
      } else {
        return fail(400, "validation_failed", "reportTemplateId 必须是字符串或 null");
      }
    }
    if (body.theme !== undefined) {
      const existingSurvey = await getSurveyById(db, surveyId);
      const settings = existingSurvey?.settingsJson
        ? (parseSettingsJson(existingSurvey.settingsJson) ?? {})
        : ({} as Record<string, unknown>);
      if (body.theme === null) {
        delete settings.theme;
      } else if (body.theme && typeof body.theme === "object" && !Array.isArray(body.theme)) {
        const normalized = normalizeSurveyTheme(body.theme);
        if (!normalized) return fail(400, "validation_failed", "主题内容无效");
        settings.theme = normalized;
      } else {
        return fail(400, "validation_failed", "theme 必须是对象或 null");
      }
      const nextSettings = Object.keys(settings).length ? JSON.stringify(settings) : null;
      updates.push("settings_json = ?");
      binds.push(nextSettings);
    }
    if (!updates.length) return fail(400, "validation_failed", "没有可更新的字段");
    const timestamp = new Date().toISOString();
    updates.push("updated_at = ?");
    binds.push(timestamp, surveyId);
    await db
      .prepare(`UPDATE surveys SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
    return json({ updatedAt: timestamp });
  }

  if (request.method === "PUT" && rest === "/result-rules") {
    if (!body.ruleSet || typeof body.ruleSet !== "object" || Array.isArray(body.ruleSet)) {
      return fail(400, "validation_failed", "ruleSet 必须是对象");
    }
    const rulesJson = JSON.stringify(body.ruleSet);
    let parsed;
    try {
      parsed = parseResultRuleSet(rulesJson);
    } catch (error) {
      return fail(400, "validation_failed", error instanceof Error ? error.message : "结果规则无效");
    }
    await saveSurveyResultRuleSet(db, { surveyId, schemaVersion: parsed.schemaVersion, rulesJson, createdBy: user.id });
    return json({ ruleSet: parsed });
  }

  // POST /api/admin/surveys/:id/questions — 新增题目
  if (request.method === "POST" && rest === "/questions") {
    const { payload, error } = validateQuestionPayload(body, true);
    if (error) return fail(400, "validation_failed", error);
    const existing = await listQuestionsBySurvey(db, surveyId);
    if (existing.length >= 200) return fail(400, "validation_failed", "题目数量不能超过 200");
    const order = existing.length;
    const questionId = await insertQuestionWithOptions(db, surveyId, payload!, order);
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      { id: questionId, order, updatedAt },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  // POST /api/admin/surveys/:id/questions/reorder — 批量重排
  if (request.method === "POST" && rest === "/questions/reorder") {
    if (!Array.isArray(body.questionIds) || body.questionIds.some((value) => !Number.isInteger(value))) {
      return fail(400, "validation_failed", "questionIds 必须是整数数组");
    }
    const questions = await listQuestionsBySurvey(db, surveyId);
    const existingIds = new Set(questions.map((question: SurveyQuestion) => question.id));
    const requestedIds = body.questionIds.map(Number);
    if (
      requestedIds.length !== existingIds.size ||
      new Set(requestedIds).size !== existingIds.size ||
      requestedIds.some((id: number) => !existingIds.has(id))
    ) {
      return fail(400, "validation_failed", "questionIds 必须与当前题目集合完全一致");
    }
    await normalizeQuestionOrder(db, surveyId, requestedIds);
    const updatedAt = await touchSurvey(db, surveyId);
    return json({ updatedAt });
  }

  // POST /api/admin/surveys/:id/pages — 新增分页
  if (request.method === "POST" && rest === "/pages") {
    const title = body.title === undefined || body.title === null ? null : String(body.title).trim();
    if (title !== null && title.length > 200) {
      return fail(400, "validation_failed", "分页标题长度不能超过 200 字符");
    }
    let description: string | null = null;
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== "string") {
        return fail(400, "validation_failed", "分页描述必须是字符串");
      }
      description = body.description.trim();
      if (description.length > 1000) {
        return fail(400, "validation_failed", "分页描述长度不能超过 1000 字符");
      }
    }
    const existing = await listSurveyPages(db, surveyId);
    if (existing.length >= 50) {
      return fail(400, "validation_failed", "分页数量不能超过 50");
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
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  // POST /api/admin/surveys/:id/pages/reorder — 批量重排分页
  if (request.method === "POST" && rest === "/pages/reorder") {
    if (!Array.isArray(body.pageIds) || body.pageIds.some((value) => !Number.isInteger(value))) {
      return fail(400, "validation_failed", "pageIds 必须是整数数组");
    }
    const existing = await listSurveyPages(db, surveyId);
    const existingIds = new Set(existing.map((page) => page.id));
    const requestedIds = body.pageIds.map(Number);
    if (
      requestedIds.length !== existingIds.size ||
      new Set(requestedIds).size !== existingIds.size ||
      requestedIds.some((value) => !existingIds.has(value))
    ) {
      return fail(400, "validation_failed", "pageIds 必须与当前分页集合完全一致");
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
      return fail(404, "not_found", "分页不存在");
    }

    if (request.method === "PATCH") {
      const title = body.title === undefined ? undefined : body.title === null ? null : String(body.title).trim();
      if (title !== undefined && title !== null && title.length > 200) {
        return fail(400, "validation_failed", "分页标题长度不能超过 200 字符");
      }
      let description: string | null | undefined;
      if (body.description !== undefined) {
        if (body.description === null) description = null;
        else if (typeof body.description === "string") {
          description = body.description.trim();
          if (description.length > 1000) {
            return fail(400, "validation_failed", "分页描述长度不能超过 1000 字符");
          }
        } else return fail(400, "validation_failed", "分页描述必须是字符串");
      }
      let order: number | undefined;
      if (body.order !== undefined) {
        if (!Number.isInteger(body.order) || Number(body.order) < 0) {
          return fail(400, "validation_failed", "order 必须是非负整数");
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

    if (request.method === "DELETE") {
      await deleteSurveyPage(db, pageId);
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
  }

  const questionMatch = rest.match(/^\/questions\/(\d+)$/);
  if (questionMatch) {
    const questionId = Number(questionMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, "not_found", "题目不存在");

    // PATCH — 更新题目字段（保 ID；不改题型）
    if (request.method === "PATCH") {
      const { payload, error } = validateQuestionPayload(body, false);
      if (error) return fail(400, "validation_failed", error);
      const targetType = body.type !== undefined ? (body.type as QuestionType) : question.type;
      if (body.type !== undefined && body.type !== question.type) {
        await updateQuestionType(db, questionId, targetType);
        if (!["single", "multiple", "yes_no", "rating"].includes(targetType) && !isMatrixQuestionType(targetType)) {
          await db.prepare("DELETE FROM question_options WHERE question_id = ?").bind(questionId).run();
        }
        if (isMatrixQuestionType(question.type) && !isMatrixQuestionType(targetType)) {
          await updateQuestionSettings(db, questionId, null);
        }
        if (isMatrixQuestionType(targetType)) {
          if (!payload!.settingsJson) {
            return fail(400, "validation_failed", "matrix 题需要提供 settings.columns");
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
          return fail(400, "validation_failed", "仅 matrix 题支持 settings");
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
            return fail(400, "validation_failed", "pageId 无效");
          }
          await updateQuestionPage(db, questionId, pageId);
        } else {
          await updateQuestionPage(db, questionId, null);
        }
      }
      if (body.condition !== undefined) {
        const condition = normalizeQuestionCondition(body.condition);
        if ("error" in condition) {
          return fail(400, "validation_failed", condition.error);
        }
        await updateQuestionCondition(db, questionId, condition.conditionJson, condition.skipToQuestionId);
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
    if (request.method === "DELETE") {
      await deleteQuestion(db, questionId);
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
  }

  // POST /api/admin/surveys/:id/questions/:qid/options — 追加单个选项
  // （独立端点返回新选项 ID，供编辑器的保存队列做临时 ID 映射）
  const questionOptionsMatch = rest.match(/^\/questions\/(\d+)\/options$/);
  if (request.method === "POST" && questionOptionsMatch) {
    const questionId = Number(questionOptionsMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, "not_found", "题目不存在");
    const error = readString(body.label, "选项文本", 200);
    if (error) return fail(400, "validation_failed", error);
    const existingOptions = await listOptionsForQuestions(db, [questionId]);
    if (existingOptions.length >= 50) return fail(400, "validation_failed", "选项数量不能超过 50");
    const optionId = await createQuestionOption(db, {
      questionId,
      label: String(body.label).trim(),
      value: String(body.label).trim(),
      order: existingOptions.length,
    });
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      { id: optionId, order: existingOptions.length, updatedAt },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  const duplicateQuestionMatch = rest.match(/^\/questions\/(\d+)\/duplicate$/);
  if (request.method === "POST" && duplicateQuestionMatch) {
    const questionId = Number(duplicateQuestionMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) {
      return fail(404, "not_found", "题目不存在");
    }
    const newQuestionId = await duplicateQuestion(db, questionId);
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json({ id: newQuestionId, updatedAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  const optionMatch = rest.match(/^\/options\/(\d+)$/);
  if (optionMatch) {
    const optionId = Number(optionMatch[1]);
    const option = await getQuestionOptionById(db, optionId);
    if (!option) return fail(404, "not_found", "选项不存在");
    const question = await getQuestionById(db, option.questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, "not_found", "选项不存在");

    if (request.method === "PATCH") {
      const error = readString(body.label, "选项文本", 200);
      if (error) return fail(400, "validation_failed", error);
      await updateQuestionOptionLabel(db, optionId, String(body.label).trim());
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
    if (request.method === "DELETE") {
      await deleteQuestionOption(db, optionId);
      const updatedAt = await touchSurvey(db, surveyId);
      return json({ updatedAt });
    }
  }

  const duplicateOptionMatch = rest.match(/^\/options\/(\d+)\/duplicate$/);
  if (request.method === "POST" && duplicateOptionMatch) {
    const optionId = Number(duplicateOptionMatch[1]);
    const option = await getQuestionOptionById(db, optionId);
    if (!option) return fail(404, "not_found", "选项不存在");
    const question = await getQuestionById(db, option.questionId);
    if (!question || question.surveyId !== surveyId) {
      return fail(404, "not_found", "选项不存在");
    }
    const newOptionId = await duplicateQuestionOption(db, optionId);
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json({ id: newOptionId, updatedAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  // ---- 题目 / 选项媒体附件（网页编辑器上传与移除） ----
  // 上传即绑定：文件写入 MEDIA_KV，绑定到题目/选项，随后前端刷新编辑器。
  const readUploadedFile = async (): Promise<File | Response> => {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return fail(400, "invalid_upload", "请选择要上传的文件");
    }
    return file;
  };

  const questionMediaUploadMatch = rest.match(/^\/questions\/(\d+)\/media$/);
  if (request.method === "POST" && questionMediaUploadMatch) {
    const questionId = Number(questionMediaUploadMatch[1]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, "not_found", "题目不存在");
    const fileOrError = await readUploadedFile();
    if (fileOrError instanceof Response) return fileOrError;
    let asset: MediaAsset;
    try {
      asset = await storeSurveyAdminMedia(db, env.MEDIA_KV, fileOrError);
    } catch (error) {
      return fail(400, "invalid_upload", error instanceof Error ? error.message : "上传失败，请重试");
    }
    const existing = await getQuestionMediaByQuestionId(db, questionId);
    await createQuestionMedia(db, { questionId, mediaAssetId: asset.id, sortOrder: existing.length });
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      {
        mediaAssetId: asset.id,
        mediaType: asset.mediaType,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        updatedAt,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  const questionMediaDeleteMatch = rest.match(/^\/questions\/(\d+)\/media\/(\d+)$/);
  if (request.method === "DELETE" && questionMediaDeleteMatch) {
    const questionId = Number(questionMediaDeleteMatch[1]);
    const mediaAssetId = Number(questionMediaDeleteMatch[2]);
    const question = await getQuestionById(db, questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, "not_found", "题目不存在");
    const removed = await deleteQuestionMediaByAsset(db, questionId, mediaAssetId);
    if (removed === 0) return fail(404, "media_not_found", "该题目没有此附件");
    const updatedAt = await touchSurvey(db, surveyId);
    return json({ ok: true, updatedAt });
  }

  const optionMediaUploadMatch = rest.match(/^\/options\/(\d+)\/media$/);
  if (request.method === "POST" && optionMediaUploadMatch) {
    const optionId = Number(optionMediaUploadMatch[1]);
    const option = await getQuestionOptionById(db, optionId);
    if (!option) return fail(404, "not_found", "选项不存在");
    const question = await getQuestionById(db, option.questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, "not_found", "选项不存在");
    const fileOrError = await readUploadedFile();
    if (fileOrError instanceof Response) return fileOrError;
    let asset: MediaAsset;
    try {
      asset = await storeSurveyAdminMedia(db, env.MEDIA_KV, fileOrError);
    } catch (error) {
      return fail(400, "invalid_upload", error instanceof Error ? error.message : "上传失败，请重试");
    }
    const existing = await getOptionMediaByOptionId(db, optionId);
    await createOptionMedia(db, { questionOptionId: optionId, mediaAssetId: asset.id, sortOrder: existing.length });
    const updatedAt = await touchSurvey(db, surveyId);
    return Response.json(
      {
        mediaAssetId: asset.id,
        mediaType: asset.mediaType,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        updatedAt,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  const optionMediaDeleteMatch = rest.match(/^\/options\/(\d+)\/media\/(\d+)$/);
  if (request.method === "DELETE" && optionMediaDeleteMatch) {
    const optionId = Number(optionMediaDeleteMatch[1]);
    const mediaAssetId = Number(optionMediaDeleteMatch[2]);
    const option = await getQuestionOptionById(db, optionId);
    if (!option) return fail(404, "not_found", "选项不存在");
    const question = await getQuestionById(db, option.questionId);
    if (!question || question.surveyId !== surveyId) return fail(404, "not_found", "选项不存在");
    const removed = await deleteOptionMediaByAsset(db, optionId, mediaAssetId);
    if (removed === 0) return fail(404, "media_not_found", "该选项没有此附件");
    const updatedAt = await touchSurvey(db, surveyId);
    return json({ ok: true, updatedAt });
  }

  return null;
}
