import { getSurveyById } from "../../db/repositories/survey.repository";
import { getReportDeliveryById } from "../../db/repositories/report-delivery.repository";
import { getResponseById } from "../../db/repositories/response.repository";
import { enqueueReportDelivery } from "../../services/report-delivery.service";
import { PUBLICATION_CLAIM_STALE_MS } from "../../services/public-report.service";
import { WriteContext, writeAudit } from "./helpers";
import { Env } from "../../index";
import { createExportJobSender } from "../../services/export-job-dispatch.service";

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
    await enqueueReportDelivery(db, createExportJobSender(env), {
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

  /**
   * 手动重投公开报告：`POST /api/admin/surveys/:surveyId/responses/:responseId/report-publication/retry`
   *
   * 为什么需要它：提交端的发布是"入队即忘"的异步链路，入队失败/渲染失败只把
   * 状态写成 failed。此前缺这个入口时，failed 是一条死状态——答卷者勾了发布、
   * 频道里什么都没有，除了直接改库没有任何补救办法（生产库里就有 32 条）。
   *
   * 重投是**续发**：public-report.service 会带着上一轮的断点（0093）从没发出去
   * 的那一批接着发，已经进频道的批次不会重来一遍。
   */
  const retryPublicationMatch = url.pathname.match(
    /^\/api\/admin\/surveys\/(\d+)\/responses\/(\d+)\/report-publication\/retry$/,
  );
  if (request.method === "POST" && retryPublicationMatch) {
    const surveyId = Number(retryPublicationMatch[1]);
    const responseId = Number(retryPublicationMatch[2]);
    const survey = await getSurveyById(db, surveyId);
    if (!survey) return fail(404, "not_found", "问卷不存在");
    // 归属校验：只有问卷作者或系统管理员能重投（别人的答卷不该被第三方推进频道）。
    if (!isAdmin && survey.ownerId !== user.id) {
      return fail(403, "forbidden", "无权操作该答卷的发布");
    }
    const response = await getResponseById(db, responseId);
    if (!response || response.surveyId !== surveyId) return fail(404, "response_not_found", "答卷不存在");
    if (response.status !== "completed") {
      return fail(400, "response_not_completed", "答卷尚未完成，无法发布");
    }
    if (response.reportPublicationStatus === "published") {
      // 幂等：已发布的不再重发，否则频道里会出现第二份同样的相册。
      return json({ ok: true, status: "published", alreadyPublished: true });
    }
    if (!response.reportPublicationRequested) {
      return fail(400, "publication_not_requested", "这份答卷没有勾选公开发布");
    }

    const now = new Date().toISOString();
    // 清掉上一轮的锁并把状态推回 pending，让队列重新捡起这份答卷。
    // 清锁必须是**条件的**：只清「无锁或已过期」的锁。无条件清（原实现）会在
    // 一个消费者正常发布的中途把它的锁抹掉——第二个发布进程随即抢锁并发发送，
    // 同一份相册进频道两次。锁活跃时明确回 409，让管理员稍后再来。
    try {
      const staleBefore = new Date(Date.now() - PUBLICATION_CLAIM_STALE_MS).toISOString();
      const cleared = await db
        .prepare(
          `UPDATE survey_responses
              SET report_publication_status='pending', report_publication_claim_at=NULL, updated_at=?
            WHERE id=? AND (report_publication_claim_at IS NULL OR report_publication_claim_at < ?)`,
        )
        .bind(now, responseId, staleBefore)
        .run();
      if (Number(cleared.meta?.changes ?? 0) === 0) {
        return fail(
          409,
          "publishing_in_progress",
          "正在发布中：另一个发布进程持有锁（最长 5 分钟自动过期），请稍后再试",
        );
      }
    } catch (error) {
      // 老库没有 0093 的锁列：只重置状态，续发退化为整份重发（与发布链路一致）。
      if (!/no such column/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await db
        .prepare("UPDATE survey_responses SET report_publication_status='pending', updated_at=? WHERE id=?")
        .bind(now, responseId)
        .run();
    }

    try {
      await createExportJobSender(env).send({ kind: "public_report", responseId });
    } catch (error) {
      await db
        .prepare("UPDATE survey_responses SET report_publication_status='failed', updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), responseId)
        .run();
      console.error("Public report re-enqueue failed", { responseId, error });
      return fail(503, "enqueue_failed", "重投失败，请稍后再试");
    }

    await writeAudit(db, {
      actorUserId: user.id,
      action: "report.publication.retry",
      entityType: "survey_response",
      entityId: String(responseId),
      after: { responseId, surveyId, status: "pending" },
    });
    return json({ ok: true, status: "pending" });
  }

  return null;
}
