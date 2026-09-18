import { deleteSurvey, updateSurveyStatus } from "../../db/repositories/survey.repository";
import { archiveResponse, deleteResponse, getResponseById } from "../../db/repositories/response.repository";
import { buildCsv, getExportRows, serializeExport } from "../../services/export.service";
import { duplicateSurvey, publishSurvey } from "../../services/survey.service";
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
          .slice(0, 100)
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
          .slice(0, 100)
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
      // 管理员可以强制删除任何问卷（含已有答卷）；普通用户保留历史答卷保护。
      await deleteSurvey(db, surveyId, { force: isAdmin });
      await writeAudit(db, {
        actorUserId: user.id,
        action: "survey.delete",
        entityType: "survey",
        entityId: String(surveyId),
        before: { status: manageable.survey.status, forced: isAdmin },
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

  if (request.method === "POST" && rest === "/publish") {
    const manageable = await loadManageableSurvey(env, ctx, surveyId, body);
    if (manageable instanceof Response) return manageable;
    try {
      const published = await publishSurvey(db, surveyId, user.id);
      await writeAudit(db, {
        actorUserId: user.id,
        action: "survey.publish",
        entityType: "survey",
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
      return fail(400, "publish_validation", error instanceof Error ? error.message : "问卷不满足发布条件");
    }
  }

  return null;
}
