import { getSurveyById } from "../../db/repositories/survey.repository";
import { getReportDeliveryById } from "../../db/repositories/report-delivery.repository";
import { getResponseById } from "../../db/repositories/response.repository";
import { enqueueReportDelivery } from "../../services/report-delivery.service";
import { WriteContext, writeAudit } from "./helpers";
import { Env } from "../../index";

export async function handleAdminReportsWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  const retryDeliveryMatch = url.pathname.match(/^\/api\/admin\/report-deliveries\/(\d+)\/retry$/);
  if (request.method === "POST" && retryDeliveryMatch) {
    const delivery = await getReportDeliveryById(db, Number(retryDeliveryMatch[1]));
    if (!delivery) return fail(404, "delivery_not_found", "报告任务不存在");
    const response = await getResponseById(db, delivery.responseId);
    if (!response) return fail(404, "response_not_found", "答卷不存在");
    const survey = await getSurveyById(db, response.surveyId);
    if (!isAdmin && (!survey || survey.ownerId !== user.id)) {
      return fail(403, "forbidden", "无权操作该报告任务");
    }
    await enqueueReportDelivery(db, env.EXPORT_QUEUE, {
      responseId: delivery.responseId,
      force: true,
    });
    await writeAudit(db, {
      actorUserId: user.id,
      action: "report.retry",
      entityType: "report_delivery",
      entityId: String(delivery.id),
      after: { responseId: delivery.responseId },
    });
    return json({ ok: true });
  }

  return null;
}
