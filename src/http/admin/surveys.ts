import { getSurveyById, softDeleteSurvey, updateSurveyStatus } from "../../db/repositories/survey.repository";
import { archiveResponse, deleteResponse, getResponseById } from "../../db/repositories/response.repository";
import { buildCsv, getExportRows, serializeExport } from "../../services/export.service";
import { duplicateSurvey, publishSurvey } from "../../services/survey.service";
import { getSurveyFlow } from "../../services/question.service";
import { validateSurveyGraph } from "../../services/survey-graph.service";
import { enqueueReportDelivery } from "../../services/report-delivery.service";
import { sendDocument } from "../../bot/telegram";
import { prepareResultProfileForResponse } from "../../services/result-visual.service";
import { deserializeResultProfile } from "../../services/result-engine.service";
import { renderReportPdf } from "../../services/report/pdf";
import { resolveReportProfileImages } from "../../services/report/report-images.service";
import { resolveReportTemplate } from "../../services/report/template-resolver";
import { createReportAccessToken } from "../../services/report-access-token.service";
import { loadSystemSettings } from "../../services/system-settings.service";
import { WriteContext, loadManageableSurvey, writeAudit } from "./helpers";
import { getSurveyCoinAccess } from "../../services/coin/unlock.service";
import { Env } from "../../index";

export async function handleAdminSurveysWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  // POST /api/admin/surveys/bulk-rating — 批量标注内容分级（仅管理员）。
  // 一条 UPDATE ... IN 搞定并统一 bump updated_at（翻新公开目录缓存）。
  // 注意必须在数字 ID 匹配之前：bulk-rating 不是数字，否则会被提前 return null。
  if (request.method === "POST" && url.pathname === "/api/admin/surveys/bulk-rating") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可批量调整内容分级");
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0) : [];
    const rating = body.rating;
    if (!ids.length) return fail(400, "validation_failed", "请选择至少一份问卷");
    if (ids.length > 200) return fail(400, "validation_failed", "一次最多标注 200 份");
    if (rating !== "all" && rating !== "r18") return fail(400, "validation_failed", "内容分级必须是 all 或 r18");
    const placeholders = ids.map(() => "?").join(",");
    const timestamp = new Date().toISOString();
    const result = await db
      .prepare(
        `UPDATE surveys SET content_rating = ?, updated_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      )
      .bind(rating, timestamp, ...ids)
      .run();
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey.bulk_rating",
      entityType: "survey",
      entityId: null,
      after: { ids, rating, changed: result.meta?.changes ?? 0 },
    });
    return json({ ok: true, changed: result.meta?.changes ?? 0 });
  }

  const surveyMatch = url.pathname.match(/^\/api\/admin\/surveys\/(\d+)(\/.*)?$/);
  if (!surveyMatch) return null;
  const surveyId = Number(surveyMatch[1]);
  const rest = surveyMatch[2] ?? "";

  // POST /api/admin/surveys/:id/responses/batch-export — 批量把已完成答卷的
  // 报告（PDF+图片打包）入队发送到私人频道
  if (request.method === "POST" && rest === "/responses/batch-export") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const responseIds = Array.isArray(body.responseIds)
      ? body.responseIds
          .filter((value): value is number => Number.isInteger(value))
          .map(Number)
          // 90, not 100: survey_id is bound in the same statement, so 100 ids
          // would be 101 bound variables — over D1's per-statement cap.
          .slice(0, 90)
      : [];
    if (!responseIds.length) return fail(400, "validation_failed", "请选择要导出的答卷");
    const rows = await env.DB.prepare(
      `SELECT id, status FROM survey_responses
         WHERE survey_id = ? AND id IN (${responseIds.map(() => "?").join(",")})`,
    )
      .bind(surveyId, ...responseIds)
      .all<{ id: number; status: string }>();
    const completed = (rows.results ?? []).filter((row) => row.status === "completed");
    if (!completed.length) {
      return fail(400, "validation_failed", "没有可导出的已完成答卷");
    }
    let queued = 0;
    for (const row of completed) {
      await enqueueReportDelivery(db, env.EXPORT_QUEUE, {
        responseId: row.id,
        force: true,
      });
      queued += 1;
    }
    await writeAudit(db, {
      actorUserId: user.id,
      action: "response.batch_export",
      entityType: "survey",
      entityId: String(surveyId),
      after: { count: queued },
    });
    return json({ ok: true, queued });
  }

  // POST /api/admin/surveys/:id/responses/send-to-channel — 把答卷汇总表
  // （CSV，Excel 可直接打开）作为文件发送到报告归档频道。
  if (request.method === "POST" && rest === "/responses/send-to-channel") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const settings = await loadSystemSettings(env.DB);
    const channelRaw = settings.reportChannelId || env.REPORT_CHANNEL_ID || "";
    const channelId = Number(channelRaw.trim());
    if (!Number.isInteger(channelId) || channelId === 0) {
      return fail(400, "channel_not_configured", "未配置报告频道（系统设置 → 报告频道 ID）");
    }
    const format = body.format === "zip" ? "zip" : "csv";
    const { rows } = await getExportRows(env.DB, surveyId);
    if (!rows.length) {
      return fail(400, "validation_failed", "该问卷还没有答卷可导出");
    }
    const csv = buildCsv(rows);
    const content = serializeExport(format as "csv" | "zip", csv, rows);
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `survey-${surveyId}-responses-${stamp}.${format}`;
    const bodyBytes =
      typeof content === "string" ? new TextEncoder().encode(`\uFEFF${content}`) : new Uint8Array(content);
    try {
      await sendDocument(
        env.BOT_TOKEN,
        channelId,
        fileName,
        bodyBytes,
        format === "zip" ? "application/zip" : "text/csv",
        `📄 《${manageable.survey.title}》答卷汇总 · 共 ${rows.length} 份 · ${stamp}`,
      );
    } catch (error) {
      return fail(502, "channel_send_failed", `发送到频道失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
    await writeAudit(env.DB, {
      actorUserId: user.id,
      action: "response.export_to_channel",
      entityType: "survey",
      entityId: String(surveyId),
      after: { rows: rows.length, format },
    });
    return json({ ok: true, fileName, rows: rows.length });
  }

  // POST /api/admin/surveys/:id/responses/export-status — 批量导出的实时进度
  if (request.method === "POST" && rest === "/responses/export-status") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const ids = Array.isArray(body.ids)
      ? body.ids
          .filter((value): value is number => Number.isInteger(value))
          .map(Number)
          // Same binding budget as batch-export: the survey_id binding is extra.
          .slice(0, 90)
      : [];
    if (!ids.length) return fail(400, "validation_failed", "缺少 ids");
    // Ownership: only report deliveries whose response actually belongs to
    // this survey may be counted, otherwise ids from a foreign survey leak
    // aggregated delivery status.
    const ownedRows = await env.DB.prepare(
      `SELECT id FROM survey_responses WHERE survey_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(surveyId, ...ids)
      .all<{ id: number }>();
    const ownedIds = new Set((ownedRows.results ?? []).map((row) => Number(row.id)));
    const scopedIds = ids.filter((id) => ownedIds.has(id));
    if (!scopedIds.length) return json({ counts: {}, total: ids.length, pending: ids.length });
    const rows = await env.DB.prepare(
      `SELECT rd.status, COUNT(*) count FROM report_deliveries rd
         WHERE rd.response_id IN (${scopedIds.map(() => "?").join(",")})
         GROUP BY rd.status`,
    )
      .bind(...scopedIds)
      .all<{ status: string; count: number }>();
    const counts: Record<string, number> = {};
    for (const row of rows.results ?? []) {
      counts[row.status] = Number(row.count);
    }
    const accounted = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return json({
      counts,
      total: ids.length,
      pending: Math.max(0, ids.length - accounted),
    });
  }

  if (request.method === "POST" && rest === "/duplicate") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const duplicate = await duplicateSurvey(db, surveyId, user.id);
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey.duplicate",
      entityType: "survey",
      entityId: String(surveyId),
      after: { duplicateId: duplicate.id },
    });
    return Response.json(
      { id: duplicate.id, updatedAt: duplicate.updatedAt },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (request.method === "POST" && (rest === "/close" || rest === "/archive" || rest === "/reopen")) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const before = { status: manageable.survey.status };
    try {
      let updated;
      if (rest === "/reopen") {
        updated = await publishSurvey(db, surveyId, user.id);
      } else {
        updated = await updateSurveyStatus(db, surveyId, rest === "/close" ? "closed" : "archived");
      }
      if (!updated) return fail(404, "not_found", "问卷不存在");
      await writeAudit(db, {
        actorUserId: user.id,
        action: `survey.${rest === "/close" ? "close" : rest === "/archive" ? "archive" : "reopen"}`,
        entityType: "survey",
        entityId: String(surveyId),
        before,
        after: { status: updated.status },
      });
      return json({ status: updated.status, updatedAt: updated.updatedAt, version: updated.version });
    } catch (error) {
      return fail(400, "status_change_failed", error instanceof Error ? error.message : "状态变更失败");
    }
  }

  if (request.method === "DELETE" && rest === "") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    try {
      // 管理员/创作者删除只做软删除：答卷与媒体引用保留 30 天，可从回收站完整恢复。
      const deleted = await softDeleteSurvey(db, surveyId);
      if (!deleted) return fail(404, "not_found", "问卷不存在");
      await writeAudit(db, {
        actorUserId: user.id,
        action: "survey.delete",
        entityType: "survey",
        entityId: String(surveyId),
        before: { status: manageable.survey.status, softDeleted: true, retentionDays: 30 },
      });
      return json({ ok: true });
    } catch (error) {
      return fail(400, "delete_blocked", error instanceof Error ? error.message : "删除失败");
    }
  }

  const regenerateMatch = rest.match(/^\/responses\/(\d+)\/report$/);
  if (request.method === "POST" && regenerateMatch) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const responseId = Number(regenerateMatch[1]);
    const response = await getResponseById(db, responseId);
    if (!response || response.surveyId !== surveyId) {
      return fail(404, "response_not_found", "答卷不存在");
    }
    await prepareResultProfileForResponse(db, responseId, { forceRecalculate: true });
    await enqueueReportDelivery(db, env.EXPORT_QUEUE, { responseId, force: true });
    await writeAudit(db, {
      actorUserId: user.id,
      action: "report.regenerate",
      entityType: "response",
      entityId: String(responseId),
      after: { surveyId },
    });
    return json({ ok: true });
  }

  const responseActionMatch = rest.match(/^\/responses\/(\d+)\/(archive|delete|report-link|resend|pdf)$/);
  if (request.method === "POST" && responseActionMatch) {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const responseId = Number(responseActionMatch[1]);
    const action = responseActionMatch[2];
    const response = await getResponseById(db, responseId);
    if (!response || response.surveyId !== surveyId) {
      return fail(404, "response_not_found", "答卷不存在");
    }
    if (action === "archive") {
      await archiveResponse(db, responseId);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "response.archive",
        entityType: "response",
        entityId: String(responseId),
      });
      return json({ ok: true });
    }
    if (action === "delete") {
      try {
        await deleteResponse(db, responseId);
        await writeAudit(db, {
          actorUserId: user.id,
          action: "response.delete",
          entityType: "response",
          entityId: String(responseId),
        });
        return json({ ok: true });
      } catch (error) {
        return fail(400, "delete_blocked", error instanceof Error ? error.message : "删除失败");
      }
    }
    if (action === "resend") {
      if (response.status !== "completed") {
        return fail(400, "not_completed", "答卷尚未完成，无法发送报告");
      }
      await enqueueReportDelivery(db, env.EXPORT_QUEUE, { responseId, force: true });
      await writeAudit(db, {
        actorUserId: user.id,
        action: "report.resend",
        entityType: "response",
        entityId: String(responseId),
        after: { surveyId },
      });
      return json({ ok: true });
    }
    if (action === "pdf") {
      if (response.status !== "completed") {
        return fail(400, "not_completed", "答卷尚未完成，无法生成 PDF");
      }
      const surveyRow = manageable.survey;
      const settings = await loadSystemSettings(db);
      const template = await resolveReportTemplate(db, surveyRow.reportTemplateId ?? settings.defaultReportTemplate);
      const prepared = await prepareResultProfileForResponse(db, responseId);
      if (!prepared) {
        return fail(404, "report_unavailable", "报告不存在或尚未生成");
      }
      const snapshot = deserializeResultProfile(prepared.profile);
      const images = await resolveReportProfileImages(env, snapshot);
      const pdf = await renderReportPdf(
        env.BROWSER,
        snapshot,
        images,
        { reportId: `#${responseId}`, surveyTitle: surveyRow.title, watermark: settings.reportWatermark },
        {},
        template,
      );
      await writeAudit(db, {
        actorUserId: user.id,
        action: "report.download",
        entityType: "response",
        entityId: String(responseId),
        after: { surveyId },
      });
      return new Response(
        pdf.bytes.buffer.slice(pdf.bytes.byteOffset, pdf.bytes.byteOffset + pdf.bytes.byteLength) as ArrayBuffer,
        {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="report-${responseId}.pdf"`,
            "Cache-Control": "no-store",
          },
        },
      );
    }
    const token = await createReportAccessToken(env.WEBHOOK_SECRET, responseId);
    return json({ reportUrl: `/report/${responseId}?t=${token}` });
  }

  // POST /api/admin/surveys/:id/answer-key — 朋友互测（P2）：把一份已完成的
  // 答卷设为「答案钥匙」。参与者的报告会对照钥匙算默契得分；钥匙答案本身
  // 永不下发给参与者。
  if (request.method === "POST" && rest === "/answer-key") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const responseId = Number(body.responseId);
    if (!Number.isInteger(responseId) || responseId <= 0) {
      return fail(400, "validation_failed", "responseId 无效");
    }
    const response = await getResponseById(db, responseId);
    if (!response || response.surveyId !== surveyId || response.status !== "completed") {
      return fail(404, "response_not_found", "答卷不存在或未完成");
    }
    const survey = await getSurveyById(db, surveyId);
    if (!survey) return fail(404, "survey_not_found", "问卷不存在");
    let settings: Record<string, unknown> = {};
    if (survey.settingsJson) {
      try {
        const parsed = JSON.parse(survey.settingsJson) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
      } catch {
        settings = {};
      }
    }
    settings.answerKeyResponseId = responseId;
    const timestamp = new Date().toISOString();
    await db
      .prepare("UPDATE surveys SET settings_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(settings), timestamp, surveyId)
      .run();
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey.answer_key.set",
      entityType: "survey",
      entityId: String(surveyId),
      after: { responseId },
    });
    return json({ ok: true, responseId, updatedAt: timestamp });
  }

  if (request.method === "POST" && rest === "/publish") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    // 图谱校验：分支问卷发布前拦截死路 / 不可达节点 / 向后跳转 / 坏引用。
    // 运行时会静默忽略这些坏边并回退线性顺序，对普通问卷无害，但会把
    // 分支剧情悄悄改写掉——所以必须在发布时拦下。
    const flow = await getSurveyFlow(db, surveyId);
    const graphIssues = validateSurveyGraph(flow.questions);
    const graphErrors = graphIssues.filter((issue) => issue.level === "error");
    if (graphErrors.length) {
      return Response.json(
        {
          ok: false,
          code: "graph_invalid",
          message: `图谱校验未通过（${graphErrors.length} 个问题），发布被拒绝；可在错误详情里按题目定位`,
          issues: graphIssues,
          requestId: ctx.requestId,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const graphWarnings = graphIssues.filter((issue) => issue.level === "warning");
    try {
      const published = await publishSurvey(db, surveyId, user.id);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "survey.publish",
        entityType: "survey",
        entityId: String(surveyId),
        after: { version: published.version },
      });
      // 连载更新召回（0084）：经 SELF service binding 调自己的内部端点，
      // fire-and-forget——站内通知与 TG push 都不拖住发布响应。
      if (published.seriesId !== null && env.SELF) {
        void notifySeriesUpdateViaSelf(env, {
          seriesId: published.seriesId,
          surveyId,
          chapterTitle: published.title,
        }).catch((error) => console.warn("series notify dispatch failed", { surveyId, error }));
      }
      return json({
        status: published.status,
        publishedAt: published.publishedAt,
        version: published.version,
        updatedAt: published.updatedAt,
        ...(graphWarnings.length ? { warnings: graphWarnings } : {}),
      });
    } catch (error) {
      return fail(400, "publish_validation", error instanceof Error ? error.message : "问卷不满足发布条件");
    }
  }

  // PUT /api/admin/surveys/:id/coin-access — 作者自主启用/关闭金币解锁。
  // 关闭只是 enabled=0（保留定价痕迹），不会删除任何已存在的解锁记录；
  // 密码访问与此互相独立，金币解锁永不绕过密码。
  if (request.method === "PUT" && rest === "/coin-access") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    const enabled = body.enabled === true;
    const autoPrice = body.autoPrice !== false; // 默认按热度自动定价
    const basePrice = Number(body.basePrice ?? 0);
    const rawFixed = body.fixedPrice;
    if (!Number.isInteger(basePrice) || basePrice < 0) {
      return fail(400, "invalid_base_price", "基础价格必须是非负整数");
    }
    if (rawFixed != null && (!Number.isInteger(Number(rawFixed)) || Number(rawFixed) < 0)) {
      return fail(400, "invalid_fixed_price", "固定价格必须是非负整数");
    }
    const fixedPrice = rawFixed == null ? null : Number(rawFixed);
    if (enabled && autoPrice && basePrice <= 0) {
      return fail(400, "invalid_base_price", "自动定价需要大于 0 的基础价格");
    }
    if (enabled && !autoPrice && fixedPrice == null) {
      return fail(400, "invalid_fixed_price", "固定定价需要填写固定价格");
    }
    const now = new Date().toISOString();
    const before = await getSurveyCoinAccess(db, surveyId);
    await db
      .prepare(
        `INSERT INTO survey_coin_access
           (survey_id, enabled, base_price, auto_price, fixed_price, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(survey_id) DO UPDATE SET
           enabled = excluded.enabled, base_price = excluded.base_price,
           auto_price = excluded.auto_price, fixed_price = excluded.fixed_price,
           price_cached = NULL, price_computed_at = NULL,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(surveyId, enabled ? 1 : 0, basePrice, autoPrice ? 1 : 0, fixedPrice, adminActorOf(ctx), now)
      .run();
    await writeAudit(db, {
      actorUserId: user.id,
      action: "survey.coin_access.update",
      entityType: "survey_coin_access",
      entityId: String(surveyId),
      before: before ? { enabled: before.enabled, basePrice: before.base_price, autoPrice: before.auto_price, fixedPrice: before.fixed_price } : null,
      after: { enabled, basePrice, autoPrice, fixedPrice },
    });
    return json({ ok: true, enabled, autoPrice, basePrice, fixedPrice });
  }

  return null;
}

function adminActorOf(ctx: WriteContext): string {
  return `admin:${ctx.user?.id ?? "unknown"}`;
}

/**
 * 经 SELF binding 触发连载召回：body 用 WEBHOOK_SECRET 做 HMAC-SHA256 签名
 * （Web Crypto，与服务内其它令牌同源），内部端点常数时间验签后执行。
 * 任何失败只留日志。
 */
async function notifySeriesUpdateViaSelf(
  env: { SELF?: Fetcher; WEBHOOK_SECRET?: string },
  input: { seriesId: number; surveyId: number; chapterTitle: string },
): Promise<void> {
  if (!env.SELF) return;
  const body = JSON.stringify(input);
  const signature = await hmacHex(env.WEBHOOK_SECRET ?? "", body);
  await env.SELF.fetch("https://self/internal/series-notify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-notify-signature": signature },
    body,
  });
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
