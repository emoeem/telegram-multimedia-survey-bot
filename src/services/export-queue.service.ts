import { createExportJob } from "../db/repositories/export.repository";
import { getUserById } from "../db/repositories/user.repository";
import type { BotContext } from "../bot/types";
import type { ExportJobSender } from "./export-job-sender";

export type SurveyExportFormat = "csv" | "zip";

export interface SurveyExportJobMessage {
  jobId: number;
  surveyId: number;
  chatId: number;
  format: SurveyExportFormat;
}

export async function enqueueExportJob(
  ctx: BotContext,
  input: {
    surveyId: number;
    userId: number | null;
    chatId: number;
    format: SurveyExportFormat;
  },
): Promise<number> {
  const job = await createExportJob(ctx.db, {
    surveyId: input.surveyId,
    requestedBy: input.userId,
    format: input.format,
  });

  const message: SurveyExportJobMessage = {
    jobId: job.id,
    surveyId: input.surveyId,
    chatId: input.chatId,
    format: input.format,
  };
  await ctx.exportQueue.send(message);

  return job.id;
}

export type ExportJobRetryResult =
  | { outcome: "requeued"; status: "pending" }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; status: string }
  | { outcome: "target_unresolvable" };

/**
 * 人工重试一条 failed 的导出任务(控制台 POST /api/control/jobs/export/:id/retry,
 * 通宵批次 B6;export_jobs 没有恢复扫描,failed 此前是死状态)。与入队共用
 * SurveyExportJobMessage 消息形状,消费者(export-worker)原样处理,不新造调度。
 *
 * 投递目标:export_jobs 不存 chat_id(它只随队列消息走),人工重试从
 * requested_by 解析请求人的 Telegram 私聊(users.telegram_user_id)。原入队若
 * 来自群聊,重试生成的文件会落到请求人的私聊——如实取舍:重试的意义是把没
 * 送出去的文件送出来。请求人不存在(未登录过/已删)时拒绝重试,不猜目标。
 *
 * 幂等:条件 UPDATE 抢占(WHERE status='failed'),两个并发重试只有一个赢;
 * 输家与后到的重复调用不重复投递、不产生重复文件。attempts 口径本表没有。
 */
export async function retryFailedExportJob(
  db: D1Database,
  sender: ExportJobSender,
  id: number,
): Promise<ExportJobRetryResult> {
  const job = await db
    .prepare("SELECT id, survey_id, format, requested_by, status FROM export_jobs WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ id: number; survey_id: number; format: string; requested_by: number | null; status: string }>();
  if (!job) return { outcome: "not_found" };
  if (job.status !== "failed") return { outcome: "not_retryable", status: job.status };
  if (job.requested_by === null) return { outcome: "target_unresolvable" };
  const requester = await getUserById(db, job.requested_by);
  if (!requester) return { outcome: "target_unresolvable" };
  // 重置口径与消费者可重试失败的回退(export-worker: status='pending',
  // errorMessage=null)一致:清错误与终态时间;failed 行的 r2_key 本就为空
  // (失败路径都经 updateExportJob 清过),一并置 NULL 防御旧数据。
  const update = await db
    .prepare(
      `UPDATE export_jobs
       SET status = 'pending', r2_key = NULL, error_message = NULL, completed_at = NULL
       WHERE id = ? AND status = 'failed'`,
    )
    .bind(id)
    .run();
  if (!update.meta?.changes) return { outcome: "not_retryable", status: "pending" };
  await sender.send({
    jobId: job.id,
    surveyId: job.survey_id,
    chatId: requester.telegramUserId,
    format: job.format as SurveyExportFormat,
  } satisfies SurveyExportJobMessage);
  return { outcome: "requeued", status: "pending" };
}
