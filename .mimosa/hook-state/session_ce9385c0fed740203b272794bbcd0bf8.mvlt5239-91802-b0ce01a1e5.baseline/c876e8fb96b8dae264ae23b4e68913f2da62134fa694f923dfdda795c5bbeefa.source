import { REPORT_TEMPLATES, validateReportTemplateSpec } from "../../services/report/template";
import { reportPreviewViewModel } from "../../services/report/preview-view-model";
import { buildResponsiveReportHtml } from "../../services/report/web";
import { WriteContext, writeAudit } from "./helpers";
import { Env } from "../../index";
import {
  deleteCustomReportTemplate,
  upsertCustomReportTemplate,
} from "../../db/repositories/report-template.repository";

export async function handleAdminTemplatesWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  // POST /api/admin/report-templates — 创建/更新自定义报告模板
  if (request.method === "POST" && url.pathname === "/api/admin/report-templates") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理报告模板");
    const { template, error } = validateReportTemplateSpec(body);
    if (error || !template) {
      return fail(400, "validation_failed", error ?? "模板无效");
    }
    if (REPORT_TEMPLATES[template.id]) {
      return fail(400, "validation_failed", "不能覆盖系统模板");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(template.id)) {
      return fail(400, "validation_failed", "模板 id 只能包含小写字母、数字与连字符");
    }
    await upsertCustomReportTemplate(env.DB, {
      id: template.id,
      name: template.name,
      spec: template,
      createdBy: user.id,
    });
    await writeAudit(db, {
      actorUserId: user.id,
      action: "template.save",
      entityType: "report_template",
      entityId: template.id,
      after: { name: template.name },
    });
    return json({ ok: true, id: template.id });
  }

  // POST /api/admin/report-templates/preview — 实时渲染模板预览
  if (request.method === "POST" && url.pathname === "/api/admin/report-templates/preview") {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可预览报告模板");
    const { template, error } = validateReportTemplateSpec(body);
    if (error || !template) {
      return fail(400, "validation_failed", error ?? "模板无效");
    }
    const html = buildResponsiveReportHtml(
      reportPreviewViewModel,
      { surveyTitle: "模板预览", completedAt: "2026-08-23 14:00", reportId: "#preview" },
      template,
    );
    return json({ html });
  }

  const deleteTemplateMatch = url.pathname.match(/^\/api\/admin\/report-templates\/([^/]+)$/);
  if (request.method === "DELETE" && deleteTemplateMatch) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理报告模板");
    const id = decodeURIComponent(deleteTemplateMatch[1] ?? "");
    if (REPORT_TEMPLATES[id]) {
      return fail(400, "validation_failed", "不能删除系统模板");
    }
    const removed = await deleteCustomReportTemplate(env.DB, id);
    if (!removed) return fail(404, "not_found", "模板不存在");
    await writeAudit(db, {
      actorUserId: user.id,
      action: "template.delete",
      entityType: "report_template",
      entityId: id,
    });
    return json({ ok: true });
  }

  return null;
}
